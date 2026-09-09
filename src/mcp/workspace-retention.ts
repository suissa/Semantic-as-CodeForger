import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';

export interface RetentionCandidate {
  path: string;
  relativePath: string;
  sessionId: string;
  tenantNamespace: string;
  updatedAt: string;
  ageDays: number;
  expired: boolean;
}

function retentionDays(): number {
  const raw = process.env.FORGER_RETENTION_DAYS?.trim();
  if (!raw) return 30;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('FORGER_RETENTION_DAYS must be a positive integer');
  return parsed;
}

export function isWorkspaceExpired(updatedAt: string, now: Date, days: number): boolean {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid workspace updatedAt: ${updatedAt}`);
  return now.getTime() - timestamp >= days * 86_400_000;
}

async function sessionTimestamp(path: string): Promise<string> {
  try {
    const state = JSON.parse(await readFile(join(path, 'forge-state.json'), 'utf8')) as { updatedAt?: unknown };
    if (typeof state.updatedAt === 'string' && Number.isFinite(Date.parse(state.updatedAt))) return state.updatedAt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return (await stat(path)).mtime.toISOString();
}

async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function planWorkspaceRetention(options: {
  root?: string;
  now?: Date;
  retentionDays?: number;
} = {}): Promise<RetentionCandidate[]> {
  const root = resolve(options.root ?? process.env.FORGER_WORKSPACE_ROOT ?? '.forger-workspaces');
  const now = options.now ?? new Date();
  const days = options.retentionDays ?? retentionDays();
  const sessions: Array<{ path: string; tenantNamespace: string }> = [];

  for (const path of await directories(root)) {
    const name = relative(root, path).replace(/\\/g, '/');
    if (name === 'tenants' || name === '_audit' || name.startsWith('.')) continue;
    sessions.push({ path, tenantNamespace: 'local' });
  }

  const tenantRoot = join(root, 'tenants');
  for (const tenantPath of await directories(tenantRoot)) {
    const tenantNamespace = relative(tenantRoot, tenantPath).replace(/\\/g, '/');
    for (const sessionPath of await directories(tenantPath)) sessions.push({ path: sessionPath, tenantNamespace });
  }

  const candidates: RetentionCandidate[] = [];
  for (const session of sessions) {
    const updatedAt = await sessionTimestamp(session.path);
    const ageDays = Math.max(0, (now.getTime() - Date.parse(updatedAt)) / 86_400_000);
    candidates.push({
      path: session.path,
      relativePath: relative(root, session.path).replace(/\\/g, '/'),
      sessionId: session.path.split(/[\\/]/).at(-1) ?? 'unknown',
      tenantNamespace: session.tenantNamespace,
      updatedAt,
      ageDays: Math.round(ageDays * 100) / 100,
      expired: isWorkspaceExpired(updatedAt, now, days)
    });
  }
  return candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function applyWorkspaceRetention(candidates: RetentionCandidate[], rootInput?: string): Promise<string[]> {
  const root = resolve(rootInput ?? process.env.FORGER_WORKSPACE_ROOT ?? '.forger-workspaces');
  const removed: string[] = [];
  for (const candidate of candidates.filter((item) => item.expired)) {
    const absolute = resolve(candidate.path);
    const rel = relative(root, absolute);
    if (!rel || rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Refusing retention outside workspace root: ${absolute}`);
    }
    await rm(absolute, { recursive: true, force: true });
    removed.push(candidate.relativePath);
  }
  return removed;
}
