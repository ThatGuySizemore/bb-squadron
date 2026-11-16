import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import {helperFixture,settle} from './fixtures/helper-plugin.js';
import {workspaceIssues} from './fixtures/board-workspace.js';
import {done} from './fixtures/linear-mirror.js';
const epoch=Date.parse('2026-11-14T12:00:00Z');
test('two failed lanes with open PRs pause Autopilot before another start',async t=>{
 const base=workspaceIssues.data.issues.nodes;
 const f=await helperFixture(t,epoch,{issues:()=>Response.json({data:{issues:{...workspaceIssues.data.issues,nodes:[...base.map(n=>n.identifier==='FIX-1'?{...n,inverseRelations:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}:n),{...base[3],id:'fix-7',identifier:'FIX-7'},{...base[4],id:'fix-8',identifier:'FIX-8',parent:{id:'fix-7'}}]}}})});
 for (const [id,spec] of [['first','fix-1'],['second','fix-5']])f.threads.set(id,makeThreadResponse({id,projectId:'one',environmentId:'env-'+id,status:'active',createdAt:epoch}));
 const meta=new Map<string, Record<string, unknown>>([['first',{role:'lead',specId:'fix-1'}],['second',{role:'lead',specId:'fix-5'}]]);
 f.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>meta.get(threadId)??{});
 f.harness.sdk.stub('plugins.callRpc',async()=>Object.fromEntries(['first','second'].map((id,i)=>['env-'+id,{outcome:'available',pullRequest:{number:i+1,state:'open',url:'https://example.invalid/pr/'+(i+1),updatedAt:new Date(epoch).toISOString(),checks:{state:'passing'}}}])));
 f.harness.sdk.stub('threads.spawn',async (args: {projectId: string; pluginMetadata?: Record<string, unknown>})=>{const thread=makeThreadResponse({id:'spawned',projectId:args.projectId,environmentId:'env-spawned',status:'active',createdAt:epoch+1});f.threads.set(thread.id,thread);meta.set(thread.id,args.pluginMetadata ?? {});return thread;});
 await f.board();
 await f.harness.behavior.callRpc('autopilot.set',{projectId:'one',status:'on',laneLimit:2});
 await settle();
 for(const id of ['first','second'])f.threads.set(id,{...f.threads.get(id)!,status:'error',updatedAt:epoch+1000});
 const board=await f.board();
 assert.deepEqual(board.lanes.map(l=>[l.state,l.stopped]), [['pr-open',true],['pr-open',true]]);
 assert.ok(board.lanes.every(l=>l.needs?.some(n=>n.kind==='failed')));
 await f.startWatcher();await settle();
 const after=await f.board();
 assert.equal(after.autopilot?.status,'paused');
 assert.equal(after.autopilot?.pauseReason,'Two lanes in a row stopped');
 assert.equal(after.autopilot?.consecutiveStops,2);
 assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length,0);
 await f.board();
 assert.equal((await f.board()).autopilot?.consecutiveStops,2,'repeated reads retain the two stop receipts');
 await f.harness.behavior.callRpc('autopilot.resume',{projectId:'one'});
 assert.equal((await f.board()).autopilot?.consecutiveStops,0,'Resume does not replay stopped Leads with open PRs');
 assert.equal(f.threads.get('first')?.status,'error');
 assert.equal(f.threads.get('second')?.status,'error');
});

for (const outcome of ['owner-question', 'owner-merge', 'outside', 'landed'] as const) {
 test(`a confirmed stop with an open PR preserves the ${outcome} exclusion`, async t => {
  const nodes = workspaceIssues.data.issues.nodes.map(node=>node.identifier==='FIX-5' && outcome==='owner-merge' ? {
    ...node,labels:{...node.labels,nodes:[...node.labels.nodes,{id:'accept',name:'accept:owner',color:'#aaaaaa'}]},
   } : node.identifier==='FIX-6' ? {...node,state:done} : node);
  const f = await helperFixture(t,epoch,{
   issues:()=>Response.json({data:{issues:{...workspaceIssues.data.issues,nodes}}}),
   laneSpec:()=>Response.json({data:{issue:{...nodes.find(node=>node.identifier==='FIX-5')!,children:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}),
  });
  f.projects.splice(1);
  const thread = f.lead('one',outcome==='owner-question' ? 'Question' : 'Lead FIX-5');
  f.threads.set(thread.id,{...thread,status:'error',updatedAt:epoch+1000});
  if(outcome==='outside') f.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
  f.harness.sdk.stub('plugins.callRpc',async()=>({'env-one':{outcome:'available',pullRequest:{
   number:1,state:outcome==='landed' ? 'merged' : 'open',url:'https://example.invalid/pr/1',updatedAt:new Date(epoch+1000).toISOString(),checks:{state:'passing'},
  }}}));
  await f.board();
  await f.harness.behavior.callRpc('autopilot.set',{projectId:'one',status:'on',laneLimit:1});
  const board = await f.board();
  assert.equal(board.lanes[0].stopped,true);
  assert.equal(board.lanes[0].state,outcome==='landed' ? 'landed' : outcome==='owner-merge' ? 'merge-waits' : 'pr-open');
  if(outcome==='owner-question') assert.equal(board.lanes[0].needs?.[0].kind,'waiting');
  if(outcome==='outside') assert.equal(board.lanes[0].outside,true);
  assert.equal(board.autopilot?.consecutiveStops,0);
  assert.equal(board.autopilot?.status,'on');
 });
}
