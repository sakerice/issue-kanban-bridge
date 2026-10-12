export const STATUSES = ['ToDo', 'Plan', 'InProgress', 'Review', 'Release', 'Done', 'Closed'];
const WEEK = 7 * 24 * 60 * 60 * 1000;
const NEXT = { ToDo: ['Plan', 'InProgress'], Plan: ['ToDo', 'InProgress'], InProgress: ['Review'], Review: ['ToDo', 'Done', 'Release'], Release: ['Done'], Done: ['Closed'], Closed: [] };

function iso(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid time');
  return date.toISOString();
}

export function createIssue({ id, title, kind = 'request', activityUrl, sourceId }, now = Date.now()) {
  if (!id || !title?.trim()) throw new Error('Issue ID and title are required');
  if (!['request', 'scheduled-run'].includes(kind)) throw new Error('Invalid issue kind');
  const at = iso(now);
  return { id, title: title.trim(), kind, activityUrl: activityUrl || null, sourceId: sourceId || null, status: 'ToDo', version: 1, createdAt: at, updatedAt: at, doneAt: null, closedReason: null, links: [], history: [{ type: 'created', at, status: 'ToDo' }] };
}

const ENVIRONMENTS = ['local', 'codex-cloud', 'dot', 'other'];
// The PM role (selects, plans, assigns, advances and records work) is a role, not a product:
// Dot, or one Codex / Claude Code session acting as both PM and worker. 'dot' is accepted as a
// legacy alias of 'manager'; boards whose history already contains actor 'dot' stay readable.
export const ACTORS = ['user', 'manager', 'dot', 'system'];
export function normalizeActor(actor) {
  if (!ACTORS.includes(actor)) throw new Error('Invalid actor');
  return actor === 'dot' ? 'manager' : actor;
}
// Who is acting as PM, e.g. { environment: 'dot', name: 'Dot' } or { environment: 'local', name: 'Claude Code' }.
export function validateManager(manager) {
  if (!manager || !ENVIRONMENTS.includes(manager.environment) || typeof manager.name !== 'string' || !manager.name.trim()) throw new Error('PM役（manager）にはenvironmentとnameを指定してください');
  return { environment: manager.environment, name: manager.name.trim() };
}
function managerFor(actor, manager) {
  if (manager) return validateManager(manager);
  // The legacy alias names the PM explicitly; keep that fact instead of losing it in normalization.
  return actor === 'dot' ? { environment: 'dot', name: 'Dot' } : null;
}

// Evidence must be supplied by the host adapter from a real user message or UI action.
// This module validates the workflow; it is not an authentication boundary.
export function transition(issue, { to, actor: requestedActor, manager: requestedManager, evidence, releaseResult, expectedVersion, assignee }, now = Date.now()) {
  if (expectedVersion !== issue.version) throw new Error('Version conflict');
  const actor = normalizeActor(requestedActor);
  if (requestedManager && actor !== 'manager') throw new Error('managerはactorがmanager（PM役）のときだけ指定できます');
  const manager = actor === 'manager' ? managerFor(requestedActor, requestedManager) : null;
  if (!STATUSES.includes(to)) throw new Error('Invalid status');
  const scheduledCompletion = issue.kind === 'scheduled-run' && ['InProgress', 'Review'].includes(issue.status) && to === 'Done';
  if (issue.kind === 'scheduled-run' && ['Review', 'Release'].includes(to)) throw new Error('定期実行ログはReview/Releaseを使いません。実行完了後はDoneへ移してください。');
  const cancel = to === 'Closed' && evidence?.intent === 'cancel' && actor !== 'system';
  if (!cancel && !scheduledCompletion && !NEXT[issue.status]?.includes(to)) throw new Error('Invalid transition');
  if (cancel && ['Done', 'Closed'].includes(issue.status)) throw new Error('Cannot cancel completed work');
  if (scheduledCompletion && (actor !== 'manager' || !issue.history.some(h => h.type === 'progress' && h.text?.trim() && h.sourceRef))) throw new Error('定期実行の完了結果を先に記録してください（actorはmanager）');
  const userDecision = cancel || (issue.status === 'Review' && !scheduledCompletion);
  if (userDecision) {
    const intent = cancel ? 'cancel' : { ToDo: 'return', Done: 'approve', Release: 'release' }[to];
    if (evidence?.intent !== intent || !evidence?.sourceRef || !evidence?.quote?.trim()) throw new Error('Explicit user decision required');
  }
  if (['Plan', 'InProgress', 'Review'].includes(to) && actor !== 'manager') throw new Error('Only the manager (PM role) advances work');
  if (assignee) issue = assignAgent(issue, assignee, now);
  if (['Plan', 'InProgress', 'Review', 'Release', 'Done'].includes(to)) requireAssignee(issue);
  if (to === 'Review') requireReviewLink(issue);
  if (issue.status === 'Release' && to === 'Done') {
    if (actor !== 'manager' || releaseResult?.verified !== true || !releaseResult?.sourceRef) throw new Error('Verified production release required');
  }
  if (issue.status === 'Done' && to === 'Closed') {
    if (actor !== 'system' || new Date(now).getTime() - new Date(issue.doneAt).getTime() < WEEK) throw new Error('Archive only after seven days in Done');
  }
  if (actor === 'system' && !(issue.status === 'Done' && to === 'Closed')) throw new Error('System can only archive');
  const at = iso(now);
  return { ...issue, status: to, version: issue.version + 1, updatedAt: at, doneAt: to === 'Done' ? at : issue.doneAt, closedReason: to === 'Closed' ? (cancel ? 'cancelled' : 'aged-out') : null, history: [...issue.history, { type: 'transition', from: issue.status, to, actor, ...(manager ? { manager } : {}), evidence: evidence || null, releaseResult: releaseResult || null, at }] };
}

