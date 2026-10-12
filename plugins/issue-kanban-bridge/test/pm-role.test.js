import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createIssue, transition, normalizeActor } from '../src/workflow.js';
import { httpConfig } from '../src/paths.js';
import { BoardStore } from '../src/store.js';

const start = Date.parse('2026-10-08T00:00:00Z');
const worker = { environment: 'local', name: 'Codex test', sourceRef: 'test:worker' };
const make = id => createIssue({ id, title: id, activityUrl: 'codex://threads/test-activity' }, start);
const root = fileURLToPath(new URL('../', import.meta.url));

test('manager is the PM actor; dot is a legacy alias recorded as manager', () => {
  assert.equal(normalizeActor('dot'), 'manager');
  assert.equal(normalizeActor('manager'), 'manager');
  assert.throws(() => normalizeActor('codex'), /Invalid actor/);
  const pm = { environment: 'local', name: 'Claude Code' };
  const byManager = transition(make('m'), { to: 'InProgress', actor: 'manager', manager: pm, assignee: worker, expectedVersion: 1 }, start);
  assert.deepEqual(byManager.history.at(-1).actor, 'manager');
  assert.deepEqual(byManager.history.at(-1).manager, pm);
  const byDot = transition(make('d'), { to: 'InProgress', actor: 'dot', assignee: worker, expectedVersion: 1 }, start);
  assert.equal(byDot.history.at(-1).actor, 'manager');
  assert.deepEqual(byDot.history.at(-1).manager, { environment: 'dot', name: 'Dot' });
  const anonymous = transition(make('a'), { to: 'InProgress', actor: 'manager', assignee: worker, expectedVersion: 1 }, start);
  assert.equal(anonymous.history.at(-1).manager, undefined);
  assert.throws(() => transition(make('u'), { to: 'InProgress', actor: 'user', assignee: worker, expectedVersion: 1 }, start), /manager \(PM role\)/);
  assert.throws(() => transition(make('x'), { to: 'InProgress', actor: 'manager', manager: { environment: 'moon', name: 'PM' }, assignee: worker, expectedVersion: 1 }, start), /PM役/);
  assert.throws(() => transition(make('y'), { to: 'Closed', actor: 'user', manager: { environment: 'local', name: 'PM' }, evidence: { intent: 'cancel', sourceRef: 'm:1', quote: 'キャンセル' }, expectedVersion: 1 }, start), /manager/);
});

