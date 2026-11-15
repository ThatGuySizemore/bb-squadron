import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { helperFixture, settle } from './fixtures/helper-plugin.js';
import type { PullRequestRow } from '../lib/pull-requests.js';

const epoch = Date.parse('2026-11-14T12:00:00Z');

test('a hidden merge recovered once during another main check gets checked without expiry', async t => {
  const f = await helperFixture(t, epoch);
  f.lead('one', 'Lead');
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-1', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  const request = (number: number, state: 'open' | 'merged'): PullRequestRow => ({ outcome: 'available', pullRequest: {
    number, state, url: `https://example.invalid/pr/${number}`, updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } });
  let rows = { 'env-one': request(21, 'open'), 'outside-env': request(22, 'open') };
  let recoveryReads = 0;
  f.harness.sdk.stub('plugins.callRpc', async () => {
    const observed = rows;
    const b = observed['outside-env'];
    if (b.outcome === 'available' && b.pullRequest.state === 'merged') {
      recoveryReads++;
      rows = { ...rows, 'outside-env': { outcome: 'unavailable', message: 'Offline again' } };
    }
    return observed;
  });
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  const checked: number[] = [];
  let active = 0;
  let overlap = false;
  let finishA!: () => void;
  f.setMainCheck(async number => {
    checked.push(number);
    overlap ||= ++active > 1;
    if (number === 21) await new Promise<void>(resolve => { finishA = resolve; });
    active--;
    return { passed: true, logPath: '/scratch/pass.log', mergedCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) };
  });
  rows = { 'env-one': request(21, 'merged'), 'outside-env': { outcome: 'unavailable', message: 'Offline' } };
  await f.board(); await settle();
  assert.deepEqual(checked, [21]);
  f.threads.delete('outside');
  await f.advance(29 * 60_000);
  rows = { 'env-one': request(21, 'merged'), 'outside-env': request(22, 'merged') };
  const recovered = await f.board();
  assert.ok(!recovered.lanes.some(lane => lane.outside), 'B is hidden when its single recovery read arrives');
  assert.equal(recoveryReads, 1, 'B is readable on exactly one PR observation');
  await f.advance(2 * 60_000);
  finishA(); await settle();
  await f.board(); await settle();
  assert.deepEqual(checked, [21, 22], 'B must use its one successful observation, even after the original deadline');
  assert.equal(overlap, false, 'the host checks must remain serialized');
  assert.equal((await f.board()).autopilot?.checkingMain, undefined);
  assert.ok(!(await f.harness.behavior.runCli(['needs'], { projectId: 'one' })).stdout.includes('Autopilot carried on'));
});

test('a single recovery read survives host failure and reload, then applies the normal failure brake', async t => {
  const f = await helperFixture(t, epoch);
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-5', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  let rows: Record<string, PullRequestRow> = {};
  f.harness.sdk.stub('plugins.callRpc', async () => rows);
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  await f.board();
  f.threads.delete('outside');
  await f.advance(29 * 60_000);
  rows = { 'outside-env': { outcome: 'available', pullRequest: {
    number: 24, state: 'merged', url: 'https://example.invalid/pr/24', updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } } };
  const checked: number[] = [];
  f.setMainCheck(async number => {
    checked.push(number);
    if (checked.length === 1) throw new Error('Host offline');
    return { passed: false, logPath: '/scratch/retry.log', mergedCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) };
  });
  await f.board(); await settle();
  rows = {};
  await f.board(); await settle();
  assert.deepEqual(checked, [24], 'the normal retry delay still prevents an immediate retry');
  await f.reload();
  f.harness.sdk.stub('plugins.callRpc', async () => rows);
  await f.advance(2 * 60_000);
  await f.board(); await settle();
  const board = await f.board();
  assert.deepEqual(checked, [24, 24], 'the pending normal check survives losing all PR rows and reloading');
  assert.equal(board.autopilot?.status, 'paused');
  assert.equal(board.autopilot?.pauseReason, 'Main fails its quick check');
  assert.deepEqual(board.autopilot?.pauseLog, { hostId: 'host', path: '/scratch/retry.log' });
  assert.ok(!(await f.harness.behavior.runCli(['needs'], { projectId: 'one' })).stdout.includes('Autopilot carried on'));
});

