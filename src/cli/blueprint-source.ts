import { verifyPinnedBlueprintSources } from '../mcp/blueprint-source.js';

const command = process.argv[2] ?? 'verify';
if (command !== 'verify' && command !== 'sync') {
  console.error('Usage: tsx src/cli/blueprint-source.ts [verify|sync]');
  process.exit(2);
}

const result = await verifyPinnedBlueprintSources({ writeCache: command === 'sync' });
console.log(`[blueprint:${command}] ${result.repository}@${result.commit}`);
for (const source of result.verified) {
  console.log(`  ok ${source.role.padEnd(22)} ${source.path} ${source.blobSha} (${source.bytes} bytes)`);
}
