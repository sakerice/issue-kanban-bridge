import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const quote=s=>"'"+s.replaceAll("'", "'\"'\"'")+"'";
const command=`${quote(process.execPath)} ${quote(join(root,'claude/session-hook.js'))}`;
const hook=()=>[{type:'command',command,timeout:15}];
console.log(JSON.stringify({mcpServers:{'issue-kanban-inbox':{type:'stdio',command:process.execPath,args:[join(root,'claude/server.js')]}},hooks:{PreToolUse:[{matcher:'mcp__issue-kanban-inbox__issue_kanban_submit',hooks:hook()}],SessionStart:[{hooks:hook()}],UserPromptSubmit:[{hooks:hook()}]}},null,2));
