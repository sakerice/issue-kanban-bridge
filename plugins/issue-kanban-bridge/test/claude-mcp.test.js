import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('real Claude MCP, Codex MCP and session hook share a temporary board; retries and other sessions do not duplicate reports', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kanban-e2e-'));
 const root=fileURLToPath(new URL('../',import.meta.url));
 const env={...process.env,ISSUE_KANBAN_DATA:join(dir,'board.json')};
 const origin='11111111-1111-4111-8111-111111111111';
 const hook=input=>{
  const result=spawnSync(process.execPath,[join(root,'claude/session-hook.js')],{env,input:JSON.stringify(input),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
 };
 const claude=new Client({name:'claude-test',version:'1.0.0'}),codex=new Client({name:'codex-test',version:'1.0.0'});
 try {
  await claude.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'claude/server.js')],env,stderr:'pipe'}));
  await codex.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'src/server.js'),'--stdio'],env,stderr:'pipe'}));
  const input=hook({hook_event_name:'PreToolUse',tool_name:'mcp__issue-kanban-inbox__issue_kanban_submit',session_id:origin,tool_input:{title:'Synthetic request',description:'Synthetic completion test',sourceId:'e2e-stable',sourceSessionId:'22222222-2222-4222-8222-222222222222'}}).hookSpecificOutput.updatedInput;
  const receipt=await claude.callTool({name:'issue_kanban_submit',arguments:input});assert.equal(receipt.isError,undefined);assert.equal(receipt.structuredContent.status,'registered');
  assert.match(receipt.structuredContent.watchCommand,/claude\/watch\.js' '[0-9a-f-]{36}'$/);
  // The background watcher must find the same board without inheriting the server's environment.
  const {ISSUE_KANBAN_DATA:_,...plainEnv}=env;
  const watcher=spawn('/bin/sh',['-c',`${receipt.structuredContent.watchCommand} 1`],{env:plainEnv});
  let watched='';watcher.stdout.on('data',d=>watched+=d);
  const watcherExit=new Promise(resolve=>watcher.on('exit',resolve));
  const duplicate=await claude.callTool({name:'issue_kanban_submit',arguments:input});assert.equal(duplicate.structuredContent.issueId,receipt.structuredContent.issueId);
  const board=await codex.callTool({name:'kanban_board',arguments:{}});assert.equal(board.structuredContent.board.issues.length,1);
  let issue=board.structuredContent.board.issues[0];assert.equal(issue.registration.sourceSessionId,origin);
  const moved=await codex.callTool({name:'kanban_transition',arguments:{id:issue.id,expectedVersion:issue.version,to:'InProgress',actor:'dot',assignee:{environment:'local',name:'Test Codex',sourceRef:'test:e2e'}}});
  issue=moved.structuredContent.board.issues[0];
  const done=await codex.callTool({name:'kanban_complete_claude',arguments:{id:issue.id,expectedVersion:issue.version,reportId:'e2e-report',text:'Synthetic finished result',sourceRef:'test:e2e-result',links:[]}});
  assert.equal(done.isError,undefined);assert.equal(done.structuredContent.board.issues[0].status,'Done');
  assert.equal(await watcherExit,0);assert.match(watched,/^KANBAN_DONE [0-9a-f-]{36} Synthetic request/);
  assert.deepEqual(hook({hook_event_name:'UserPromptSubmit',session_id:'22222222-2222-4222-8222-222222222222'}),{});
  const delivered=hook({hook_event_name:'UserPromptSubmit',session_id:origin});assert.match(delivered.hookSpecificOutput.additionalContext,/Synthetic finished result/);
  assert.deepEqual(hook({hook_event_name:'UserPromptSubmit',session_id:origin}),{});
 } finally {await claude.close();await codex.close();rmSync(dir,{recursive:true,force:true});}
});
