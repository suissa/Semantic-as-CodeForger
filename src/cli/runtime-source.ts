import { verifyPinnedRuntimeSources } from '../mcp/runtime-source.js';

const command = process.argv[2] ?? 'verify';
if (command !== 'verify') throw new Error(`Unknown runtime-source command: ${command}`);

// Local verification is always mandatory and checks every vendored source against
// the canonical Git blob SHA recorded in runtime.lock.json. Remote verification is
// optional because the pinned AllasCode upstream may be private and CI credentials
// for this repository must not be broadened just to read another repository.
const remote = process.env.FORGER_RUNTIME_VERIFY_REMOTE === 'true';
const result = await verifyPinnedRuntimeSources({ remote });
console.log(JSON.stringify({ ...result, remoteVerified: remote }, null, 2));
