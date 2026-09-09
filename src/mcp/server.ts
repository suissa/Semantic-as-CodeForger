import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { artifactKinds, type SemanticArtifact } from '../shared/types.js';
import { finalize, initializeSession, recordTurn, snapshot, upsertArtifact } from './project.js';

const server = new Server({ name: 'semantic-as-code-forger-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

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
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  let value: unknown;

  switch (name) {
    case 'forger_session_init':
      value = await initializeSession(args as { sessionId: string; projectName: string; summary: string });
      break;
    case 'forger_artifact_upsert':
      value = await upsertArtifact(String(args.sessionId), args.artifact as SemanticArtifact);
      break;
    case 'forger_session_record_turn':
      value = await recordTurn(args as { sessionId: string; userMessage: string; assistantMessage: string; facts: string[]; phaseComplete: boolean });
      break;
    case 'forger_session_snapshot':
      value = await snapshot(String(args.sessionId));
      break;
    case 'forger_finalize':
      value = await finalize(String(args.sessionId));
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[forger-mcp] ready');