export function reportProgress(issue, { text, sourceRef, links = [], expectedVersion, assignee }, now = Date.now()) {
  if (expectedVersion !== issue.version) throw new Error('Version conflict');
  if (!text?.trim() || !sourceRef) throw new Error('Progress and source reference required');
  for (const link of links) {
    const url = new URL(link.url);
    if (!['https:', 'http:', 'codex:'].includes(url.protocol)) throw new Error('Unsupported link protocol');
  }
  if (assignee) issue = assignAgent(issue, assignee, now);
  const at = iso(now);
  const unique = new Map([...issue.links, ...links].map(link => [link.url, link]));
  return { ...issue, version: issue.version + 1, updatedAt: at, links: [...unique.values()], history: [...issue.history, { type: 'progress', text, sourceRef, links, at }] };
}

export function reorderTodo(issues, ids) {
  const todo = issues.filter(issue => issue.kind === 'request' && issue.status === 'ToDo');
  if (new Set(ids).size !== ids.length || ids.length !== todo.length || todo.some(issue => !ids.includes(issue.id))) throw new Error('Order must include every ToDo exactly once');
  return [...ids];
}

export function workQueue(issues, todoOrder = []) {
  const rank = { Release: 0, InProgress: 1, Plan: 2, ToDo: 3 };
  const positions = new Map(todoOrder.map((id, index) => [id, index]));
  return issues.filter(issue => issue.kind === 'request' && issue.status in rank).sort((a, b) => rank[a.status] - rank[b.status] || (a.status === 'ToDo' ? (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity) : 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function closedIssues(issues, query = '') {
  const term = query.trim().toLocaleLowerCase();
  return issues.filter(issue => issue.status === 'Closed' && JSON.stringify([issue.id, String(issue.number), `#${issue.number}`, issue.title, issue.history, issue.links]).toLocaleLowerCase().includes(term)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

// Persisted display numbers are independent of UUIDs, sorting and status changes.
export function numberIssues(state) {
  const seen = new Set();
  let next = Math.max(Number.isSafeInteger(state.nextIssueNumber) ? state.nextIssueNumber : 1, 1, ...state.issues.map(i => Number.isSafeInteger(i.number) && i.number > 0 ? i.number + 1 : 1));
  const issues = state.issues.map(issue => {
    if (Number.isSafeInteger(issue.number) && issue.number > 0 && !seen.has(issue.number)) { seen.add(issue.number); return issue; }
    const numbered = { ...issue, number: next++ }; seen.add(numbered.number); return numbered;
  });
  return { ...state, issues, nextIssueNumber: next };
}
export function matchesIssue(issue, id) {
  return issue.id === id || String(issue.number) === String(id).replace(/^#/, '');
}

export function hasReviewLink(issue) {
  return [issue.activityUrl, ...(issue.links || []).map(link => link.url)].some(value => {
    if (typeof value !== 'string') return false;
    try { const url = new URL(value); return ['https:', 'http:', 'codex:'].includes(url.protocol); } catch { return false; }
  });
}
export function requireReviewLink(issue) {
  if (!hasReviewLink(issue)) throw new Error('ReviewにはActivityリンクまたは成果物リンクが最低1つ必要です。実際のリンクをkanban_progressのlinksへ保存してから再試行してください。');
}

export function validateAssignee(assignee) {
  if (!assignee || !ENVIRONMENTS.includes(assignee.environment) || !assignee.name?.trim() || !assignee.sourceRef?.trim()) throw new Error('担当エージェント名・実行場所・確認元を指定してください');
  if (assignee.sessionUrl) {
    let url; try { url = new URL(assignee.sessionUrl); } catch { throw new Error('Invalid assignee session URL'); }
    if (!['https:', 'http:', 'codex:'].includes(url.protocol)) throw new Error('Invalid assignee session URL');
  }
  return { environment: assignee.environment, name: assignee.name.trim(), sourceRef: assignee.sourceRef.trim(), ...(assignee.sessionUrl ? { sessionUrl: assignee.sessionUrl } : {}) };
}
export function requireAssignee(issue) {
  try { validateAssignee(issue.assignee); } catch { throw new Error('Plan以降は担当エージェントと実行場所の明示が必要です。assigneeにenvironment・name・sourceRefを指定してください。'); }
}
function assignAgent(issue, assignee, now) {
  const next = validateAssignee(assignee);
  if (JSON.stringify(issue.assignee) === JSON.stringify(next)) return issue;
  return { ...issue, assignee: next, history: [...issue.history, { type: 'assignment', from: issue.assignee || null, to: next, at: iso(now) }] };
}
