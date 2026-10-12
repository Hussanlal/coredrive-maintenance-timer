import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const origin = 'https://coredrive.co.uk';
const fields = ['version', 'operation', 'run', 'attempt', 'issuedAt', 'nonce',
  'completed', 'startedAt', 'finishedAt', 'releaseSHA256', 'runnerSHA256'];
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Validate complete, fresh, request-bound and source-bound success; never print raw replies. */
export function validate(value, operation, request, expected, now = Math.floor(Date.now() / 1000)) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))
      || value.version !== 1 || value.operation !== operation || value.completed !== true
      || Object.keys(request).some((key) => value[key] !== request[key])
      || !Number.isInteger(value.startedAt) || !Number.isInteger(value.finishedAt)
      || value.startedAt < request.issuedAt - 120 || value.startedAt > request.issuedAt + 90
      || value.finishedAt < value.startedAt || value.finishedAt - value.startedAt > 60
      || value.finishedAt > now + 5 || now - value.finishedAt > 120
      || !digest(value.releaseSHA256) || !digest(value.runnerSHA256)
      || value.releaseSHA256 !== expected.releaseSHA256 || value.runnerSHA256 !== expected.runnerSHA256)
    throw new Error('invalid-completion');
  return true;
}

/** Bound even successful response bodies rather than trusting Content-Length. */
async function json(response) {
  if (!response.body) throw new Error('missing-response');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2048) throw new Error('oversized-response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** One nonce survives network retries, so a lost response cannot repeat the operation. */
export async function call(operation, context, io = {}) {
  if (!['purge', 'watchdog'].includes(operation) || !digest(context.key)
      || !/^[1-9][0-9]{0,19}$/.test(context.run) || !Number.isInteger(context.attempt)
      || context.attempt < 1 || context.attempt > 20 || !digest(context.expected?.releaseSHA256)
      || !digest(context.expected?.runnerSHA256)) throw new Error('invalid-configuration');
  const request = { run: context.run, attempt: context.attempt,
    issuedAt: Math.floor(Date.now() / 1000), nonce: randomBytes(32).toString('hex') };
  const fetcher = io.fetch || globalThis.fetch;
  const sleep = io.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let index = 0; index < 3; index++) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetcher(origin + '/api/maintenance/' + operation, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + context.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error('operation-unavailable');
      }
      return validate(await json(response), operation, request, context.expected);
    } catch (error) {
      // Retry only a network/abort failure. Invalid/auth/application replies fail closed.
      if (!(error instanceof TypeError) && error?.name !== 'AbortError') throw new Error('operation-failed');
      if (index === 2) throw new Error('transport-unavailable');
    } finally { clearTimeout(deadline); }
    await sleep((index + 1) * 2000);
  }
  throw new Error('transport-unavailable');
}

/** Always evaluate the watchdog even if cleanup fails; caller secrets never enter output. */
export async function maintain(environment = process.env, io = {}) {
  let passed = true;
  for (const operation of ['purge', 'watchdog']) {
    try {
      await call(operation, { key: environment.COREDRIVE_MAINTENANCE_KEY,
        run: environment.GITHUB_RUN_ID, attempt: Number(environment.GITHUB_RUN_ATTEMPT),
        expected: { releaseSHA256: environment.RELEASE_INVENTORY_SHA256,
          runnerSHA256: environment.RUNNER_SOURCE_SHA256 } }, io);
      (io.log || console.log)(operation + ': passed');
    } catch {
      passed = false;
      (io.log || console.log)(operation + ': failed; inspect private host metadata');
    }
  }
  return passed;
}

/** A separate no-secret consumer detects stale or failed readiness when it runs. */
export async function health() {
  const response = await fetch(origin + '/api/contact/status', {
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const value = await json(response);
  if (response.status !== 200 || !value || Object.keys(value).length !== 1 || value.available !== true)
    throw new Error('readiness-unavailable');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--health') {
      await health(); console.log('Readiness: passed');
    } else if (process.argv.length === 2) {
      if (!(await maintain())) process.exitCode = 1;
    } else throw new Error('invalid-mode');
  } catch { console.log('Readiness or timer unavailable; no request data recorded'); process.exitCode = 1; }
}
