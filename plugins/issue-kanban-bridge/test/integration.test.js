import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BoardStore } from '../src/store.js';

test('store survives restart, retries do not duplicate, stale reorder cannot overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-store-'));
  try {
    const path = join(dir, 'board.json'); const store = new BoardStore(path);
    const a = store.create({ title: 'A', sourceId: 'request:a' });
    assert.equal(store.create({ title: 'A retry', sourceId: 'request:a' }).id, a.id);
    const before = store.board(); const b = store.create({ title: 'B', sourceId: 'request:b' });
    assert.throws(() => store.reorder({ ids: [b.id, a.id], expectedRevision: before.revision }), /conflict/);
    store.reorder({ ids: [b.id, a.id], expectedRevision: store.board().revision });
    const reloaded = new BoardStore(path);
    assert.deepEqual(reloaded.board().queue.map(i => i.title), ['B', 'A']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCP client discovers panel, reads UI, and reports progress into shared card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-mcp-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/server.js'), '--stdio'], env: { ...process.env, DOTS_KANBAN_DATA: join(dir, 'board.json') }, stderr: 'pipe' }));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    assert.ok(tools.find(t => t.name === 'kanban_complete_claude'));
    assert.equal(tools.find(t => t.name === 'kanban_progress')._meta.ui, undefined);
    assert.ok(tools.find(t => t.name === 'kanban_board')._meta['openai/ui'].entrypoints.some(e => e.type === 'thread'));
    const resource = await client.readResource({ uri: 'ui://dots-kanban/board.html' });
    assert.match(resource.contents[0].text, /Issue Kanban/);
    const create = await client.callTool({ name: 'kanban_create', arguments: { title: 'MCP task', sourceId: 'test:mcp' } });
    let issue = create.structuredContent.board.issues[0];
    const move = await client.callTool({ name: 'kanban_transition', arguments: { id: issue.id, expectedVersion: issue.version, to: 'InProgress', assignee: { environment: 'local', name: 'Codex test', sourceRef: 'test:execution-context', sessionUrl: 'codex://threads/test-worker' }, actor: 'dot' } });
    issue = move.structuredContent.board.issues[0];
    const progress = await client.callTool({ name: 'kanban_progress', arguments: { id: issue.id, expectedVersion: issue.version, text: '確認資料を作成', sourceRef: 'test:message', links: [{ url: 'https://example.com/result', label: '成果物' }] } });
    issue = progress.structuredContent.board.issues[0];
    assert.equal(issue.status, 'InProgress');
    assert.equal(issue.links[0].label, '成果物');
    const stale = await client.callTool({ name: 'kanban_transition', arguments: { id: issue.id, expectedVersion: 1, to: 'Review', assignee: { environment: 'local', name: 'Codex test', sourceRef: 'test:execution-context', sessionUrl: 'codex://threads/test-worker' }, actor: 'dot' } });
    assert.equal(stale.isError, true);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
