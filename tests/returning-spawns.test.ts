import { autopilotLaneCount } from '../lib/autopilot.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperFixture } from './fixtures/helper-plugin.js';
import { workspaceIssues } from './fixtures/board-workspace.js';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';

test('a returning completed parent starts one fresh Lead and keeps its occupied slot', async t => {
  const epoch = Date.parse('2026-11-14T12:00:00Z');
  const nodes = workspaceIssues.data.issues.nodes;
  const done = { id: 'done', name: 'Done', type: 'completed' };
  let parentEdited = false;
  const closed = {...nodes.find(x=>x.identifier==='FIX-5')!, state:done};
  const f = await helperFixture(t,epoch,{
    issues:()=>Response.json({data:{issues:{...workspaceIssues.data.issues,nodes:nodes.filter(x=>x.identifier!=='FIX-5')}}}),
    laneSpec:()=>Response.json({data:{issue:{...closed,...(parentEdited ? {updatedAt:new Date(Date.now()+1000).toISOString()} : {}),children:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}),
  });
  f.projects.splice(1);
  const old = f.lead('one','Lead');
  f.threads.set(old.id,{...old,createdAt:epoch-10000});
  f.harness.sdk.stub('plugins.callRpc', async ()=> ({'env-one':{outcome:'available',pullRequest:{number:7,state:'merged',url:'https://example.invalid/pr/7',updatedAt:new Date(epoch-5000).toISOString(),checks:{state:'passing'}}}}));
  let count = 0;
  const metadata = new Map<string, Record<string, unknown>>();
  f.harness.sdk.stub('threads.spawn', async (args: {pluginMetadata?: Record<string, unknown>})=> {
    const fresh=makeThreadResponse({id:`lead-fresh-${++count}`,projectId:'one',environmentId:`env-fresh-${count}`,status:'active',createdAt:Date.now()});
    f.threads.set(fresh.id,fresh);
    metadata.set(fresh.id,args.pluginMetadata ?? {});
    return fresh;
  });
  await f.board();
  // Refresh a seeded old lane once so the retained completed parent is loaded.
  await f.reload();
  f.harness.sdk.stub('plugins.callRpc', async ()=> ({'env-one':{outcome:'available',pullRequest:{number:7,state:'merged',url:'https://example.invalid/pr/7',updatedAt:new Date(epoch-5000).toISOString(),checks:{state:'passing'}}}}));
  f.harness.sdk.stub('threads.spawn', async (args: {pluginMetadata?: Record<string, unknown>})=> {
    const fresh=makeThreadResponse({id:`lead-fresh-${++count}`,projectId:'one',environmentId:`env-fresh-${count}`,status:'active',createdAt:Date.now()});
    f.threads.set(fresh.id,fresh);
    metadata.set(fresh.id,args.pluginMetadata ?? {});
    return fresh;
  });
  const before=await f.board();
  assert.equal(before.lanes[0].state, 'landed', 'the old lane stays visible before another Lead starts');
  assert.deepEqual(await f.harness.behavior.callRpc('lane.start', {projectId:'one', specId:'FIX-5'}), {threadId:old.id});
  assert.equal(count, 0, 'even a merged lane cannot start another Lead while its current Lead is active');
  f.threads.set(old.id, {...f.threads.get(old.id)!, status:'idle'});
  assert.equal(before.ready.find(x=>x.id==='FIX-5')?.startReason,null);
  await f.harness.behavior.callRpc('autopilot.set',{projectId:'one',status:'on',laneLimit:1});
  await f.startWatcher();
  assert.equal(count,1);
  await f.advance(30000);
  assert.equal(count,1);
  await f.advance(30000);
  assert.equal(count,1);
  assert.equal(metadata.get('lead-fresh-1')?.previousLeadId, old.id);
  parentEdited = true;
  f.threads.set(old.id, {...f.threads.get(old.id)!, archivedAt:Date.now()});
  // A later title/label edit of the still-completed parent is not a new landing.
  await f.reload();
  f.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>metadata.get(threadId) ?? {});
  const board=await f.board();
  assert.deepEqual(board.lanes.map(x => [x.leadThreadId, x.state]), [['lead-fresh-1', 'flying']]);
  assert.ok(!board.ready.some(x => x.id === 'FIX-5'));
  assert.equal(autopilotLaneCount(board), 1);
  const manual = await f.harness.behavior.callRpc('lane.start', {projectId:'one', specId:'FIX-5'});
  assert.deepEqual(manual, {threadId:'lead-fresh-1'});
  assert.equal(count, 1, 'manual Start also reuses the active returning Lead');
  f.threads.set('lead-fresh-1', {...f.threads.get('lead-fresh-1')!,status:'error'});
  const stopped = await f.board();
  assert.equal(stopped.lanes[0].state,'stopped', 'the edited parent cannot land a failed returning Lead either');
  assert.deepEqual(await f.harness.behavior.callRpc('lane.start',{projectId:'one',specId:'FIX-5'}), {threadId:'lead-fresh-1'});
  assert.equal(count,1);
});

// Parent edits carry no completion evidence for a returned Lead, even after
// the old thread is archived and can no longer be discovered in BB.
for (const kind of ['linear', 'github', 'local-markdown'] as const) {
  test(`${kind} attributes a returned lane's completion to its own environment or branch`, async () => {
    const { deriveBoard } = await import('../lib/board-derive.js');
    const { input, issue, snapshot } = await import('./fixtures/board-snapshots.js');
    const started = Date.parse('2026-11-14T12:00:00Z');
    const source = input(snapshot([
      issue('FIX-5', { labels:['ready-for-agent'], done:true, updatedAt:'2026-11-14T12:01:00Z' }),
      issue('FIX-6', { parent:'FIX-5' }),
    ]), {kind});
    const lead = {
      specId:'fix-5', previousLeadId:'old', branch:'spec/returned',
      thread:makeThreadResponse({id:'returned',projectId:'proj-one',environmentId:'env-returned',status:'active',createdAt:started}),
      route:{family:'gpt' as const,model:'gpt-6.1-sol',effort:'medium' as const},
    };
    const noRemote = kind === 'local-markdown';
    const repository = {hasRemote:!noRemote, mainUpdatedAt:started-1000,
      mergedBranches:['spec/old','spec/returned'], mergedBranchUpdatedAt:{'spec/old':started-1000,'spec/returned':started-1000}};
    const laneSnapshot = {...source.snapshot,issues:source.snapshot.issues.map(ticket => ticket.parentId ? {
      ...ticket,state:{id:'done',name:'Done',type:'completed'},
    } : ticket)};
    const laneInput = {...source,leads:[lead],repository,
      ...(noRemote ? {laneSnapshots:{'fix-5':laneSnapshot}} : {})};
    const active = deriveBoard(laneInput).board;
    assert.equal(active.lanes[0].state,'flying');
    assert.equal(autopilotLaneCount(active),1);
    assert.deepEqual(active.ready,[]);
    if (noRemote) assert.equal(active.lanes[0].tickets[0].state,'branch');
    lead.thread.status = 'error';
    const stopped = deriveBoard(laneInput).board;
    assert.equal(stopped.lanes[0].state,'stopped');
    assert.equal(stopped.lanes[0].landedAt,undefined);
    const merged = noRemote
      ? deriveBoard({...laneInput,repository:{...repository,mainUpdatedAt:started+2000,
        mergedBranchUpdatedAt:{...repository.mergedBranchUpdatedAt,'spec/returned':started+2000}}}).board
      : deriveBoard({...laneInput,pullRequests:{'env-old':{outcome:'available',pullRequest:{number:1,state:'merged',url:'https://example.invalid/pr/old',updatedAt:'2026-11-14T12:00:01Z',checks:{state:'passing'}}},
        'env-returned':{outcome:'available',pullRequest:{number:2,state:'merged',url:'https://example.invalid/pr/new',updatedAt:'2026-11-14T12:00:02Z',checks:{state:'passing'}}}}}).board;
    assert.equal(merged.lanes[0].state,'landed');
    assert.equal(merged.lanes[0].landedAt,started+2000);
    assert.equal(autopilotLaneCount(merged),0);
  });
}
