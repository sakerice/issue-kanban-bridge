import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
// Prints a configuration proposal for Claude Code; it never edits settings files.
// --with-board also adds the board server (src/server.js --stdio) so one Claude Code session
// can act as PM and worker: kanban_next, kanban_transition, kanban_progress and so on.
const root=fileURLToPath(new URL('../',import.meta.url));
const quote=s=>"'"+s.replaceAll("'", "'\"'\"'")+"'";
const command=`${quote(process.execPath)} ${quote(join(root,'claude/session-hook.js'))}`;
const hook=()=>[{type:'command',command,timeout:15}];
const mcpServers={'issue-kanban-inbox':{type:'stdio',command:process.execPath,args:[join(root,'claude/server.js')]}};
if(process.argv.includes('--with-board')) mcpServers['issue-kanban']={type:'stdio',command:process.execPath,args:[join(root,'src/server.js'),'--stdio'],cwd:root};
console.log(JSON.stringify({mcpServers,hooks:{PreToolUse:[{matcher:'mcp__issue-kanban-inbox__issue_kanban_submit',hooks:hook()}],SessionStart:[{hooks:hook()}],UserPromptSubmit:[{hooks:hook()}]}},null,2));
