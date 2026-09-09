import express from 'express';
import archiver from 'archiver';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ForgeState, SemanticArtifact, SessionSnapshot, ValidationFinding } from '../shared/types.js';
import { interviewPhases, nextQuestion, phaseFor } from './interview.js';
import { analyzeTurn } from './model.js';
import { ForgerMcpClient } from './mcp-client.js';
import { getProjectDirectory } from '../mcp/project.js';

const app = express();
const mcp = new ForgerMcpClient();
const port = Number(process.env.PORT ?? 8787);

app.use(express.json({ limit: '1mb' }));

function asyncRoute(handler: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response) => void handler(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  });
}

function routeParam(req: express.Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`Missing route parameter: ${name}`);
  return value;
}

async function sessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
  const payload = await mcp.call<{ state: ForgeState; tree: string[]; validation: ValidationFinding[] }>('forger_session_snapshot', { sessionId });
  const phaseIndex = Math.min(payload.state.phaseIndex, interviewPhases.length - 1);
  return {
    ...payload.state,
    phaseName: interviewPhases[phaseIndex]!.title,
    phaseCount: interviewPhases.length,
    tree: payload.tree,
    validation: payload.validation
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'semantic-as-code-forger' }));

app.post('/api/sessions', asyncRoute(async (req, res) => {
  const projectName = String(req.body?.projectName ?? '').trim();
  const summary = String(req.body?.summary ?? '').trim();
  if (!projectName) { res.status(400).json({ error: 'projectName is required' }); return; }
  const sessionId = randomUUID();
  await mcp.call('forger_session_init', { sessionId, projectName, summary });
  const assistantMessage = interviewPhases[0]!.question;
  const state = await mcp.call<ForgeState>('forger_session_record_turn', {
    sessionId,
    userMessage: `[project initialized: ${projectName}]`,
    assistantMessage,
    facts: summary ? [`project-summary: ${summary}`] : [],
    phaseComplete: false
  });
  res.status(201).json({ ...await sessionSnapshot(state.sessionId), assistantMessage });
}));

app.get('/api/sessions/:sessionId', asyncRoute(async (req, res) => {
  res.json(await sessionSnapshot(routeParam(req, 'sessionId')));
}));

app.post('/api/sessions/:sessionId/messages', asyncRoute(async (req, res) => {
  const sessionId = routeParam(req, 'sessionId');
  const message = String(req.body?.message ?? '').trim();
  if (!message) { res.status(400).json({ error: 'message is required' }); return; }

  const before = await sessionSnapshot(sessionId);
  if (before.finalizedAt) { res.status(409).json({ error: 'Session already finalized' }); return; }
  const phase = phaseFor(before);
  const result = await analyzeTurn(before, phase, message);

  for (const artifact of result.artifacts) {
    await mcp.call<SemanticArtifact>('forger_artifact_upsert', { sessionId, artifact });
  }

  const terminalPhase = before.phaseIndex >= interviewPhases.length - 1;
  const advanced = result.phaseComplete && !terminalPhase;
  const question = terminalPhase && result.phaseComplete
    ? 'A entrevista está pronta para validação. Revise a árvore e use “Finalizar Blueprint” quando estiver satisfeito.'
    : result.followUpQuestion ?? nextQuestion(before, advanced);
  const assistantMessage = `${result.acknowledgement}\n\n${question}`;

  await mcp.call('forger_session_record_turn', {
    sessionId,
    userMessage: message,
    assistantMessage,
    facts: result.facts,
    phaseComplete: advanced
  });

  res.json({ ...await sessionSnapshot(sessionId), assistantMessage, extractedArtifacts: result.artifacts });
}));

app.post('/api/sessions/:sessionId/finalize', asyncRoute(async (req, res) => {
  const sessionId = routeParam(req, 'sessionId');
  await mcp.call('forger_finalize', { sessionId });
  res.json(await sessionSnapshot(sessionId));
}));

app.post('/api/sessions/:sessionId/repository/target', asyncRoute(async (req, res) => {
  const sessionId = routeParam(req, 'sessionId');
  const repository = String(req.body?.repository ?? '').trim();
  if (!repository) { res.status(400).json({ error: 'repository is required as owner/name' }); return; }
  await mcp.call('forger_repository_target_set', {
    sessionId,
    repository,
    baseBranch: typeof req.body?.baseBranch === 'string' ? req.body.baseBranch : undefined,
    targetBranch: typeof req.body?.targetBranch === 'string' ? req.body.targetBranch : undefined,
    pathPrefix: typeof req.body?.pathPrefix === 'string' ? req.body.pathPrefix : undefined
  });
  res.json(await sessionSnapshot(sessionId));
}));

app.post('/api/sessions/:sessionId/repository/review', asyncRoute(async (req, res) => {
  const sessionId = routeParam(req, 'sessionId');
  await mcp.call('forger_repository_review', { sessionId });
  res.json(await sessionSnapshot(sessionId));
}));

app.post('/api/sessions/:sessionId/repository/publish', asyncRoute(async (req, res) => {
  const sessionId = routeParam(req, 'sessionId');
  const reviewToken = String(req.body?.reviewToken ?? '').trim();
  if (!reviewToken) { res.status(400).json({ error: 'reviewToken is required' }); return; }
  await mcp.call('forger_repository_publish', { sessionId, reviewToken });
  res.json(await sessionSnapshot(sessionId));
}));

app.get('/api/sessions/:sessionId/export', asyncRoute(async (req, res) => {
  const sessionId = routeParam(req, 'sessionId');
  await sessionSnapshot(sessionId);
  const directory = getProjectDirectory(sessionId);
  res.attachment(`allascode-${sessionId}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (error) => res.destroy(error));
  archive.pipe(res);
  archive.directory(directory, false);
  await archive.finalize();
}));

const clientDir = resolve('dist/client');
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) { next(); return; }
    res.sendFile(resolve(clientDir, 'index.html'));
  });
}

const server = app.listen(port, () => console.log(`[forger] http://localhost:${port}`));

async function shutdown() {
  server.close();
  await mcp.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
