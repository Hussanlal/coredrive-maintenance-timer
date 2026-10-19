import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Disposable test-only certificate; clients still verify both trust and hostname. */
export function certificate() {
  const folder = mkdtempSync(path.join(tmpdir(), 'coredrive-timer-tls-'));
  const config = path.join(folder, 'certificate.conf');
  writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n'
    + '[dn]\nCN=coredrive.co.uk\n[ext]\nsubjectAltName=DNS:coredrive.co.uk\nbasicConstraints=CA:TRUE\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(folder, 'key.pem'), '-out', path.join(folder, 'cert.pem'), '-config', config],
  { stdio: 'ignore' });
  return { key: readFileSync(path.join(folder, 'key.pem')), cert: readFileSync(path.join(folder, 'cert.pem')),
    cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

/** Connect only the injected test transport to loopback, retaining verified TLS. */
export async function fixture(t, handler, cert, trusted = true, servername = 'coredrive.co.uk') {
  const server = https.createServer(cert, handler);
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return (url, options, callback) => https.request(url, { ...options,
    hostname: '127.0.0.1', port: server.address().port, servername,
    ...(trusted ? { ca: cert.cert } : {}), agent: false }, callback);
}
