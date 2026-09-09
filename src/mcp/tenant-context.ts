import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

interface TenantContext {
  tenantId: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function normalizeTenantId(value: unknown): string {
  const tenantId = String(value ?? '').trim();
  if (!tenantId) throw new Error('tenantId is required');
  if (tenantId.length > 512) throw new Error('tenantId is too long');
  return tenantId;
}

export function currentTenantId(): string {
  return storage.getStore()?.tenantId ?? 'local';
}

export function tenantNamespace(tenantId: string): string {
  const normalized = normalizeTenantId(tenantId);
  if (normalized === 'local') return 'local';
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `tenant-${digest.slice(0, 32)}`;
}

export function tenantWorkspaceRoot(root: string, tenantId: string): string {
  const normalized = normalizeTenantId(tenantId);
  return normalized === 'local' ? root : join(root, 'tenants', tenantNamespace(normalized));
}

export async function runWithTenant<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
  return storage.run({ tenantId: normalizeTenantId(tenantId) }, operation);
}
