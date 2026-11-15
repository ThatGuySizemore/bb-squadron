import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { needsYou, type Board } from '../lib/board-model.js';
import { workspaceIssues } from './fixtures/board-workspace.js';
import { helperFixture, settle } from './fixtures/helper-plugin.js';

const epoch = Date.parse('2026-11-14T20:00:00Z');

test('reload shows the last complete Linear reading before the first request returns', async t => {
  const f = await helperFixture(t, epoch);
  assert.ok((await f.board()).ready.some(row => row.id === 'FIX-5'));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetch = f.linear.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    await held;
    return fetch(...args);
  });
  await f.reload();
  let board: Board | undefined;
  const reading = f.board().then(value => { board = value; });
  await settle();
  const visibleBeforeRead = board?.ready.some(row => row.id === 'FIX-5');
  const stateBeforeRead = board?.tracker?.state;
  release();
  await reading;
  assert.equal(visibleBeforeRead, true, 'saved issues must be visible while Linear is still pending');
  assert.equal(stateBeforeRead, 'failed', 'a restored reading cannot claim a successful current read');
});

test('a failed read keeps its age and allows Start and planning for fifteen minutes', async t => {
  let failed = false;
  const f = await helperFixture(t, epoch, { issues: () => failed ? Response.json({}, { status: 503 }) : Response.json(workspaceIssues) });
  await f.board();
  failed = true;
  await f.advance(4 * 60_000);
  await f.harness.behavior.callRpc('linear.snapshot', { bbProjectId: 'one' });
  // Opening a hidden board starts a refresh without delaying the saved reading.
  await f.board(); await settle();
  const board = await f.board();
  assert.equal(board.tracker?.syncedAt, epoch);
  assert.equal(board.tracker?.state, 'failed');
  assert.equal(board.ready.find(row => row.id === 'FIX-5')?.startReason, null);
  f.harness.sdk.stub('threads.spawn', async () => makeThreadResponse({ id: 'started', projectId: 'one' }));
  const started = await f.harness.behavior.callRpc('lane.start', { projectId: 'one', specId: 'FIX-5' });
  assert.ok(started);
  const planned = await f.harness.behavior.callRpc('planning.start', { projectId: 'one', issueId: 'FIX-9' });
  assert.ok(planned);
});

test('old readings stop new starts and Autopilot, and a good read opens them again', async t => {
  let failed = false;
  const f = await helperFixture(t, epoch, { issues: () => failed ? Response.json({}, { status: 503 }) : Response.json(workspaceIssues) });
  await f.board();
  f.harness.sdk.stub('threads.spawn', async () => makeThreadResponse({ id: 'automatic', projectId: 'one' }));
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  failed = true;
  await f.advance(15 * 60_000);
  await f.board(); await settle();
  assert.equal((await f.board()).ready.find(row => row.id === 'FIX-5')?.startReason, null, 'fifteen minutes is still usable');
  const beforeExpiry = f.harness.inspection.sdk.callsTo('threads.spawn').length;
  await f.advance(1);
  let board = await f.board();
  assert.match(board.ready.find(row => row.id === 'FIX-5')?.startReason ?? '', /Waiting for Linear; last read 15 min ago/);
  assert.equal(board.autopilot?.status, 'paused');
  assert.ok(!needsYou(board).some(item => item.kind === 'autopilot-paused'), 'a read wait needs no owner Resume');
  assert.match(board.autopilot?.pauseReason ?? '', /Waiting for Linear/);
  await assert.rejects(f.harness.behavior.callRpc('lane.start', { projectId: 'one', specId: 'FIX-5' }), /Waiting for Linear/);
  await f.startWatcher();
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, beforeExpiry);
  failed = false;
  await f.advance(76_000);
  await f.board(); await settle();
  board = await f.board();
  assert.equal(board.tracker?.state, 'current');
  assert.equal(board.autopilot?.status, 'on');
  assert.ok(f.harness.inspection.sdk.callsTo('threads.spawn').length > beforeExpiry, 'Autopilot starts again without owner Resume');
});

test('an old saved reading also appears on reload while Linear is still pending', async t => {
  const f = await helperFixture(t, epoch);
  await f.board();
  await f.advance(22 * 60_000);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetch = f.linear.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => { await held; return fetch(...args); });
  await f.reload();
  let board: Board | undefined;
  const reading = f.board().then(value => { board = value; });
  await settle();
  const before = board;
  release(); await reading;
  assert.ok(before);
  assert.ok(before.ready.some(row => row.id === 'FIX-5'));
  assert.match(before.ready.find(row => row.id === 'FIX-5')?.startReason ?? '', /Waiting for Linear; last read 22 min ago/);
});

test('a changed Scope cannot start work using the old reading', async t => {
  const f = await helperFixture(t, epoch);
  await f.board();
  const { readFileSync } = await import('node:fs');
  f.harness.sdk.stub('files.read', async ({ path }: { path: string }) => {
    const content = readFileSync(path.endsWith('issue-tracker.md') ? 'tests/fixtures/trackers/bb-squadron.md' : 'tests/fixtures/squadron.md', 'utf8')
      .replace('Project: Fixture project', 'Project: Another project');
    return { path, content, contentEncoding: 'utf8', sha256: 'changed', sizeBytes: content.length };
  });
  await f.advance(1_000);
  const board = await f.board();
  assert.ok(!board.ready.some(row => row.id === 'FIX-5'), 'the old Scope is never offered during the new read');
  await assert.rejects(f.harness.behavior.callRpc('lane.start', { projectId: 'one', specId: 'FIX-5' }));
});

