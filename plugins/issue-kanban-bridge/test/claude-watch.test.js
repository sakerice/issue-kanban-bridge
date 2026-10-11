import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch, readBoardFile } from '../claude/watch.js';

const boards = (...statuses) => {
  let n = 0;
  return async () => ({ issues: [{ id: 'issue-1', number: 7, title: 'Synthetic request', status: statuses[Math.min(n++, statuses.length - 1)] }] });
};
const noSleep = async () => {};

test('watch waits through ToDo/InProgress and ends with KANBAN_DONE', async () => {
  assert.deepEqual(await watch('issue-1', { readBoard: boards('ToDo', 'InProgress', 'Done'), sleep: noSleep }), { result: 'KANBAN_DONE', id: 'issue-1', title: 'Synthetic request' });
});

test('watch accepts the card number and reports cancellation as KANBAN_CLOSED', async () => {
  assert.equal((await watch('7', { readBoard: boards('Closed'), sleep: noSleep })).result, 'KANBAN_CLOSED');
});

test('watch reports a missing issue, repeated read failures and the time limit', async () => {
  assert.equal((await watch('other', { readBoard: boards('Done'), sleep: noSleep })).result, 'KANBAN_MISSING');
  let calls = 0;
  const failed = await watch('issue-1', { readBoard: async () => { calls++; throw new Error('partial write'); }, sleep: noSleep });
  assert.equal(failed.result, 'KANBAN_ERROR'); assert.equal(calls, 6);
  let t = 0;
  assert.equal((await watch('issue-1', { readBoard: boards('ToDo'), sleep: noSleep, hours: 1, now: () => (t += 3600e3) })).result, 'KANBAN_TIMEOUT');
});

test('readBoardFile reads without creating or modifying the board', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-watch-'));
  try {
    assert.deepEqual(readBoardFile(join(dir, 'missing.json')), { issues: [] });
    const file = join(dir, 'board.json');
    const text = JSON.stringify({ schemaVersion: 1, revision: 3, issues: [{ id: 'a', status: 'Done' }], todoOrder: [] });
    writeFileSync(file, text);
    assert.equal(readBoardFile(file).issues[0].status, 'Done');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
