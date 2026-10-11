import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from './inbox.js';
import { sessionHook } from './session-hook.js';
const session = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
test('actual hook session overrides caller ID and completion routes only to originating session', async () => {
  const pre = await sessionHook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'mcp__issue-kanban-inbox__issue_kanban_submit', tool_input: { title: 'task', sourceSessionId: other } });
  assert.equal(pre.hookSpecificOutput.updatedInput.sourceSessionId, session);
  const directory = await mkdtemp(join(tmpdir(), 'kanban-session-'));
  try {
    const inbox = new Inbox(directory);
    const receipt = await inbox.submit({ title: 'task', description: 'result required', sourceId: 'hook:one', sourceSessionId: session });
    await inbox.acknowledge(receipt.id, 'issue-1');
    let calls = 0;
    const options = { directory, readBoard: async () => { calls++; return { issues: [{ id: 'issue-1', title: 'task', status: 'Done', registration: { sourceSessionId: session }, completion: { reportId: 'report-1', sourceSessionId: session, text: 'verified result', links: [] } }] }; } };
    const input = { session_id: session, hook_event_name: 'UserPromptSubmit' };
    assert.deepEqual(await sessionHook({ ...input, session_id: other }, options), {});
    assert.equal(calls, 0);
    await assert.rejects(sessionHook(input, { ...options, readBoard: async () => { throw new Error('offline'); } }), /offline/);
    await assert.rejects(sessionHook(input, { ...options, emit: async () => { throw new Error('output failed'); } }), /output failed/);
    let emitted;
    const result = await sessionHook(input, { ...options, emit: async value => { emitted = value; } });
    assert.match(result.hookSpecificOutput.additionalContext, /verified result/);
    assert.deepEqual(emitted, result);
    assert.deepEqual(await sessionHook(input, options), {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});
