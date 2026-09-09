import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ForgeState, SemanticArtifact } from '../shared/types.js';

export type InterviewEvent =
  | {
      sequence: number;
      at: string;
      type: 'SessionInitialized';
      data: { sessionId: string; projectName: string; projectSlug: string; summary: string; createdAt: string };
    }
  | {
      sequence: number;
      at: string;
      type: 'ArtifactUpserted';
      data: { artifact: SemanticArtifact };
    }
  | {
      sequence: number;
      at: string;
      type: 'TurnRecorded';
      data: { userMessage: string; assistantMessage: string; facts: string[]; phaseAdvanced: boolean };
    }
  | {
      sequence: number;
      at: string;
      type: 'SessionFinalized';
      data: { finalizedAt: string };
    };

type EventInput =
  | { type: 'ArtifactUpserted'; data: { artifact: SemanticArtifact } }
  | { type: 'TurnRecorded'; data: { userMessage: string; assistantMessage: string; facts: string[]; phaseAdvanced: boolean } }
  | { type: 'SessionFinalized'; data: { finalizedAt: string } };

function logPath(sessionDirectory: string): string {
  return join(sessionDirectory, 'interview-events.ndjson');
}

export async function initializeInterviewEventLog(sessionDirectory: string, state: ForgeState): Promise<void> {
  await mkdir(sessionDirectory, { recursive: true });
  const event: InterviewEvent = {
    sequence: 1,
    at: state.createdAt,
    type: 'SessionInitialized',
    data: {
      sessionId: state.sessionId,
      projectName: state.projectName,
      projectSlug: state.projectSlug,
      summary: state.summary,
      createdAt: state.createdAt
    }
  };
  await writeFile(logPath(sessionDirectory), `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export async function readInterviewEvents(sessionDirectory: string): Promise<InterviewEvent[]> {
  try {
    const text = await readFile(logPath(sessionDirectory), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as InterviewEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendInterviewEvent(sessionDirectory: string, input: EventInput): Promise<InterviewEvent> {
  const events = await readInterviewEvents(sessionDirectory);
  if (events.length === 0) throw new Error('Interview event log is not initialized');
  const event = {
    sequence: events.length + 1,
    at: new Date().toISOString(),
    ...input
  } as InterviewEvent;
  await appendFile(logPath(sessionDirectory), `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

export function replayInterviewEvents(events: InterviewEvent[]): ForgeState | undefined {
  const first = events[0];
  if (!first || first.type !== 'SessionInitialized') return undefined;

  let state: ForgeState = {
    sessionId: first.data.sessionId,
    projectName: first.data.projectName,
    projectSlug: first.data.projectSlug,
    summary: first.data.summary,
    phaseIndex: 0,
    facts: [],
    turns: [],
    artifacts: [],
    createdAt: first.data.createdAt,
    updatedAt: first.at
  };

  let expectedSequence = 1;
  for (const event of events) {
    if (event.sequence !== expectedSequence) throw new Error(`Interview event sequence gap: expected ${expectedSequence}, got ${event.sequence}`);
    expectedSequence += 1;
    state.updatedAt = event.at;

    if (event.type === 'ArtifactUpserted') {
      const artifact = event.data.artifact;
      const index = state.artifacts.findIndex((candidate) => candidate.kind === artifact.kind && candidate.canonicalLabel === artifact.canonicalLabel);
      if (index >= 0) state.artifacts[index] = artifact;
      else state.artifacts.push(artifact);
    }

    if (event.type === 'TurnRecorded') {
      state.turns.push({ role: 'user', content: event.data.userMessage, at: event.at });
      state.turns.push({ role: 'assistant', content: event.data.assistantMessage, at: event.at });
      state.facts.push(...event.data.facts.filter((fact) => !state.facts.includes(fact)));
      if (event.data.phaseAdvanced) state.phaseIndex += 1;
    }

    if (event.type === 'SessionFinalized') state.finalizedAt = event.data.finalizedAt;
  }

  return state;
}

export async function replayInterviewState(sessionDirectory: string): Promise<ForgeState | undefined> {
  return replayInterviewEvents(await readInterviewEvents(sessionDirectory));
}

export async function exportInterviewEventLog(sessionDirectory: string, projectDirectory: string): Promise<void> {
  const events = await readInterviewEvents(sessionDirectory);
  await mkdir(join(projectDirectory, '.allascode'), { recursive: true });
  await writeFile(join(projectDirectory, '.allascode/interview-events.ndjson'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
}
