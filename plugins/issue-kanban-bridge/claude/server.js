import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Inbox } from './inbox.js';
import { registerReceipt } from './registration.js';
import { watchCommand } from './watch.js';
import { redeemTicket } from './ticket.js';
const inbox = new Inbox();
const server = new McpServer({ name: 'issue-kanban-inbox', version: '0.1.0' }, { instructions: 'Register requests only. Reuse sourceId for retries. This tool never delegates, starts agents or authorizes release. Set sourceSessionId to the Claude session ID announced by the Issue Kanban hook ("Issue Kanbanの現在の依頼元ClaudeセッションID"); the hook checks it and denies the call without changing its input if it is missing or wrong, and the denial message contains the correct ID to resubmit with. The server accepts a sourceSessionId only when the hook confirmed that exact call; without the hook, omit sourceSessionId. Completion reports are retrieved on the next input/resume of that originating session, not an immediate push. To continue without waiting for the user, run the watchCommand from the submit result as a background task; it exits when the issue becomes Done (or Closed), and no model runs while it waits.' });
server.registerTool('issue_kanban_submit', { description: 'Create an issue and its request text in the local shared board. No agent startup.', inputSchema: { title: z.string().min(1).max(300), description: z.string().min(1).max(20000), sourceId: z.string().min(1).max(500), sourceSessionId: z.string().uuid().optional().describe('Required when the Issue Kanban hook is installed: the current Claude session ID announced by the hook. Completion reports return only to this session. Accepted only if the hook confirmed this exact call.'), projectPath: z.string().optional(), sourceUrl: z.string().url().optional() } }, async args => {
  try {
    // A request that names an origin session must carry the hook's one-time ticket for exactly
    // these contents; otherwise the session was not checked by the hook and is refused.
    if (args.sourceSessionId && !(await redeemTicket(inbox.directory, args.sourceSessionId, args))) throw new Error('Issue Kanban: the PreToolUse hook did not confirm this request, so sourceSessionId cannot be trusted. Call issue_kanban_submit again with the same arguments so the hook checks it. If the Issue Kanban hook is not installed, omit sourceSessionId (completion reports then cannot return to a session).');
    const registered = await registerReceipt(await inbox.submit(args), inbox); const result = { ...registered, watchCommand: watchCommand(registered.issueId), watchHint: 'Run watchCommand as a background task; it ends with KANBAN_DONE when the issue is finished. Done does not authorize release.' }; return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