test('partial failures never replace the durable complete reading or another project', async t => {
  let mode: 'good' | 'partial' | 'down' = 'good';
  let page = 0;
  const f = await helperFixture(t, epoch, { issues: () => {
    if (mode === 'down' || mode === 'partial' && page++ > 0) return Response.json({}, { status: 503 });
    if (mode === 'partial') return Response.json({ data: { issues: { nodes: [
      { ...workspaceIssues.data.issues.nodes[3], title: 'Incomplete replacement' },
    ], pageInfo: { hasNextPage: true, endCursor: 'next' } } } });
    return Response.json(workspaceIssues);
  } });
  const original = (await f.board()).ready.find(row => row.id === 'FIX-5')?.title;
  await f.advance(60_000);
  mode = 'partial';
  await f.reload();
  await f.board(); await settle();
  assert.equal((await f.board()).ready.find(row => row.id === 'FIX-5')?.title, original);
  mode = 'down';
  await f.reload();
  const recovered = await f.board(); await settle();
  assert.equal(recovered.ready.find(row => row.id === 'FIX-5')?.title, original);
  assert.equal(recovered.tracker?.syncedAt, epoch);
  assert.deepEqual((await f.board('two')).ready, [], 'another project cannot borrow this reading');
});

test('planning an existing issue waits when its Linear reading is too old', async t => {
  let failed = false;
  const f = await helperFixture(t, epoch, { issues: () => failed ? Response.json({}, { status: 503 }) : Response.json(workspaceIssues) });
  await f.board();
  failed = true;
  await f.advance(16 * 60_000);
  await assert.rejects(f.harness.behavior.callRpc('planning.start', { projectId: 'one', issueId: 'FIX-9' }), /Waiting for Linear/);
});

test('Autopilot can be enabled from a recent saved reading during a Linear outage', async t => {
  let failed = false;
  const f = await helperFixture(t, epoch, { issues: () => failed ? Response.json({}, { status: 503 }) : Response.json(workspaceIssues) });
  await f.board();
  failed = true;
  await f.advance(4 * 60_000);
  await f.reload();
  f.harness.sdk.stub('threads.spawn', async () => makeThreadResponse({ id: 'automatic', projectId: 'one' }));
  await f.board(); await settle();
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  await f.startWatcher();
  assert.ok(f.harness.inspection.sdk.callsTo('threads.spawn').length > 0);
});

test('the first board read with no saved reading performs one complete Linear read', async t => {
  const f = await helperFixture(t, epoch);
  await f.board(); await settle();
  assert.equal(f.linear.operations.filter(name => name === 'SquadronIssues' || name === 'SquadronDelta').length, 1);
});

test('recent saved readings retain the two-stopped-lanes brake during a Linear outage', async t => {
  let failed = false;
  const spec = workspaceIssues.data.issues.nodes.find(node => node.identifier === 'FIX-5')!;
  const ticket = workspaceIssues.data.issues.nodes.find(node => node.identifier === 'FIX-6')!;
  const issues = { data: { issues: { ...workspaceIssues.data.issues, nodes: [
    ...workspaceIssues.data.issues.nodes,
    { ...spec, id: 'fix-20', identifier: 'FIX-20' },
    { ...ticket, id: 'fix-21', identifier: 'FIX-21', parent: { id: 'fix-20' } },
  ] } } };
  const f = await helperFixture(t, epoch, { issues: () => failed ? Response.json({}, { status: 503 }) : Response.json(issues) });
  await f.board();
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on', laneLimit: 1 });
  failed = true;
  await f.advance(60_000);
  await f.reload();
  for (const id of ['first', 'second']) f.threads.set(id, makeThreadResponse({ id, projectId: 'one', status: 'error', createdAt: epoch }));
  f.harness.sdk.stub('threads.getPluginMetadata', async ({ threadId }: { threadId: string }) =>
    threadId === 'first' || threadId === 'second' ? { role: 'lead', specId: threadId === 'first' ? 'fix-1' : 'fix-5' } : {});
  f.harness.sdk.stub('threads.spawn', async () => makeThreadResponse({ id: 'unwanted', projectId: 'one' }));
  await f.board(); await settle();
  await f.startWatcher();
  const board = await f.board();
  assert.equal(board.autopilot?.status, 'paused');
  assert.equal(board.autopilot?.pauseReason, 'Two lanes in a row stopped');
  assert.equal(board.autopilot?.consecutiveStops, 2);
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 0, 'no third lane starts during the outage');
});

test('recent saved readings still check fresh merges and retain the main-check brake', async t => {
  let failed = false;
  const f = await helperFixture(t, epoch, { issues: () => failed ? Response.json({}, { status: 503 }) : Response.json(workspaceIssues) });
  await f.board();
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on', laneLimit: 1 });
  failed = true;
  await f.advance(60_000);
  await f.reload();
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-5', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  f.harness.sdk.stub('plugins.callRpc', async () => ({ 'outside-env': { outcome: 'available', pullRequest: {
    number: 29, state: 'merged', url: 'https://example.invalid/pr/29', updatedAt: new Date(epoch + 60_000).toISOString(), checks: { state: 'passing' },
  } } }));
  f.harness.sdk.stub('threads.spawn', async () => makeThreadResponse({ id: 'unwanted', projectId: 'one' }));
  let checks = 0;
  f.setMainCheck(async () => { checks++; return { passed: false, logPath: '/scratch/failure.log', mergedCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) }; });
  await f.board(); await settle();
  await f.startWatcher();
  const board = await f.board();
  assert.equal(checks, 1, 'fresh PR evidence still runs the main check while Linear is down');
  assert.equal(board.autopilot?.status, 'paused');
  assert.equal(board.autopilot?.pauseReason, 'Main fails its quick check');
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 0);
});