test('a board whose history was written with actor dot still loads and continues', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-legacy-'));
  try {
    const path = join(dir, 'board.json');
    const at = new Date(start).toISOString();
    const legacy = { ...make('legacy'), number: 1, status: 'InProgress', version: 3, assignee: { environment: 'local', name: 'Codex', sourceRef: 'test:legacy' },
      history: [{ type: 'created', at, status: 'ToDo' }, { type: 'assignment', from: null, to: { environment: 'local', name: 'Codex', sourceRef: 'test:legacy' }, at }, { type: 'transition', from: 'ToDo', to: 'InProgress', actor: 'dot', evidence: null, releaseResult: null, at }] };
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, revision: 4, issues: [legacy], todoOrder: [], nextIssueNumber: 2 }));
    const store = new BoardStore(path);
    assert.equal(store.board().issues[0].history[2].actor, 'dot');
    const review = store.move({ id: '#1', expectedVersion: 3, to: 'Review', actor: 'manager', manager: { environment: 'dot', name: 'Dot' } });
    assert.equal(review.status, 'Review');
    assert.deepEqual(review.history.map(h => h.actor).filter(Boolean), ['dot', 'manager']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ISSUE_KANBAN_* environment variables win; DOTS_KANBAN_* remain as fallback', () => {
  assert.deepEqual(httpConfig({}), { token: '', host: '127.0.0.1', port: 8798 });
  assert.deepEqual(httpConfig({ DOTS_KANBAN_HOST: '0.0.0.0', DOTS_KANBAN_TOKEN: 'legacy-token' }), { token: 'legacy-token', host: '0.0.0.0', port: 8798 });
  assert.deepEqual(httpConfig({ ISSUE_KANBAN_HOST: '0.0.0.0', ISSUE_KANBAN_TOKEN: 'new-token', DOTS_KANBAN_HOST: '192.0.2.1', DOTS_KANBAN_TOKEN: 'legacy-token', PORT: '9000' }), { token: 'new-token', host: '0.0.0.0', port: 9000 });
  assert.throws(() => httpConfig({ ISSUE_KANBAN_HOST: '0.0.0.0' }), /ISSUE_KANBAN_TOKEN/);
  // Data path: the canonical variable is read by the stdio server.
  const dir = mkdtempSync(join(tmpdir(), 'kanban-env-'));
  try {
    const path = join(dir, 'legacy.json');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { dataPath } from ${JSON.stringify(join(root, 'src/paths.js'))}; console.log(dataPath);`], { env: { ...process.env, ISSUE_KANBAN_DATA: '', DOTS_KANBAN_DATA: path }, encoding: 'utf8' });
    assert.equal(result.stdout.trim(), path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('claude-config --with-board adds the board server for a single PM-and-worker session', () => {
  const plain = JSON.parse(spawnSync(process.execPath, [join(root, 'scripts/claude-config.js')], { encoding: 'utf8' }).stdout);
  assert.deepEqual(Object.keys(plain.mcpServers), ['issue-kanban-inbox']);
  const withBoard = JSON.parse(spawnSync(process.execPath, [join(root, 'scripts/claude-config.js'), '--with-board'], { encoding: 'utf8' }).stdout);
  assert.deepEqual(withBoard.mcpServers['issue-kanban'].args, [join(root, 'src/server.js'), '--stdio']);
});

test('one session acting as PM and worker: next → claim → progress → Review, then the user approves Done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-solo-'));
  const client = new Client({ name: 'solo-session-test', version: '1.0.0' });
  const self = { environment: 'local', name: 'Claude Code', sourceRef: 'test:this-session' };
  const pm = { environment: 'local', name: 'Claude Code' };
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.equal(r.isError, undefined, r.content?.[0]?.text); return r; };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/server.js'), '--stdio'], env: { ...process.env, ISSUE_KANBAN_DATA: join(dir, 'board.json') }, stderr: 'pipe' }));
    await call('kanban_create', { title: 'Solo task', sourceId: 'test:solo' });
    const next = JSON.parse((await call('kanban_next', {})).content[0].text).queue;
    assert.equal(next[0].title, 'Solo task');
    let issue = next[0];
    issue = (await call('kanban_transition', { id: issue.id, expectedVersion: issue.version, to: 'InProgress', actor: 'manager', manager: pm, assignee: self })).structuredContent.board.issues[0];
    assert.deepEqual(issue.assignee, self);
    issue = (await call('kanban_progress', { id: issue.id, expectedVersion: issue.version, text: '実装と検証を完了', sourceRef: 'test:progress', links: [{ url: 'https://example.com/result', label: '成果物' }] })).structuredContent.board.issues[0];
    issue = (await call('kanban_transition', { id: issue.id, expectedVersion: issue.version, to: 'Review', actor: 'manager', manager: pm })).structuredContent.board.issues[0];
    assert.equal(issue.status, 'Review');
    // The session cannot approve its own work.
    const selfApproved = await client.callTool({ name: 'kanban_transition', arguments: { id: issue.id, expectedVersion: issue.version, to: 'Done', actor: 'manager', manager: pm } });
    assert.equal(selfApproved.isError, true);
    issue = (await call('kanban_transition', { id: issue.id, expectedVersion: issue.version, to: 'Done', actor: 'user', evidence: { intent: 'approve', sourceRef: 'test:user-message', quote: 'これで完了にしてください' } })).structuredContent.board.issues[0];
    assert.equal(issue.status, 'Done');
    const transitions = issue.history.filter(h => h.type === 'transition');
    assert.deepEqual(transitions.map(h => [h.to, h.actor, h.manager?.name ?? null]), [['InProgress', 'manager', 'Claude Code'], ['Review', 'manager', 'Claude Code'], ['Done', 'user', null]]);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('kanban_complete_claude records the PM as manager, not as Dot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-complete-'));
  try {
    const store = new BoardStore(join(dir, 'board.json'));
    let issue = store.register({ title: 'Claude task', description: 'Synthetic', sourceId: 'claude-code:pm', sourceSessionId: '11111111-1111-4111-8111-111111111111' });
    issue = store.move({ id: issue.id, expectedVersion: issue.version, to: 'InProgress', actor: 'manager', assignee: worker });
    issue = store.completeClaude({ id: issue.id, expectedVersion: issue.version, reportId: 'r', text: 'Finished', sourceRef: 'test:r', links: [], manager: { environment: 'local', name: 'Codex' } });
    assert.equal(issue.history.at(-1).actor, 'manager');
    assert.deepEqual(issue.history.at(-1).manager, { environment: 'local', name: 'Codex' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
