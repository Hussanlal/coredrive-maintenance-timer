import { request as httpsRequest } from 'node:https';

const paths = new Set(['/api/maintenance/purge', '/api/maintenance/watchdog', '/api/contact/status']);

/** Fixed verified HTTPS, explicit server headers and a bounded complete response. */
export function timerFetch(address, options, request = httpsRequest) {
  const url = new URL(address);
  if (url.origin !== 'https://coredrive.co.uk' || !paths.has(url.pathname)
      || url.search || url.hash || url.username || url.password)
    throw new Error('invalid-destination');
  const status = url.pathname === '/api/contact/status';
  if ((options.method || 'GET') !== (status ? 'GET' : 'POST')
      || (!status && (typeof options.body !== 'string' || Buffer.byteLength(options.body) > 512
        || !/^Bearer [a-f0-9]{64}$/.test(options.headers?.Authorization || '')
        || options.headers?.['Content-Type'] !== 'application/json')))
    throw new Error('invalid-request');
  return new Promise((resolve, reject) => {
    let outgoing; let incoming; let settled = false;
    const signal = options.signal;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      if (error) { incoming?.destroy(); outgoing?.destroy(); reject(error); }
      else resolve(value);
    };
    const abort = () => finish(new DOMException('Request aborted', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      outgoing = request(url, { method: status ? 'GET' : 'POST',
        headers: status ? {} : {
          Authorization: options.headers.Authorization,
          'Content-Type': options.headers['Content-Type'],
        } }, (response) => {
        incoming = response;
        const code = response.statusCode;
        if (!Number.isInteger(code) || code < 200 || code > 599) {
          finish(new Error('invalid-response')); return;
        }
        // A known application rejection must not become a retryable body failure.
        if (code !== 200) {
          finish(null, new Response(null, { status: code }));
          response.destroy(); outgoing.destroy(); return;
        }
        const chunks = []; let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2048) finish(new Error('oversized-response'));
          else chunks.push(chunk);
        });
        response.on('error', () => finish(new TypeError('transport-unavailable')));
        response.on('aborted', () => finish(new TypeError('transport-unavailable')));
        response.on('close', () => {
          if (!response.complete) finish(new TypeError('transport-unavailable'));
        });
        response.on('end', () => {
          if (settled) return;
          const bytes = Buffer.concat(chunks);
          finish(null, new Response(bytes, { status: code }));
        });
      });
      outgoing.on('error', () => finish(new TypeError('transport-unavailable')));
      outgoing.on('upgrade', (_response, socket) => {
        socket.destroy(); finish(new Error('invalid-response'));
      });
      outgoing.end(status ? undefined : options.body);
    } catch { finish(new Error('invalid-request')); }
  });
}
