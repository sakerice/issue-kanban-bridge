import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Inbox } from './inbox.js';
import { registerReceipt } from './registration.js';
const inbox = new Inbox();
const server = new McpServer({ name: 'issue-kanban-inbox', version: '0.1.0' }, { instructions: 'Register requests only. Reuse sourceId for retries. This tool never delegates, starts agents or authorizes release. The hook binds the real sourceSessionId. Completion reports are retrieved on the next input/resume of that originating session, not an immediate push.' });
server.registerTool('issue_kanban_submit', { description: 'Create an issue and its request text in the local shared board. No agent startup.', inputSchema: { title: z.string().min(1).max(300), description: z.string().min(1).max(20000), sourceId: z.string().min(1).max(500), sourceSessionId: z.string().uuid().optional(), projectPath: z.string().optional(), sourceUrl: z.string().url().optional() } }, async args => {
  try { const result = await registerReceipt(await inbox.submit(args), inbox); return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
