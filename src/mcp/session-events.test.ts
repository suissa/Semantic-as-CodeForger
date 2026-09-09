import assert from 'node:assert/strict';
import test from 'node:test';
import type { InterviewEvent } from './session-events.js';
import { replayInterviewEvents } from './session-events.js';

const initialized: InterviewEvent = {
  sequence: 1,
  at: '2026-09-09T00:00:00.000Z',
  type: 'SessionInitialized',
  data: {
    sessionId: 'session-1',
    projectName: 'Replay',
    projectSlug: 'replay',
    summary: 'Event sourced interview',
    createdAt: '2026-09-09T00:00:00.000Z'
  }
};

test('replays artifacts, facts, turns, phase progression and finalization', () => {
  const events: InterviewEvent[] = [
    initialized,
    {
      sequence: 2,
      at: '2026-09-09T00:01:00.000Z',
      type: 'ArtifactUpserted',
      data: { artifact: { kind: 'entity', canonicalLabel: 'Order', summary: 'Order', data: {} } }
    },
    {
      sequence: 3,
      at: '2026-09-09T00:02:00.000Z',
      type: 'TurnRecorded',
      data: {
        userMessage: 'orders exist',
        assistantMessage: 'captured',
        facts: ['Order exists'],
        phaseAdvanced: true
      }
    },
    {
      sequence: 4,
      at: '2026-09-09T00:03:00.000Z',
      type: 'SessionFinalized',
      data: { finalizedAt: '2026-09-09T00:03:00.000Z' }
    }
  ];

  const state = replayInterviewEvents(events)!;
  assert.equal(state.sessionId, 'session-1');
  assert.equal(state.phaseIndex, 1);
  assert.deepEqual(state.facts, ['Order exists']);
  assert.equal(state.turns.length, 2);
  assert.equal(state.artifacts[0]?.canonicalLabel, 'Order');
  assert.equal(state.finalizedAt, '2026-09-09T00:03:00.000Z');
});

test('replaying an upsert replaces the same semantic identity rather than duplicating it', () => {
  const events: InterviewEvent[] = [
    initialized,
    {
      sequence: 2,
      at: '2026-09-09T00:01:00.000Z',
      type: 'ArtifactUpserted',
      data: { artifact: { kind: 'entity', canonicalLabel: 'Order', summary: 'Old', data: {} } }
    },
    {
      sequence: 3,
      at: '2026-09-09T00:02:00.000Z',
      type: 'ArtifactUpserted',
      data: { artifact: { kind: 'entity', canonicalLabel: 'Order', summary: 'Updated', data: { identity: 'orderId' } } }
    }
  ];
  const state = replayInterviewEvents(events)!;
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.artifacts[0]?.summary, 'Updated');
  assert.equal(state.artifacts[0]?.data.identity, 'orderId');
});

test('rejects a sequence gap instead of silently rebuilding a partial interview', () => {
  const events: InterviewEvent[] = [
    initialized,
    {
      sequence: 3,
      at: '2026-09-09T00:01:00.000Z',
      type: 'TurnRecorded',
      data: { userMessage: 'x', assistantMessage: 'y', facts: [], phaseAdvanced: false }
    }
  ];
  assert.throws(() => replayInterviewEvents(events), /sequence gap/);
});
