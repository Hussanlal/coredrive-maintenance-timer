import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { timerFetch } from '../transport.mjs';
import { call } from '../timer.mjs';
import { certificate, fixture } from './https-fixture.mjs';

const cert = certificate();
after(cert.cleanup);
const key = 'a'.repeat(64);
const expected = { releaseSHA256: 'b'.repeat(64), runnerSHA256: 'c'.repeat(64) };
const address = 'https://coredrive.co.uk/api/maintenance/purge';
const options = (signal) => ({ method: 'POST', redirect: 'error', signal,
  headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}' });

test('actual verified HTTPS reaches browser-rejecting maintenance with exact server headers', async (t) => {
  let calls = 0;
  const request = await fixture(t, (incoming, response) => {
    calls++;
    assert.deepEqual(Object.keys(incoming.headers).sort(), ['authorization', 'connection', 'content-length', 'content-type', 'host']);
    assert.equal(incoming.headers.authorization, 'Bearer ' + key);
    assert.equal(incoming.headers['content-type'], 'application/json');
    assert.equal(incoming.url, '/api/maintenance/purge');
    let body = '';
    incoming.on('data', (value) => { body += value; });
    incoming.on('end', () => {
      const frame = JSON.parse(body);
      response.end(JSON.stringify({ version: 1, operation: 'purge', ...frame, completed: true,
        startedAt: frame.issuedAt, finishedAt: frame.issuedAt, ...expected }));
    });
  }, cert);
  await call('purge', { key, run: '123456', attempt: 1, expected }, {
    fetch: (url, settings) => timerFetch(url, settings, request),
  });
  assert.equal(calls, 1);
});

test('untrusted certificates and wrong hostnames fail verified TLS without HTTP', async (t) => {
  let calls = 0;
  for (const [trusted, hostname] of [[false, 'coredrive.co.uk'], [true, 'wrong.invalid']]) {
    const request = await fixture(t, (_q, r) => { calls++; r.end('{}'); }, cert, trusted, hostname);
    await assert.rejects(timerFetch(address, options(), request), TypeError);
  }
  assert.equal(calls, 0);
});

test('redirects and HTTP rejections stay non-retryable responses; no redirect is followed', async (t) => {
  for (const code of [302, 403, 429, 503]) {
    let calls = 0;
    const request = await fixture(t, (_q, response) => {
      calls++; response.writeHead(code, { Location: 'https://unrelated.invalid/' }); response.end('{}');
    }, cert);
    await assert.rejects(call('purge', { key, run: '123456', attempt: 1, expected }, {
      fetch: (url, settings) => timerFetch(url, settings, request), sleep: async () => {},
    }), /operation-failed/);
    assert.equal(calls, 1);
  }
});

test('response bodies stop at 2048 bytes without retrying overflow', async (t) => {
  let calls = 0;
  const request = await fixture(t, (_q, response) => { calls++; response.end('x'.repeat(2049)); }, cert);
  await assert.rejects(call('purge', { key, run: '123456', attempt: 1, expected }, {
    fetch: (url, settings) => timerFetch(url, settings, request), sleep: async () => {},
  }), /operation-failed/);
  assert.equal(calls, 1);
});

test('known HTTP rejection is not retried when its body stalls or disconnects', { timeout: 2000 }, async (t) => {
  for (const code of [302, 403, 429, 503]) {
    for (const disconnect of [false, true]) {
      let calls = 0;
      const request = await fixture(t, (_q, response) => {
        calls++; response.writeHead(code, { 'Content-Length': '100' }); response.write('{');
        response.flushHeaders();
        if (disconnect) setImmediate(() => response.destroy());
      }, cert);
      await assert.rejects(call('purge', { key, run: '123456', attempt: 1, expected }, {
        fetch: (url, settings) => timerFetch(url, settings, request), sleep: async () => {},
      }), /operation-failed/);
      assert.equal(calls, 1);
    }
  }
});

test('abort covers waiting for headers and a partially delivered stalled body', async (t) => {
  for (const partial of [false, true]) {
    let closed;
    const disconnected = new Promise((resolve) => { closed = resolve; });
    const request = await fixture(t, (incoming, response) => {
      response.on('close', closed);
      if (partial) { response.writeHead(200); response.write('{'); }
    }, cert);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(timerFetch(address, options(controller.signal), request), { name: 'AbortError' });
      await disconnected;
    } finally { clearTimeout(timeout); }
  }
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(timerFetch(address, options(controller.signal), () => { called = true; }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('connection loss retries only the original nonce and frame', async (t) => {
  const bodies = [];
  const request = await fixture(t, (incoming, response) => {
    let body = ''; incoming.on('data', (value) => { body += value; });
    incoming.on('end', () => {
      bodies.push(body);
      if (bodies.length === 1) { incoming.socket.destroy(); return; }
      const frame = JSON.parse(body);
      response.end(JSON.stringify({ version: 1, operation: 'purge', ...frame, completed: true,
        startedAt: frame.issuedAt, finishedAt: frame.issuedAt, ...expected }));
    });
  }, cert);
  await call('purge', { key, run: '123456', attempt: 1, expected }, {
    fetch: (url, settings) => timerFetch(url, settings, request), sleep: async () => {},
  });
  assert.equal(bodies.length, 2); assert.equal(new Set(bodies).size, 1);
});

test('fixed destination, method, bearer and frame limits reject before networking', () => {
  for (const url of ['http://coredrive.co.uk/api/maintenance/purge', address + '?x=1',
    'https://unrelated.invalid/api/maintenance/purge', 'https://coredrive.co.uk/api/export'])
    assert.throws(() => timerFetch(url, options()));
  for (const delta of [{ method: 'GET' }, { body: 'x'.repeat(513) }, { headers: {} }])
    assert.throws(() => timerFetch(address, { ...options(), ...delta }));
});

test('readiness is a bounded GET without credentials or browser metadata', async (t) => {
  const request = await fixture(t, (incoming, response) => {
    assert.equal(incoming.method, 'GET');
    assert.equal(incoming.url, '/api/contact/status');
    assert.deepEqual(Object.keys(incoming.headers).sort(), ['connection', 'host']);
    response.end('{"available":true}');
  }, cert);
  const response = await timerFetch('https://coredrive.co.uk/api/contact/status', {}, request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: true });
});

test('the exact 2048-byte boundary is accepted and an incomplete body is a network failure', async (t) => {
  const exact = await fixture(t, (_q, response) => response.end('x'.repeat(2048)), cert);
  assert.equal((await (await timerFetch(address, options(), exact)).text()).length, 2048);
  const truncated = await fixture(t, (_q, response) => {
    response.writeHead(200, { 'Content-Length': '100' }); response.write('{');
    response.flushHeaders(); setImmediate(() => response.destroy());
  }, cert);
  await assert.rejects(timerFetch(address, options(), truncated), TypeError);
});