test('an unreadable merge that disappears expires at 30 minutes across reload and reports once', async t => {
  const f = await helperFixture(t, epoch);
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-5', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  let rows: Record<string, PullRequestRow> = { 'outside-env': { outcome: 'available', pullRequest: {
    number: 17, state: 'open', url: 'https://example.invalid/pr/17', updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } } };
  const stub = () => f.harness.sdk.stub('plugins.callRpc', async () => rows);
  stub();
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on', laneLimit: 1 });
  rows = { 'outside-env': { outcome: 'unavailable', message: 'Offline' } };
  await f.board();
  await f.startWatcher();
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 0, 'unreadable evidence holds automatic starts');
  await f.advance(20 * 60_000);
  await f.reload(); stub();
  f.threads.delete('outside');
  rows = {};
  await f.advance(10 * 60_000 - 1);
  await f.board();
  let needs = await f.harness.behavior.runCli(['needs'], { projectId: 'one' });
  assert.ok(!needs.stdout.includes('Autopilot carried on'));
  await f.startWatcher();
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 0);
  await f.advance(1);
  await f.board(); await settle();
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 1, 'starts resume at the original deadline');
  needs = await f.harness.behavior.runCli(['needs'], { projectId: 'one' });
  assert.equal(needs.stdout.split("Couldn't check main after PR #17; Autopilot carried on.").length - 1, 1);
  await f.advance(2 * 60_000);
  assert.equal(f.sends().filter(send => send.input[0].text.includes('Autopilot carried on')).length, 1);
  await f.reload(); stub();
  await f.startWatcher(); await f.board();
  await f.advance(2 * 60_000);
  needs = await f.harness.behavior.runCli(['needs'], { projectId: 'one' });
  assert.equal(needs.stdout.split("Couldn't check main after PR #17; Autopilot carried on.").length - 1, 1);
  assert.equal(f.sends().filter(send => send.input[0].text.includes('Autopilot carried on')).length, 0, 'reload never repeats the notification');
});

test('a missing baseline PR row followed by immediate disappearance expires with the spec identifier', async t => {
  const f = await helperFixture(t, epoch);
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-5', projectId: 'one', environmentId: 'opaque-environment', status: 'active' }));
  f.harness.sdk.stub('plugins.callRpc', async () => ({}));
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  f.threads.delete('outside');
  await f.board();
  await f.advance(30 * 60_000);
  const needs = await f.harness.behavior.runCli(['needs'], { projectId: 'one' });
  assert.equal(needs.stdout.split("Couldn't check main after FIX-5; Autopilot carried on.").length - 1, 1);
  assert.ok(!needs.stdout.includes('opaque-environment'));
});

for (const name of ['PR #23', 'FIX-5']) {
  test(`first-candidate stored state keeps its deadline and ${name} notice across reload`, async t => {
    const f = await helperFixture(t, epoch, {}, undefined, undefined, {
      status: 'on', laneLimit: 4, consecutiveStops: 0, pauseReason: null,
      pendingOutsideEnvironments: ['old-environment'], unreadableSince: { 'old-environment': epoch - 29 * 60_000 },
      outsideNames: { 'old-environment': name },
    });
    f.harness.sdk.stub('plugins.callRpc', async () => ({}));
    assert.equal((await f.board()).autopilot?.checkingMain, true);
    await f.reload();
    f.harness.sdk.stub('plugins.callRpc', async () => ({}));
    await f.advance(60_000);
    const board = await f.board();
    assert.equal(board.autopilot?.status, 'on');
    assert.equal(board.autopilot?.laneLimit, 4);
    const needs = await f.harness.behavior.runCli(['needs'], { projectId: 'one' });
    assert.equal(needs.stdout.split(`Couldn't check main after ${name}; Autopilot carried on.`).length - 1, 1);
  });
}

test('recovery before timeout runs the normal main check and retains its unavailable retry and failure brake', async t => {
  const f = await helperFixture(t, epoch);
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-5', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  let row: PullRequestRow = { outcome: 'available', pullRequest: {
    number: 18, state: 'open', url: 'https://example.invalid/pr/18', updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } };
  f.harness.sdk.stub('plugins.callRpc', async () => ({ 'outside-env': row }));
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  row = { outcome: 'unavailable', message: 'Offline' };
  await f.board();
  await f.advance(29 * 60_000);
  f.threads.delete('outside');
  row = { outcome: 'available', pullRequest: {
    number: 18, state: 'merged', url: 'https://example.invalid/pr/18', updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } };
  let checks = 0;
  let unavailable = true;
  f.setMainCheck(async () => {
    checks++;
    if (unavailable) throw new Error('Host offline');
    return { passed: false, logPath: '/scratch/recovered.log', mergedCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) };
  });
  await f.board(); await settle();
  assert.equal(checks, 1);
  await f.advance(31 * 60_000);
  await f.startWatcher();
  assert.equal(checks, 2, 'readable PR evidence retains host retries past the unreadable timeout');
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 0);
  assert.ok(!(await f.harness.behavior.runCli(['needs'], { projectId: 'one' })).stdout.includes('Autopilot carried on'));
  unavailable = false;
  await f.advance(30_000);
  const board = await f.board();
  assert.equal(checks, 3);
  assert.equal(board.autopilot?.status, 'paused');
  assert.equal(board.autopilot?.pauseReason, 'Main fails its quick check');
  assert.deepEqual(board.autopilot?.pauseLog, { hostId: 'host', path: '/scratch/recovered.log' });
  assert.ok(!(await f.harness.behavior.runCli(['needs'], { projectId: 'one' })).stdout.includes('Autopilot carried on'));
});

