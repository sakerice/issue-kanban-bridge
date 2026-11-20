import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from './inbox.js';
import { sessionHook } from './session-hook.js';
import { issueTicket, redeemTicket, ticketKey, ticketMaxAgeMs } from './ticket.js';
const session = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
test('PreToolUse never rewrites the submit input: matching session passes, missing or foreign session is denied with the real ID', async () => {
  const submit = { session_id: session, hook_event_name: 'PreToolUse', tool_name: 'mcp__issue-kanban-inbox__issue_kanban_submit' };
  const directory = await mkdtemp(join(tmpdir(), 'kanban-ticket-'));
  try {
  const request = { title: 'task', description: 'd', sourceId: 'hook:ticket', sourceSessionId: session };
  let emitted;
  assert.deepEqual(await sessionHook({ ...submit, tool_input: request }, { directory, emit: async value => { emitted = value; } }), {});
  assert.deepEqual(emitted, {});
  // The pass leaves a one-time ticket for exactly this session and these contents.
  assert.equal(await redeemTicket(directory, other, request), false);
  assert.equal(await redeemTicket(directory, session, { ...request, description: 'changed' }), false);
  assert.equal(await redeemTicket(directory, session, request), true);
  assert.equal(await redeemTicket(directory, session, request), false);
  for (const tool_input of [{ ...request, sourceSessionId: other }, { title: 'task' }]) {
    const pre = await sessionHook({ ...submit, tool_input }, { directory });
    assert.equal(pre.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(pre.hookSpecificOutput.permissionDecisionReason.includes(session));
    assert.equal(pre.hookSpecificOutput.updatedInput, undefined);
  }
  assert.deepEqual(await readdir(join(directory, 'tickets')), []);
  // Expired tickets are refused.
  await issueTicket(directory, session, request, Date.now() - ticketMaxAgeMs - 1000);
  assert.equal(await redeemTicket(directory, session, request), false);
  // Issuing a ticket removes tickets that have expired, even if nobody redeemed them.
  const stale = { ...request, sourceId: 'hook:stale' };
  await issueTicket(directory, session, stale);
  const old = new Date(Date.now() - ticketMaxAgeMs - 60000);
  await utimes(join(directory, 'tickets', `${ticketKey(session, stale)}.json`), old, old);
  await issueTicket(directory, session, request);
  assert.deepEqual(await readdir(join(directory, 'tickets')), [`${ticketKey(session, request)}.json`]);
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.deepEqual(await sessionHook({ ...submit, tool_name: 'mcp__other__tool', tool_input: {} }), {});
  const start = await sessionHook({ session_id: session, hook_event_name: 'SessionStart' }, { directory: join(tmpdir(), 'kanban-missing-' + session) });
  assert.ok(start.hookSpecificOutput.additionalContext.includes(session));
});
test('completion routes only to originating session', async () => {
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
