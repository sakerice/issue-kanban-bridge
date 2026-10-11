import { dataPath } from './paths.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { BoardStore } from './store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const store = new BoardStore(dataPath);
const uri = 'ui://dots-kanban/board.html';
const html = readFileSync(join(root, 'public/board.html'), 'utf8');
const version = z.number().int().positive();
const evidence = z.object({ intent: z.enum(['approve', 'return', 'release', 'cancel']), sourceRef: z.string().min(1), quote: z.string().min(1) });
const assignee = z.object({ environment: z.enum(['local', 'codex-cloud', 'dot', 'other']), name: z.string().trim().min(1).max(200), sourceRef: z.string().trim().min(1).max(2000), sessionUrl: z.string().url().optional() });
const link = z.object({ url: z.string().url(), label: z.string() });
const ui = { ui: { resourceUri: uri }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } };

export function createMcpServer() {
  const server = new McpServer({ name: 'issue-kanban-bridge', version: '0.1.0' });
  registerAppResource(server, 'board', uri, {}, async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }] }));
  function tool(name, description, schema, fn, readOnly = false) {
    registerAppTool(server, name, { title: name, description, inputSchema: schema, _meta: ['kanban_board', 'kanban_panel'].includes(name) ? { ...ui, 'openai/outputTemplate': uri } : {}, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } }, async args => {
      try {
        const result = fn(args);
        const board = store.board(args.query || '');
        return { content: [{ type: 'text', text: JSON.stringify(result ?? { revision: board.revision, counts: Object.fromEntries(['ToDo', 'Plan', 'InProgress', 'Review', 'Release', 'Done', 'Closed'].map(s => [s, board.issues.filter(i => i.status === s).length])) }) }], structuredContent: { board } };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  tool('kanban_board', 'Open the shared board and search Closed history. Imported Activity coverage is unverified. Read includes automatic archival of Done after seven days.', { query: z.string().optional() }, () => undefined);
  tool('kanban_panel', 'Open the issue board in the current chat panel.', { query: z.string().optional() }, () => undefined);
  tool('kanban_guide', 'Read the board workflow rules.', {}, () => ({ guide: readFileSync(join(root, 'skills/issue-kanban-bridge/SKILL.md'), 'utf8') }));
  tool('kanban_complete_claude', 'Save the completed result for the originating Claude Code session and move to Done. Does not release or deploy.', { id: z.string(), expectedVersion: version, reportId: z.string().min(1), text: z.string().min(1), sourceRef: z.string().min(1), links: z.array(link).default([]), assignee: assignee.optional() }, args => store.completeClaude(args));
  tool('kanban_create', 'Register one actual user request or one scheduled execution as ToDo. Use a unique sourceId for each issue or schedule run to prevent duplicate creation. Include the actual Activity URL when available.', { title: z.string().min(1), kind: z.enum(['request', 'scheduled-run']).default('request'), sourceId: z.string().min(1), activityUrl: z.string().url().optional() }, args => store.create(args));
  tool('kanban_progress', 'Record the progress reported in chat on the corresponding issue, with source message reference and output links. Does not change status.', { id: z.string(), expectedVersion: version, text: z.string().min(1), sourceRef: z.string().min(1), links: z.array(link).default([]), assignee: assignee.optional() }, args => store.progress(args));
  tool('kanban_transition', 'Advance ToDo→Plan→InProgress→Review (simple requests may skip Plan) as dot. Scheduled-run logs never enter Review or Release: save the execution result then advance InProgress→Done as dot without user approval. Plan and subsequent statuses require a verified assignee (environment local/codex-cloud/dot/other, agent name and sourceRef; sessionUrl when available). Specify assignee on transition or progress, record handoffs and never guess. Entering Review requires at least one genuine Activity or artifact URL already saved on the card (activityUrl or links); otherwise the server rejects the transition. Never invent URLs. Review→Done/ToDo/Release and cancellation require the actual explicit user decision with source reference and quote; distinguish casual comment OK from completion approval in context. Release→Done requires verified production result. This tool records status and never executes a deployment or stops an agent.', { id: z.string(), expectedVersion: version, to: z.enum(['ToDo', 'Plan', 'InProgress', 'Review', 'Release', 'Done', 'Closed']), actor: z.enum(['user', 'dot']), evidence: evidence.optional(), assignee: assignee.optional(), releaseResult: z.object({ verified: z.boolean(), sourceRef: z.string().min(1) }).optional() }, args => store.move(args));
  tool('kanban_reorder_todo', 'Apply the user chosen order of all request ToDo IDs. Dots must not reprioritize independently. Board revision is required to reject stale reorder actions.', { ids: z.array(z.string()), expectedRevision: z.number().int().nonnegative() }, args => store.reorder(args));
  tool('kanban_next', 'Return eligible request work in Release > InProgress > Plan > user ordered ToDo priority. Review waits for user. Selecting work does not launch it.', {}, () => ({ queue: store.board().queue }));
  return server;
}

if (process.argv.includes('--stdio')) {
  await createMcpServer().connect(new StdioServerTransport());
} else {
  const token = process.env.DOTS_KANBAN_TOKEN;
  const host = process.env.DOTS_KANBAN_HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8798);
  if (host !== '127.0.0.1' && !token) throw new Error('Remote access requires DOTS_KANBAN_TOKEN');
  const authorized = req => {
    if (!token) return true;
    const incoming = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    return incoming.length === expected.length && timingSafeEqual(incoming, expected);
  };
  createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!['localhost', '127.0.0.1'].includes((req.headers.host || '').split(':')[0]) && !token) { res.writeHead(403).end('Remote access requires authentication'); return; }
    if (pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return; }
    if (!authorized(req)) { res.writeHead(401).end('Unauthorized'); return; }
    // Browser preview and MCP share the same store. No permissive cross-origin mutations.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403).end('Cross-origin request rejected'); return; }
    if (req.method === 'GET' && pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html); return; }
    if (req.method === 'GET' && pathname === '/api/board') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ board: store.board() })); return; }
    if (req.method === 'POST' && pathname === '/api/tool') {
      let body = '';
      try {
        for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('Request too large'); }
        const { name, arguments: args } = JSON.parse(body);
        if (name === 'kanban_create') store.create(z.object({ title: z.string().min(1), kind: z.enum(['request', 'scheduled-run']), sourceId: z.string(), activityUrl: z.string().url().optional() }).parse(args));
        else if (name === 'kanban_transition') store.move({ ...z.object({ id: z.string(), expectedVersion: version, to: z.enum(['ToDo', 'Done', 'Release', 'Closed']), evidence }).parse(args), actor: 'user' });
        else if (name === 'kanban_reorder_todo') store.reorder(z.object({ ids: z.array(z.string()), expectedRevision: z.number() }).parse(args));
        else if (name !== 'kanban_board') throw new Error('Unsupported UI action');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ board: store.board(args?.query || '') }));
      } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message })); }
      return;
    }
    if (pathname === '/mcp' && req.method === 'POST') {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      try { await server.connect(transport); await transport.handleRequest(req, res); }
      catch { if (!res.headersSent) res.writeHead(500).end('MCP request failed'); }
      return;
    }
    res.writeHead(404).end('Not found');
  }).listen(port, host, () => console.error(`Issue Kanban: http://${host}:${port}`));
  setInterval(() => store.archive(), 60000).unref();
}
