import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperFixture, settle } from './fixtures/helper-plugin.js';

const epoch = Date.parse('2026-11-14T12:00:00Z');

test('board and owner controls finish while main is still checking, without starting lanes', async t => {
  const f = await helperFixture(t, epoch);
  f.lead('one', 'Lead');
  let merged = false;
  f.harness.sdk.stub('plugins.callRpc', async () => ({ 'env-one': { outcome: 'available', pullRequest: {
    number: 12, state: merged ? 'merged' : 'open', url: 'https://example.invalid/pr/12',
    updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } } }));
  let checks = 0;
  f.setMainCheck(async () => {
    checks++;
    await new Promise<void>(resolve => setTimeout(resolve, 60_000));
    return { passed: false, logPath: '/scratch/slow.log', mergedCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) };
  });
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  await settle();
  merged = true;
  let boardDone = false;
  const reading = f.board().then(board => { boardDone = true; return board; });
  await settle();
  assert.equal(checks, 1);
  assert.equal(boardDone, true, 'the board must return before the fake check timer fires');
  assert.equal(((await reading).autopilot as { checkingMain?: boolean })?.checkingMain, true);
  for (const args of [['pause'], ['resume'], ['lanes', '5'], ['on']] ) {
    let done = false;
    const saving = f.harness.behavior.runCli(['autopilot', ...args], { projectId: 'one' }).then(result => { done = true; return result; });
    await settle();
    assert.equal(done, true, `${args[0]} must finish before the fake check timer fires`);
    assert.equal((await saving).exitCode, 0);
  }
  await f.startWatcher();
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 0);
  assert.equal(checks, 1, 'concurrent reads and controls never duplicate the active check');
  await f.advance(60_000);
  const failed = await f.board();
  assert.equal(failed.autopilot?.status, 'paused');
  assert.equal(failed.autopilot?.laneLimit, 5);
  assert.equal((failed.autopilot as { checkingMain?: boolean })?.checkingMain, undefined);
  assert.deepEqual(failed.autopilot?.pauseLog, { hostId: 'host', path: '/scratch/slow.log' });
});

test('switch-on records existing merges, including when the board has never opened; only the next merge checks', async t => {
  const f = await helperFixture(t, epoch);
  const lead = f.lead('one', 'Lead');
  f.threads.set(lead.id, { ...lead, status: 'idle' });
  let number = 12;
  f.harness.sdk.stub('plugins.callRpc', async () => ({ 'env-one': { outcome: 'available', pullRequest: {
    number, state: 'merged', url: `https://example.invalid/pr/${number}`,
    updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } } }));
  let checks = 0;
  f.setMainCheck(async () => { checks++; return { passed: true, logPath: '/scratch/pass.log', mergedCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) }; });
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  await settle();
  assert.equal(checks, 0, 'merges present at switch-on are a baseline, not work to check');
  number = 13;
  await f.board(); await settle();
  assert.equal(checks, 1);
  await f.reload();
  f.harness.sdk.stub('plugins.callRpc', async () => ({ 'env-one': { outcome: 'available', pullRequest: {
    number, state: 'merged', url: `https://example.invalid/pr/${number}`,
    updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } } }));
  await f.board(); await settle();
  assert.equal(checks, 1, 'the baseline and check receipt survive reload');
});

test('switching Off during a failed main check stays Off when the result arrives', async t => {
  const f = await helperFixture(t, epoch);
  f.lead('one', 'Lead');
  let merged = false;
  f.harness.sdk.stub('plugins.callRpc', async () => ({ 'env-one': { outcome: 'available', pullRequest: {
    number: 14, state: merged ? 'merged' : 'open', url: 'https://example.invalid/pr/14',
    updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } } }));
  f.setMainCheck(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 60_000));
    return { passed: false, logPath: '/scratch/late.log', mergedCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) };
  });
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  await settle(); merged = true;
  await f.board(); await settle();
  const saved = await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'off', laneLimit: 6 }) as { status: string };
  assert.equal(saved.status, 'off');
  await f.advance(60_000);
  const state = (await f.board()).autopilot!;
  assert.equal(state.status, 'off');
  assert.equal(state.laneLimit, 6);
  assert.equal(state.pauseReason, null);
});

test('an unavailable main check waits for the next watcher pass and never launches a lane', async t => {
  const f = await helperFixture(t, epoch);
  const lead = f.lead('one', 'Lead');
  f.threads.set(lead.id, { ...lead, status: 'idle' });
  let merged = false;
  f.harness.sdk.stub('plugins.callRpc', async () => ({ 'env-one': { outcome: 'available', pullRequest: {
    number: 15, state: merged ? 'merged' : 'open', url: 'https://example.invalid/pr/15',
    updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } } }));
  let checks = 0;
  f.setMainCheck(async () => {
    checks++;
    // Bound a broken immediate-retry loop so the assertion can report it.
    if (checks > 2) await new Promise<void>(() => {});
    throw new Error('Host unavailable');
  });
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on', laneLimit: 1 });
  merged = true;
  await f.board(); await settle();
  assert.equal(checks, 1, 'a failed host read cannot spin on its own board-changed signal');
  await f.startWatcher();
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 0);
  await f.advance(30_000);
  assert.equal(checks, 2, 'the watcher retries unavailable evidence');
});


test('re-enabling baselines a running check and ignores its late failure', async t => {
  const f = await helperFixture(t, epoch);
  f.lead('one', 'Lead');
  let merged = false;
  f.harness.sdk.stub('plugins.callRpc', async () => ({ 'env-one': { outcome: 'available', pullRequest: {
    number: 16, state: merged ? 'merged' : 'open', url: 'https://example.invalid/pr/16',
    updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } } }));
  let checks = 0;
  f.setMainCheck(async () => {
    checks++;
    await new Promise<void>(resolve => setTimeout(resolve, 60_000));
    return { passed: false, logPath: '/scratch/superseded.log', mergedCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) };
  });
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  merged = true;
  await f.board(); await settle();
  assert.equal(checks, 1);
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'off' });
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  const restarted = await f.board();
  assert.equal(restarted.autopilot?.status, 'on');
  assert.equal(restarted.autopilot?.checkingMain, undefined, 'a starting-point merge no longer holds the new run');
  await f.advance(60_000);
  const current = await f.board();
  assert.equal(current.autopilot?.status, 'on', 'a late failure from the previous run cannot pause the new run');
  assert.equal(current.autopilot?.pauseReason, null);
  assert.equal(checks, 1);
});
