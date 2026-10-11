import test from 'node:test';
import assert from 'node:assert/strict';
import { createIssue, transition, reportProgress, workQueue, reorderTodo, closedIssues } from '../src/workflow.js';
const start = Date.parse('2026-10-08T00:00:00Z');
const make = id => createIssue({ id, title: id, activityUrl: 'codex://threads/test-activity' }, start);
const move = (issue, to, extras = {}, now = start) => transition(issue, { to, actor: 'dot', assignee: { environment: 'local', name: 'Codex test', sourceRef: 'test:execution-context', sessionUrl: 'codex://threads/test-worker' }, expectedVersion: issue.version, ...extras }, now);
const decision = intent => ({ intent, sourceRef: 'message:123', quote: 'このタスクについての明示的な指示' });
const review = () => move(move(make('a'), 'InProgress'), 'Review');

test('complex requests consult in Plan before implementation; simple requests can skip it', () => {
  const plan = move(make('complex'), 'Plan');
  assert.equal(plan.status, 'Plan');
  const discussed = reportProgress(plan, { text: '段取りと設計を相談中', sourceRef: 'message:plan', expectedVersion: plan.version });
  assert.equal(discussed.status, 'Plan');
  assert.equal(move(discussed, 'InProgress').status, 'InProgress');
  assert.equal(move(plan, 'ToDo').status, 'ToDo');
  assert.equal(move(plan, 'Closed', { evidence: decision('cancel') }).closedReason, 'cancelled');
  assert.throws(() => move(plan, 'Review'), /transition/);
  assert.throws(() => move(make('complex'), 'Plan', { actor: 'user' }), /advances/);
  assert.equal(move(make('simple'), 'InProgress').status, 'InProgress');
});

test('review requires explicit approval; a casual OK cannot finish work', () => {
  const issue = review();
  assert.throws(() => move(issue, 'Done'), /decision/);
  assert.throws(() => move(issue, 'Done', { evidence: decision('comment') }), /decision/);
  assert.equal(move(issue, 'Done', { evidence: decision('approve') }).status, 'Done');
  assert.equal(move(issue, 'ToDo', { evidence: decision('return') }).status, 'ToDo');
});
test('release requires user instruction and verified production outcome', () => {
  const issue = move(review(), 'Release', { evidence: decision('release') });
  assert.throws(() => move(issue, 'Done'), /production/);
  assert.equal(move(issue, 'Done', { releaseResult: { verified: true, sourceRef: 'deployment:456' } }).status, 'Done');
});
test('archive measures Done residence, independent of progress edits', () => {
  let issue = move(review(), 'Done', { evidence: decision('approve') });
  issue = reportProgress(issue, { text: '成果物リンク追加', sourceRef: 'message:124', expectedVersion: issue.version }, start + 6 * 86400000);
  assert.throws(() => move(issue, 'Closed', { actor: 'system' }, start + 7 * 86400000 - 1), /seven days/);
  assert.equal(move(issue, 'Closed', { actor: 'system' }, start + 7 * 86400000).closedReason, 'aged-out');
});
test('cancellation retains searchable history and rejects stale updates', () => {
  const issue = move(make('cancel'), 'Closed', { evidence: decision('cancel') });
  assert.equal(closedIssues([issue], '明示的').length, 1);
  assert.equal(issue.closedReason, 'cancelled');
  assert.throws(() => transition(issue, { to: 'ToDo', actor: 'dot', expectedVersion: 1 }), /conflict/);
});
test('Release > InProgress > user ordered ToDo; scheduled logs stay separate', () => {
  const release = move(review(), 'Release', { evidence: decision('release') });
  const running = move(make('running'), 'InProgress');
  const issues = [make('first'), running, move(make('planning'), 'Plan'), make('second'), release, createIssue({ id: 'scheduled', title: 'log', kind: 'scheduled-run' }, start)];
  const order = reorderTodo(issues, ['second', 'first']);
  assert.deepEqual(workQueue(issues, order).map(issue => issue.id), ['a', 'running', 'planning', 'second', 'first']);
  assert.throws(() => reorderTodo(issues, ['first', 'first']), /every ToDo/);
});