test('a passing recovered merge opens automatic starts without an expiry item', async t => {
  const f = await helperFixture(t, epoch);
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-5', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  let row: PullRequestRow = { outcome: 'available', pullRequest: {
    number: 19, state: 'open', url: 'https://example.invalid/pr/19', updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } };
  f.harness.sdk.stub('plugins.callRpc', async () => ({ 'outside-env': row }));
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on', laneLimit: 1 });
  row = { outcome: 'unavailable', message: 'Offline' };
  await f.board();
  await f.advance(29 * 60_000);
  let checks = 0;
  f.setMainCheck(async () => { checks++; return { passed: true, logPath: '/scratch/pass.log', mergedCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) }; });
  f.threads.delete('outside');
  row = { outcome: 'available', pullRequest: {
    number: 19, state: 'merged', url: 'https://example.invalid/pr/19', updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } };
  await f.startWatcher();
  assert.equal(checks, 1);
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 1);
  await f.advance(2 * 60_000);
  assert.ok(!(await f.harness.behavior.runCli(['needs'], { projectId: 'one' })).stdout.includes('Autopilot carried on'));
});

test('Off and On discard a disappeared unreadable merge without waiting for expiry', async t => {
  const f = await helperFixture(t, epoch);
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-5', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  let rows: Record<string, PullRequestRow> = {};
  f.harness.sdk.stub('plugins.callRpc', async () => rows);
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on', laneLimit: 1 });
  rows = { 'outside-env': { outcome: 'unavailable', message: 'Offline' } };
  await f.board();
  f.threads.delete('outside'); rows = {};
  await f.startWatcher();
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 0);
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'off' });
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  await settle();
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 1);
  await f.advance(31 * 60_000);
  assert.ok(!(await f.harness.behavior.runCli(['needs'], { projectId: 'one' })).stdout.includes('Autopilot carried on'));
});

test('a still-visible unreadable merge with no known PR number reports its spec once', async t => {
  const f = await helperFixture(t, epoch);
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-5', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  const stub = () => f.harness.sdk.stub('plugins.callRpc', async () => ({ 'outside-env': { outcome: 'unavailable', message: 'Offline' } }));
  stub();
  await f.board();
  await f.advance(30 * 60_000);
  let needs = await f.harness.behavior.runCli(['needs'], { projectId: 'one' });
  assert.equal(needs.stdout.split("Couldn't check main after FIX-5; Autopilot carried on.").length - 1, 1);
  await f.reload(); stub();
  await f.advance(31 * 60_000);
  await f.board();
  needs = await f.harness.behavior.runCli(['needs'], { projectId: 'one' });
  assert.equal(needs.stdout.split("Couldn't check main after FIX-5; Autopilot carried on.").length - 1, 1);
  assert.equal((await f.board()).autopilot?.checkingMain, undefined, 'a visible source cannot re-add the dropped merge');
});

test('a successful PR read clears the unreadable clock before a later outage', async t => {
  const f = await helperFixture(t, epoch);
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-5', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  const readable: PullRequestRow = { outcome: 'available', pullRequest: {
    number: 20, state: 'open', url: 'https://example.invalid/pr/20', updatedAt: new Date(epoch).toISOString(), checks: { state: 'passing' },
  } };
  let row: PullRequestRow = readable;
  const stub = () => f.harness.sdk.stub('plugins.callRpc', async () => ({ 'outside-env': row }));
  stub();
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on' });
  row = { outcome: 'unavailable', message: 'Offline' };
  await f.board();
  await f.advance(29 * 60_000);
  row = readable;
  assert.equal((await f.board()).autopilot?.checkingMain, undefined);
  row = { outcome: 'unavailable', message: 'Offline again' };
  await f.board();
  await f.reload(); stub();
  await f.advance(60_000);
  assert.equal((await f.board()).autopilot?.checkingMain, true);
  assert.ok(!(await f.harness.behavior.runCli(['needs'], { projectId: 'one' })).stdout.includes('Autopilot carried on'));
  await f.advance(29 * 60_000);
  const needs = await f.harness.behavior.runCli(['needs'], { projectId: 'one' });
  assert.equal(needs.stdout.split("Couldn't check main after PR #20; Autopilot carried on.").length - 1, 1);
});

test('an explicit absent PR is readable evidence and never delays another Ready spec', async t => {
  const f = await helperFixture(t, epoch);
  f.threads.set('outside', makeThreadResponse({ id: 'outside', title: 'Lead FIX-1', projectId: 'one', environmentId: 'outside-env', status: 'active' }));
  f.harness.sdk.stub('plugins.callRpc', async () => ({ 'outside-env': { outcome: 'absent' } }));
  await f.harness.behavior.callRpc('autopilot.set', { projectId: 'one', status: 'on', laneLimit: 1 });
  await f.startWatcher();
  assert.equal(f.harness.inspection.sdk.callsTo('threads.spawn').length, 1, 'an Outside lane without a PR cannot block the Ready spec');
  await f.advance(31 * 60_000);
  assert.ok(!(await f.harness.behavior.runCli(['needs'], { projectId: 'one' })).stdout.includes('Autopilot carried on'));
});
