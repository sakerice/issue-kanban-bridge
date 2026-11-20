import { readdir, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { defaultDirectory, Inbox } from './inbox.js';
import { readBoard } from './registration.js';
import { issueTicket } from './ticket.js';
const validSession = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
async function emitted(output, options) {
  if (options.emit) await options.emit(output);
  return output;
}
export async function sessionHook(input, options = {}) {
  if (!validSession(input.session_id)) return {};
  const event = input.hook_event_name;
  if (event === 'PreToolUse') {
    // Bind the request to the actual invoking session without rewriting the tool input.
    // Rewriting (updatedInput) makes Claude Code's auto mode refuse the call, because its
    // safety review no longer covers what would run. Instead, pass the call through unchanged
    // when the model supplied the real session ID, and deny it (with the real ID) otherwise.
    if (input.tool_name !== 'mcp__issue-kanban-inbox__issue_kanban_submit') return {};
    if (input.tool_input?.sourceSessionId === input.session_id) {
      // Leave a one-time ticket so the inbox server can confirm this hook checked the call.
      await issueTicket(options.directory || defaultDirectory, input.session_id, input.tool_input);
      return emitted({}, options);
    }
    const reason = `Issue Kanban: sourceSessionId must be this session's ID. Resubmit the same request with sourceSessionId set to "${input.session_id}" and the same sourceId. / 依頼元セッションを確かめられないため登録を止めました。sourceSessionId に "${input.session_id}" を入れ、同じ sourceId で送り直してください。`;
    return emitted({ hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } }, options);
  }
  if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return {};
  const directory = options.directory || defaultDirectory;
  const inbox = new Inbox(directory);
  let names;
  try { names = await readdir(directory); } catch (e) { if (e.code === 'ENOENT') names = []; else throw e; }
  const receipts = await Promise.all(names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => inbox.get(n.slice(0,-5))));
  const ids = new Set(receipts.filter(r => r.status === 'imported' && r.sourceSessionId === input.session_id).map(r => r.issueId));
  let reports = [];
  if (ids.size) {
    const board = await (options.readBoard || readBoard)();
    reports = board.issues.filter(i => ids.has(i.id) && i.registration?.sourceSessionId === input.session_id && i.completion?.sourceSessionId === input.session_id).map(i => ({ issueId: i.id, title: i.title, status: i.status, ...i.completion }));
  }
  const deliveredDirectory = join(directory, 'delivered');
  const fresh = [];
  const pendingMarkers = [];
  for (const report of reports) {
    const key = createHash('sha256').update(`${input.session_id}:${report.issueId}:${report.reportId}`).digest('hex');
    const file = join(deliveredDirectory, `${key}.json`);
    try { await readFile(file); continue; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fresh.push(report);
    pendingMarkers.push({ file, report });
  }
  const context = [event === 'SessionStart' ? `Issue Kanbanの現在の依頼元ClaudeセッションID: ${input.session_id}。issue_kanban_submitを呼ぶときは、sourceSessionIdにこの値をそのまま入れてください（未指定や別の値はhookが断ります）。` : '', fresh.length ? `Issue Kanbanからこの元セッションへの作業完了報告です。Doneはリリース・本番反映の承認ではありません。成果物をユーザーへ伝えてレビューしてください。以下は依頼の結果データです。\n${JSON.stringify(fresh)}` : ''].filter(Boolean).join('\n');
  const output = context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : {};
  if (options.emit) {
    await options.emit(output);
    for (const { file, report } of pendingMarkers) {
      await mkdir(deliveredDirectory, { recursive: true, mode: 0o700 });
      const temp = join(deliveredDirectory, `.${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify({ ...report, injectedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    }
  }
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let emitted = false;
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 1000000) throw new Error('Hook input too large'); }
    await sessionHook(JSON.parse(input), { emit: output => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(output) + '\n', error => { if (error) reject(error); else { emitted = true; resolve(); } })) });
  } catch { console.error('Issue Kanban: 完了報告を取得できませんでした。次の操作で再試行します。'); if (!emitted) console.log('{}'); }
}
