import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { assertRuntimeTopology } from '../infra/runtime-services.js';
import { artifactKinds, type SemanticArtifact } from '../shared/types.js';
import { finalize, initializeSession, recordTurn, snapshot, upsertArtifact } from './project.js';
import { createRepositoryPullRequest, publishRepository, reviewRepository, setRepositoryTarget } from './github.js';
import { withSessionMutationLease } from './session-mutation.js';
import { normalizeTenantId, runWithTenant } from './tenant-context.js';

assertRuntimeTopology();

const server = new Server({ name: 'semantic-as-code-forger-mcp', version: '0.8.0' }, { capabilities: { tools: {} } });

const tools = [
  {
    name: 'forger_session_init',
    description: 'Initialize an isolated AllasCode project workspace for one semantic interview.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId', 'projectName', 'summary'],
      properties: { sessionId: { type: 'string' }, projectName: { type: 'string' }, summary: { type: 'string' } }
    }
  },
  {
    name: 'forger_artifact_upsert',
    description: 'Create or replace one governed semantic artifact and materialize it into the AllasCode Blueprint tree.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId', 'artifact'],
      properties: {
        sessionId: { type: 'string' },
        artifact: {
          type: 'object', additionalProperties: false, required: ['kind', 'canonicalLabel', 'summary', 'data'],
          properties: {
            kind: { type: 'string', enum: artifactKinds }, canonicalLabel: { type: 'string' }, summary: { type: 'string' },
            data: { type: 'object' }, confidence: { type: 'number', minimum: 0, maximum: 1 }
          }
        }
      }
    }
  },
  {
    name: 'forger_session_record_turn',
    description: 'Persist the interview turn, extracted facts and phase progression after all artifacts from the turn were materialized.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['sessionId', 'userMessage', 'assistantMessage', 'facts', 'phaseComplete'],
      properties: {
        sessionId: { type: 'string' }, userMessage: { type: 'string' }, assistantMessage: { type: 'string' },
        facts: { type: 'array', items: { type: 'string' } }, phaseComplete: { type: 'boolean' }
      }
    }
  },
  {
    name: 'forger_session_snapshot',
    description: 'Read the current interview state, generated file tree and Blueprint validation findings.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId: { type: 'string' } } }
  },
  {
    name: 'forger_finalize',
    description: 'Freeze the current semantic interview into a reviewable Blueprint summary and trace after validation.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId: { type: 'string' } } }
  },
  {
    name: 'forger_repository_target_set',
    description: 'Configure the GitHub repository, base branch, review branch, optional path prefix and optional pull-request-after-publish policy.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId', 'repository'],
      properties: {
        sessionId: { type: 'string' }, repository: { type: 'string', description: 'owner/name' },
        baseBranch: { type: 'string' }, targetBranch: { type: 'string' }, pathPrefix: { type: 'string' },
        pullRequestPolicy: { type: 'string', enum: ['manual', 'after_publish'] },
        pullRequestDraft: { type: 'boolean' }
      }
    }
  },
  {
    name: 'forger_repository_review',
    description: 'Create a non-mutating GitHub diff review for the finalized workspace and mint the review token required for publication.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId: { type: 'string' } } }
  },
  {
    name: 'forger_repository_publish',
    description: 'Publish exactly the reviewed Blueprint diff to GitHub. Requires the latest review token and rejects stale branch/workspace state. Can auto-open a PR when the configured policy is after_publish.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId', 'reviewToken'],
      properties: { sessionId: { type: 'string' }, reviewToken: { type: 'string' } }
    }
  },
  {
    name: 'forger_repository_pull_request_create',
    description: 'Open or reuse an existing pull request for the already-published reviewed branch. This is separate from branch publication and is idempotent for the same open head/base pair.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean' }
      }
    }
  }
] as Array<{ name: string; description: string; inputSchema: Record<string, any> }>;

for (const tool of tools) {
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
  tool.inputSchema.required = ['tenantId', ...required.filter((item: string) => item !== 'tenantId')];
  tool.inputSchema.properties = {
    tenantId: { type: 'string', minLength: 1, description: 'Opaque authenticated tenant identity. Never a filesystem path.' },
    ...(tool.inputSchema.properties ?? {})
  };
}

function isMutatingTool(name: string): boolean {
  return name !== 'forger_session_snapshot';
}

async function dispatch(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'forger_session_init':
      return initializeSession(args as { sessionId: string; projectName: string; summary: string });
    case 'forger_artifact_upsert':
      return upsertArtifact(String(args.sessionId), args.artifact as SemanticArtifact);
    case 'forger_session_record_turn':
      return recordTurn(args as { sessionId: string; userMessage: string; assistantMessage: string; facts: string[]; phaseComplete: boolean });
    case 'forger_session_snapshot':
      return snapshot(String(args.sessionId));
    case 'forger_finalize':
      return finalize(String(args.sessionId));
    case 'forger_repository_target_set':
      return setRepositoryTarget(String(args.sessionId), {
        repository: String(args.repository ?? ''),
        baseBranch: typeof args.baseBranch === 'string' ? args.baseBranch : undefined,
        targetBranch: typeof args.targetBranch === 'string' ? args.targetBranch : undefined,
        pathPrefix: typeof args.pathPrefix === 'string' ? args.pathPrefix : undefined,
        pullRequestPolicy: typeof args.pullRequestPolicy === 'string' ? args.pullRequestPolicy : undefined,
        pullRequestDraft: args.pullRequestDraft === true
      });
    case 'forger_repository_review':
      return reviewRepository(String(args.sessionId));
    case 'forger_repository_publish':
      return publishRepository(String(args.sessionId), String(args.reviewToken ?? ''));
    case 'forger_repository_pull_request_create':
      return createRepositoryPullRequest(String(args.sessionId), {
        title: typeof args.title === 'string' ? args.title : undefined,
        body: typeof args.body === 'string' ? args.body : undefined,
        draft: typeof args.draft === 'boolean' ? args.draft : undefined
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools as any }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const tenantId = normalizeTenantId(args.tenantId);

  const value = await runWithTenant(tenantId, async () => {
    if (!isMutatingTool(name)) return dispatch(name, args);
    const sessionId = String(args.sessionId ?? '');
    if (!sessionId) throw new Error('sessionId is required for a mutating tool');
    return withSessionMutationLease(sessionId, async () => dispatch(name, args));
  });

  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[forger-mcp] ready');
