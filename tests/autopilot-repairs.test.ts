import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperFixture, settle } from './fixtures/helper-plugin.js';
import { workspaceIssues } from './fixtures/board-workspace.js';

const epoch = Date.parse('2026-11-14T12:00:00Z');
const skills = ['codex', 'claude-code'].flatMap(provider => ['grill-with-docs', 'to-spec', 'to-tickets', 'implement-spec', 'tdd', 'code-review'].map(name => ({
  id: `${provider}-${name}`, name: `mattpocock-skills:${name}`, description: null, filePath: `/plugins/${provider}/${name}/SKILL.md`, manageable: false, pluginId: 'mattpocock-skills', provider, registrySkillId: null, scope: 'plugin' as const
})));

test('Autopilot refuses the selected spec held while Doctor awaits', async t => {
  let held = false;
  const f = await helperFixture(t, epoch, {issues: () => Response.json({data: {issues: {...workspaceIssues.data.issues, nodes: workspaceIssues.data.issues.nodes.map(node => node.identifier === 'FIX-5' && held ? {...node, labels: {...node.labels, nodes: [...node.labels.nodes, {id:'hold', name:'hold', color:'#aaaaaa'}]}} : node)}}})});
  assert.ok((await f.board()).ready.some(row => row.id === 'FIX-5'));
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  f.harness.sdk.stub('skills.list', async () => { enter(); await gate; return {skills}; });
  await f.harness.behavior.callRpc('autopilot.set', {projectId:'one', status:'on'});
  await entered;
  held = true;
  const reader = f.harness.behavior.runService('linear-reader');
  await settle();
  const snapshot = await f.harness.behavior.callRpc('linear.snapshot', {bbProjectId:'one'}) as import('../lib/tracker-contract.js').TrackerSnapshot;
  assert.ok(snapshot.issues.find(row => row.identifier === 'FIX-5')!.labels.some(label => label.name === 'hold'));
  release();
  await settle();
  reader.controller.abort(); await reader.done;
  const calls = f.harness.inspection.sdk.callsTo('threads.spawn').map(([input]) => (input as {title: string}).title);
  assert.ok(!calls.includes('Lead FIX-5'), 'a hold seen before spawn must prevent Start');
  assert.ok((await f.board()).shaping.some(row => row.id === 'FIX-5'));
});

test('a main check holds only its project while observation and discovery continue', async t => {
  const f = await helperFixture(t, epoch);
  const completed = f.lead('one', 'Lead');
  f.threads.set(completed.id, {...completed,status:'idle'});
  let merged = false;
  f.harness.sdk.stub('plugins.callRpc', async () => ({'env-one': {outcome:'available', pullRequest:{number:12, state:merged ? 'merged' : 'open', url:'https://example.invalid/pr/12', updatedAt:new Date(epoch).toISOString(), checks:{state:'passing'}}}}));
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  f.setMainCheck(async () => { enter(); await gate; return {passed:true, logPath:'/scratch/check.log', mergedCommit:'a'.repeat(40), baseCommit:'b'.repeat(40)}; });
  t.after(release);
  await f.harness.behavior.callRpc('autopilot.set', {projectId:'one', status:'on'});
  merged = true;
  await f.board();
  await entered;
  await f.startWatcher();
  const before = f.harness.inspection.sdk.callsTo('projects.list').length;
  const readsBefore = f.harness.inspection.sdk.callsTo('threads.list').filter(([args]) => (args as {projectId:string}).projectId === 'two').length;
  f.projects.push({...f.projects[1], id:'three', name:'New project'});
  for (let i = 0; i < 4; i++) await f.advance(30000);
  assert.ok(f.harness.inspection.sdk.callsTo('projects.list').length >= before + 4, 'discovery keeps its 30-second cycles');
  const readsDuring = f.harness.inspection.sdk.callsTo('threads.list').filter(([args]) => (args as {projectId:string}).projectId === 'two').length;
  assert.ok(readsDuring > readsBefore, 'another project keeps observing its threads');
  assert.ok(f.harness.inspection.sdk.callsTo('threads.list').some(([args]) => (args as {projectId:string}).projectId === 'three'), 'new projects are observed during the check');
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 0, 'the checking project cannot start its next lane');
  release(); await settle();
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 1, 'the local barrier opens after the check passes');
});

test('an Outside spec closed between refreshes still checks its merge across restart', async t => {
  const { makeThreadResponse } = await import('@get-bb/plugin-sdk/testing');
  let closed = false;
  const f = await helperFixture(t, epoch, { issues: () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.filter(node => !closed || !['FIX-5', 'FIX-6'].includes(node.identifier)),
  } } }) });
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-5', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  let merged = false;
  const prs = async () => ({ 'outside-env': { outcome: 'available', pullRequest: {
    number: 17, state: merged ? 'merged' : 'open', url: 'https://example.invalid/pr/17',
    updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } } });
  f.harness.sdk.stub('plugins.callRpc', prs);
  const open = await f.board();
  assert.equal(open.lanes[0].outside, true);
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on', laneLimit: 1 });
  await settle();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  let checks = 0;
  f.setMainCheck(async () => { checks++; await gate; return { passed: false, logPath: '/scratch/closed-outside.log', mergedCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) }; });
  closed = true; merged = true;
  await f.reload();
  f.harness.sdk.stub('plugins.callRpc', prs);
  const reading = f.board();
  await settle();
  assert.equal(checks, 1, 'a closed spec missing from the tracker must not hide its merged PR after restart');
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 0, 'no start before the merge check finishes');
  release();
  await reading;
  await settle();
  const board = await f.board();
  assert.equal(board.autopilot?.status, 'paused');
  assert.equal(board.autopilot?.pauseReason, 'Main fails its quick check');
  assert.equal(board.autopilot?.consecutiveStops, 0);
  assert.deepEqual(board.autopilot?.pauseLog, { hostId: 'host', path: '/scratch/closed-outside.log' });
  assert.equal(f.threads.get('outside')?.status, 'active');
  assert.equal(f.sends().length, 0);
  await f.board();
  await f.reload();
  f.harness.sdk.stub('plugins.callRpc', prs);
  await f.board();
  assert.equal(checks, 1, 'refresh and restart never replay the checked merge');
  assert.equal(f.harness.inspection.sdk.callsTo('plugins.callRpc').length, 0, 'retired Outside environments need no historical PR scan');
});
