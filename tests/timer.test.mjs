import test from 'node:test';
import assert from 'node:assert/strict';
import { call, maintain, validate } from '../timer.mjs';

const key = 'a'.repeat(64);
const expected = { releaseSHA256: 'b'.repeat(64), runnerSHA256: 'c'.repeat(64) };
const request = { run: '123456', attempt: 1, issuedAt: Math.floor(Date.now() / 1000), nonce: 'd'.repeat(64) };
const receipt = { version: 1, operation: 'purge', ...request, completed: true,
  startedAt: request.issuedAt, finishedAt: request.issuedAt, ...expected };

test('only exact source, nonce, run and fresh completion counts as successful maintenance', () => {
  assert.equal(validate(receipt, 'purge', request, expected), true);
  for (const delta of [{ completed: false }, { operation: 'watchdog' }, { nonce: 'e'.repeat(64) },
    { run: '999' }, { releaseSHA256: 'f'.repeat(64) }, { runnerSHA256: 'f'.repeat(64) },
    { finishedAt: request.issuedAt + 90 }, { startedAt: request.issuedAt - 121 }, { extra: 'secret' }])
    assert.throws(() => validate({ ...receipt, ...delta }, 'purge', request, expected));
  assert.throws(() => validate(receipt, 'purge', request, expected, request.issuedAt + 121));
});

test('network retries reuse a nonce and cannot redirect or select another host/operation', async () => {
  const bodies = []; let calls = 0;
  await call('purge', { key, run: '123456', attempt: 1, expected }, {
    sleep: async () => {},
    fetch: async (url, options) => {
      assert.equal(url, 'https://coredrive.co.uk/api/maintenance/purge');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer ' + key);
      bodies.push(options.body); calls++;
      if (calls < 3) throw new TypeError('PRIVATE transport diagnostics must not be logged');
      const data = JSON.parse(options.body);
      return new Response(JSON.stringify({ ...receipt, ...data, startedAt: data.issuedAt, finishedAt: data.issuedAt }));
    },
  });
  assert.equal(calls, 3); assert.equal(new Set(bodies).size, 1);
  await assert.rejects(call('export', { key, run: '123456', attempt: 1, expected }));
});

test('watchdog is attempted after cleanup failure; logs exclude secrets and raw replies', async () => {
  const logs = []; const modes = [];
  const passed = await maintain({ COREDRIVE_MAINTENANCE_KEY: key, GITHUB_RUN_ID: '123456',
    GITHUB_RUN_ATTEMPT: '1', RELEASE_INVENTORY_SHA256: expected.releaseSHA256, RUNNER_SOURCE_SHA256: expected.runnerSHA256 }, {
    log: (line) => logs.push(line), sleep: async () => {},
    fetch: async (url, options) => {
      const operation = url.endsWith('watchdog') ? 'watchdog' : 'purge'; modes.push(operation);
      if (operation === 'purge') return new Response('PRIVATE_RAW_REPLY', { status: 503 });
      const data = JSON.parse(options.body);
      return new Response(JSON.stringify({ ...receipt, ...data, operation, startedAt: data.issuedAt, finishedAt: data.issuedAt }));
    },
  });
  assert.equal(passed, false); assert.deepEqual(modes, ['purge', 'watchdog']);
  assert.equal(logs.length, 2); assert.doesNotMatch(logs.join('\n'), /PRIVATE|aaaa/);
});

test('oversized, replayed, redirected and failed responses cannot count as success', async () => {
  for (const response of [new Response('x'.repeat(2049)), new Response(JSON.stringify(receipt)),
    new Response('{}', { status: 302 }), new Response('{}', { status: 429 })])
    await assert.rejects(call('purge', { key, run: '123456', attempt: 1, expected }, { fetch: async () => response }));
});
