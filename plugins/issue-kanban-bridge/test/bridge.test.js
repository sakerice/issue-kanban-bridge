import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from '../src/store.js';
const assignee={environment:'local',name:'Test Codex',sourceRef:'test:worker'};
test('two local processes share fresh state and reject a racing stale write',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kanban-lock-'));
 try { const path=join(dir,'board.json'),a=new BoardStore(path),b=new BoardStore(path);
 const first=a.create({title:'First',sourceId:'first'}),second=b.create({title:'Second',sourceId:'second'});
 assert.equal(a.board().issues.length,2);
 a.refresh(); const stale=structuredClone(a.state); b.create({title:'Third',sourceId:'third'});
 assert.throws(()=>a.save(stale),/conflict/); assert.equal(a.board().issues.length,3);
 const moved=a.move({id:first.id,expectedVersion:1,to:'InProgress',actor:'dot',assignee});
 assert.equal(b.board().issues.find(i=>i.id===first.id).status,'InProgress');
 assert.throws(()=>b.move({id:first.id,expectedVersion:1,to:'Review',actor:'dot'}),/conflict/);
 writeFileSync(`${path}.lock`,''); assert.throws(()=>a.create({title:'Locked',sourceId:'locked'}),/busy/);
 assert.equal(JSON.parse(readFileSync(path)).issues.length,3);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('Claude registration is atomic and completion is routed to the original session without release authority',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kanban-claude-'));
 try { const store=new BoardStore(join(dir,'board.json'));
 const request={title:'Claude task',description:'Create a reviewable result',sourceId:'claude-code:stable',sourceSessionId:'11111111-1111-4111-8111-111111111111'};
 let issue=store.register(request); assert.equal(issue.status,'ToDo'); assert.match(issue.history[1].text,/reviewable/);
 assert.equal(store.register(request).id,issue.id); assert.equal(store.board().issues.length,1);
 assert.throws(()=>store.register({...request,description:'different'}),/different/);
 issue=store.move({id:issue.id,expectedVersion:issue.version,to:'InProgress',actor:'dot',assignee});
 const completion={id:issue.id,expectedVersion:issue.version,reportId:'stable-report',text:'Finished',sourceRef:'test:result',links:[]};
 issue=store.completeClaude(completion); assert.equal(issue.status,'Done');assert.equal(issue.completion.sourceSessionId,request.sourceSessionId);
 assert.equal(store.completeClaude(completion).completion.reportId,'stable-report');
 assert.throws(()=>store.completeClaude({...completion,text:'changed'}),/different/);
 const normal=store.create({title:'Normal',sourceId:'normal'});
 assert.throws(()=>store.completeClaude({...completion,id:normal.id}),/origin/);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
