import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface WindowEntry {
  windowStart: number;
  count: number;
}

const windows = new Map<string, WindowEntry>();
const port = Number(process.env.FORGER_CONTROL_PLANE_PORT ?? 8790);
const token = process.env.FORGER_CONTROL_PLANE_TOKEN?.trim() ?? '';
const auditRoot = resolve(process.env.FORGER_CONTROL_AUDIT_ROOT ?? '.forger-control-plane/audit');
const maxBodyBytes = Number(process.env.FORGER_CONTROL_MAX_BODY_BYTES ?? 64 * 1024);

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function authorized(req: IncomingMessage): boolean {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maxBodyBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_JSON_OBJECT');
  return parsed as Record<string, unknown>;
}

function rateLimit(body: Record<string, unknown>): { allowed: boolean; remaining: number; resetAt: number } {
  const scope = String(body.scope ?? '');
  const limit = Number(body.limit);
  const windowMs = Number(body.windowMs);
  const now = Number(body.now ?? Date.now());
  if (!scope || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isFinite(now)) {
    throw new Error('INVALID_RATE_LIMIT_REQUEST');
  }

  const current = windows.get(scope);
  const entry = !current || now - current.windowStart >= windowMs ? { windowStart: now, count: 0 } : current;
  entry.count += 1;
  windows.set(scope, entry);
  return {
    allowed: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    resetAt: entry.windowStart + windowMs
  };
}

async function appendAudit(record: Record<string, unknown>): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const path = resolve(auditRoot, `${date}.ndjson`);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function createControlPlaneServer() {
  return createServer(async (req, res) => {
    try {
      if (req.url === '/health' && req.method === 'GET') {
        json(res, 200, { ok: true, service: 'semantic-as-code-forger-control-plane' });
        return;
      }
      if (!authorized(req)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      if (req.url === '/v1/rate-limit/consume' && req.method === 'POST') {
        json(res, 200, rateLimit(await readJson(req)));
        return;
      }
      if (req.url === '/v1/audit' && req.method === 'POST') {
        const record = await readJson(req);
        await appendAudit(record);
        json(res, 202, { accepted: true });
        return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message === 'BODY_TOO_LARGE') json(res, 413, { error: message });
      else if (message.startsWith('INVALID_') || error instanceof SyntaxError) json(res, 400, { error: message });
      else {
        console.error('[control-plane]', error);
        json(res, 500, { error: 'Internal error' });
      }
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  const server = createControlPlaneServer();
  server.listen(port, () => console.log(`[forger-control-plane] http://localhost:${port}`));
}
