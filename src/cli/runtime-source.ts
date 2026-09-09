import { verifyPinnedRuntimeSources } from '../mcp/runtime-source.js';

const command = process.argv[2] ?? 'verify';
if (command !== 'verify') throw new Error(`Unknown runtime-source command: ${command}`);

const result = await verifyPinnedRuntimeSources({ remote: true });
console.log(JSON.stringify(result, null, 2));
