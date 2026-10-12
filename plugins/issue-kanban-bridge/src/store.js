import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createIssue, transition, reportProgress, reorderTodo, workQueue, closedIssues, numberIssues, matchesIssue, requireAssignee, validateManager } from './workflow.js';

// Each writer refreshes, locks and rejects stale disk revisions; no silent overwrite.
export class BoardStore {
  constructor(path, clock = Date.now) {
    this.path = path;
    this.clock = clock;
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schemaVersion: 1, revision: 0, issues: [], todoOrder: [] };
    if (this.state.schemaVersion !== 1) throw new Error('Unsupported store schema');
    const numbered = numberIssues(this.state);
    if (JSON.stringify(numbered) !== JSON.stringify(this.state)) this.save(numbered);
  }
  refresh() {
    if (existsSync(this.path)) this.state = JSON.parse(readFileSync(this.path, 'utf8'));
    this.state = numberIssues(this.state);
    return this.state;
  }
  save(state) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    let handle;
    try { handle = openSync(lock, 'wx', 0o600); }
    catch { throw new Error('Board busy; refresh and retry. If a crashed process left a lock, confirm no server is running before removing it.'); }
    try {
      const disk = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { revision: 0 };
      if (disk.revision !== this.state.revision) throw new Error('Board version conflict; refresh and retry');
    const next = { ...state, revision: this.state.revision + 1 };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
    this.state = next;
    } finally { closeSync(handle); unlinkSync(lock); }
  }
  archive() {
    this.refresh();
    const now = this.clock();
    let changed = false;
    const issues = this.state.issues.map(issue => {
      if (issue.status !== 'Done' || now - Date.parse(issue.doneAt) < 604800000) return issue;
      changed = true;
      return transition(issue, { to: 'Closed', actor: 'system', expectedVersion: issue.version }, now);
    });
    if (changed) this.save({ ...this.state, issues });
  }
  board(query = '') {
    this.archive();
    return structuredClone({ ...this.state, closed: closedIssues(this.state.issues, query), queue: workQueue(this.state.issues, this.state.todoOrder), sync: { mode: 'explicit-tool-updates', activityImportVerified: false } });
  }
  create(args) {
    this.refresh();
    const duplicate = args.sourceId && this.state.issues.find(issue => issue.sourceId === args.sourceId && issue.kind === (args.kind || 'request'));
    if (duplicate) return structuredClone(duplicate);
    const issue = { ...createIssue({ ...args, id: randomUUID() }, this.clock()), number: this.state.nextIssueNumber };
    this.save({ ...this.state, issues: [...this.state.issues, issue], nextIssueNumber: this.state.nextIssueNumber + 1, todoOrder: issue.kind === 'request' ? [...this.state.todoOrder, issue.id] : this.state.todoOrder });
    return structuredClone(issue);
  }
  update(id, fn) {
    this.refresh();
    const index = this.state.issues.findIndex(issue => matchesIssue(issue, id));
    if (index < 0) throw new Error('Issue not found');
    const issue = fn(this.state.issues[index]);
    const issues = [...this.state.issues];
    issues[index] = issue;
    const todo = issues.filter(i => i.kind === 'request' && i.status === 'ToDo').map(i => i.id);
    const todoOrder = [...this.state.todoOrder.filter(i => todo.includes(i)), ...todo.filter(i => !this.state.todoOrder.includes(i))];
    this.save({ ...this.state, issues, todoOrder });
    return structuredClone(issue);
  }
  register(args) {
    const state = this.refresh();
    const existing = state.issues.find(issue => issue.sourceId === args.sourceId);
    const registration = { description: args.description, projectPath: args.projectPath || null, sourceUrl: args.sourceUrl || null, ...(args.sourceSessionId ? { sourceSessionId: args.sourceSessionId } : {}) };
    if (existing) {
      if (existing.title !== args.title || JSON.stringify(existing.registration) !== JSON.stringify(registration)) throw new Error('sourceId already used for different contents');
      return existing;
    }
    const now = this.clock();
    const created = { ...createIssue({ id: crypto.randomUUID(), title: args.title, sourceId: args.sourceId, activityUrl: args.sourceUrl }, now), number: state.nextIssueNumber };
    const issue = { ...reportProgress(created, { expectedVersion: 1, text: `${args.description}${args.projectPath ? `\n作業場所: ${args.projectPath}` : ''}`, sourceRef: args.sourceId, links: args.sourceUrl ? [{ url: args.sourceUrl, label: '依頼元' }] : [] }, now), registration };
    this.save( { ...state, issues: [...state.issues, issue], nextIssueNumber: state.nextIssueNumber + 1, todoOrder: [...state.todoOrder, issue.id] });
    return issue;
  }
  completeClaude(args) {
    return this.update(args.id, issue => {
      if (!issue.sourceId?.startsWith('claude-code:') || !issue.registration?.sourceSessionId) throw new Error('Claude Code origin session required');
      if (issue.completion) {
        if (issue.completion.reportId !== args.reportId || issue.completion.text !== args.text || issue.completion.sourceRef !== args.sourceRef || JSON.stringify(issue.completion.links) !== JSON.stringify(args.links || [])) throw new Error('Completion already recorded with different contents');
        return issue;
      }
      if (!['InProgress', 'Review'].includes(issue.status)) throw new Error('Only finished InProgress or Review work can complete; Release is not authorized');
      const now = this.clock();
      const progressed = reportProgress(issue, { expectedVersion: args.expectedVersion, text: args.text, sourceRef: args.sourceRef, links: args.links || [], assignee: args.assignee }, now);
      requireAssignee(progressed);
      const manager = args.manager ? validateManager(args.manager) : null;
      const at = new Date(now).toISOString();
      // This exception is specific to registered Claude requests. It authorizes no release.
      return { ...progressed, status: 'Done', doneAt: at, version: progressed.version + 1,
        completion: { reportId: args.reportId, text: args.text, sourceRef: args.sourceRef, links: args.links || [], sourceSessionId: issue.registration.sourceSessionId, at },
        history: [...progressed.history, { type: 'transition', from: issue.status, to: 'Done', actor: 'manager', ...(manager ? { manager } : {}), at, reason: 'Claude Code caller reviews result; no release authorization', reportId: args.reportId }] };
    });
  }
  move(args) { return this.update(args.id, issue => { if (args.to === 'Done' && issue.sourceId?.startsWith('claude-code:') && issue.registration?.sourceSessionId) throw new Error('Use kanban_complete_claude to save the origin-session report before Done'); return transition(issue, args, this.clock()); }); }
  progress(args) { return this.update(args.id, issue => reportProgress(issue, args, this.clock())); }
  reorder({ ids, expectedRevision }) {
    this.archive();
    if (expectedRevision !== this.state.revision) throw new Error('Board version conflict; refresh and retry');
    this.save({ ...this.state, todoOrder: reorderTodo(this.state.issues, ids) });
  }
}
