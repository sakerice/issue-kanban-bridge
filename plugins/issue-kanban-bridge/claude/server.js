import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Inbox } from './inbox.js';
import { registerReceipt } from './registration.js';
import { watchCommand } from './watch.js';
const inbox = new Inbox();
const server = new McpServer({ name: 'issue-kanban-inbox', version: '0.1.0' }, { instructions: 'Register requests only. Reuse sourceId for retries. This tool never delegates, starts agents or authorizes release. The hook binds the real sourceSessionId. Completion reports are retrieved on the next input/resume of that originating session, not an immediate push. To continue without waiting for the user, run the watchCommand from the submit result as a background task; it exits when the issue becomes Done (or Closed), and no model runs while it waits.' });
server.registerTool('issue_kanban_submit', { description: 'Create an issue and its request text in the local shared board. No agent startup.', inputSchema: { title: z.string().min(1).max(300), description: z.string().min(1).max(20000), sourceId: z.string().min(1).max(500), sourceSessionId: z.string().uuid().optional(), projectPath: z.string().optional(), sourceUrl: z.string().url().optional() } }, async args => {
  try { const registered = await registerReceipt(await inbox.submit(args), inbox); const result = { ...registered, watchCommand: watchCommand(registered.issueId), watchHint: 'Run watchCommand as a background task; it ends with KANBAN_DONE when the issue is finished. Done does not authorize release.' }; return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