test('legacy numbering preserves stable IDs and repairs imported number collisions without reuse', async () => {
  const { numberIssues, matchesIssue } = await import('../src/workflow.js');
  const migrated = numberIssues({ issues: [{ id: 'old-a' }, { id: 'old-b' }], nextIssueNumber: 132 });
  assert.deepEqual(migrated.issues.map(i => i.number), [132, 133]);
  assert.equal(migrated.nextIssueNumber, 134);
  const reordered = numberIssues({ ...migrated, issues: [...migrated.issues].reverse() });
  assert.deepEqual(reordered.issues.map(i => i.number), [133, 132]);
  const collision = numberIssues({ ...migrated, issues: [...migrated.issues, { id: 'imported', number: 132 }] });
  assert.equal(collision.issues[2].number, 134);
  assert.equal(matchesIssue(collision.issues[0], '#132'), true);
});

test('Review rejects absent, malformed and unsafe links, accepts Activity or artifact independently', () => {
  const issue = move(createIssue({ id: 'missing-link', title: 'review result' }, start), 'InProgress');
  assert.throws(() => move(issue, 'Review'), /Activityリンクまたは成果物リンク/);
  assert.throws(() => move({ ...issue, activityUrl: 'javascript:alert(1)' }, 'Review'), /最低1つ/);
  assert.throws(() => move({ ...issue, links: [{ url: 'not a URL' }] }, 'Review'), /最低1つ/);
  assert.equal(move({ ...issue, activityUrl: 'codex://threads/test-review' }, 'Review').status, 'Review');
  const linked = reportProgress(issue, { expectedVersion: issue.version, text: 'result', sourceRef: 'test:result', links: [{ url: 'https://example.com/result', label: 'artifact' }] });
  assert.equal(move(linked, 'Review').status, 'Review');
});

test('Plan and later statuses require agent context and preserve handoff history', () => {
  const issue = createIssue({ id: 'owned', title: 'assignment', activityUrl: 'https://example.com/activity' }, start);
  assert.throws(() => transition(issue, { to: 'Plan', actor: 'dot', expectedVersion: 1 }), /担当エージェント/);
  const local = { environment: 'local', name: 'Codex local worker', sourceRef: 'test:local', sessionUrl: 'codex://threads/local' };
  const cloud = { environment: 'codex-cloud', name: 'Codex Cloud worker', sourceRef: 'test:cloud', sessionUrl: 'https://chatgpt.com/codex/tasks/test' };
  const plan = transition(issue, { to: 'Plan', actor: 'dot', expectedVersion: 1, assignee: local });
  assert.equal(plan.assignee.environment, 'local');
  const work = transition(plan, { to: 'InProgress', actor: 'dot', expectedVersion: plan.version, assignee: cloud });
  assert.equal(work.assignee.environment, 'codex-cloud');
  assert.equal(work.history.filter(h => h.type === 'assignment').length, 2);
  assert.equal(move(work, 'Review', { assignee: cloud }).assignee.name, cloud.name);
  assert.throws(() => reportProgress(work, { expectedVersion: work.version, text: 'handoff', sourceRef: 'test', assignee: { ...cloud, sessionUrl: 'javascript:alert(1)' } }), /session URL/);
  assert.equal(move(work, 'Closed', { evidence: decision('cancel') }).status, 'Closed');
});

test('scheduled runs complete directly to Done with execution results, never Review or Release', () => {
  const created = createIssue({ id: 'run', title: 'scheduled check', kind: 'scheduled-run' }, start);
  const run = move(created, 'InProgress');
  assert.throws(() => move(run, 'Review'), /定期実行ログ/);
  assert.throws(() => move(run, 'Release'), /定期実行ログ/);
  assert.throws(() => move(run, 'Done'), /完了結果/);
  const reported = reportProgress(run, { expectedVersion: run.version, text: '確認完了：対象0件', sourceRef: 'test:run-result' });
  const done = move(reported, 'Done');
  assert.equal(done.status, 'Done');
  assert.equal(done.doneAt, new Date(start).toISOString());
  assert.equal(move(done, 'Closed', { actor: 'system' }, start + 7 * 86400000).status, 'Closed');
  assert.equal(move({ ...reported, status: 'Review' }, 'Done').status, 'Done');
  assert.throws(() => move(reported, 'Done', { actor: 'user' }), /actor/);
});
