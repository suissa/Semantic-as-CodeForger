import { applyWorkspaceRetention, planWorkspaceRetention } from '../mcp/workspace-retention.js';

const apply = process.argv.includes('--apply');
const candidates = await planWorkspaceRetention();
const expired = candidates.filter((candidate) => candidate.expired);
const removed = apply ? await applyWorkspaceRetention(candidates) : [];

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  retentionDays: Number(process.env.FORGER_RETENTION_DAYS ?? 30),
  scanned: candidates.length,
  expired: expired.map(({ path: _path, ...candidate }) => candidate),
  removed
}, null, 2));
