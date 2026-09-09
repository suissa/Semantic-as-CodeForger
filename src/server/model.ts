import { z } from 'zod';
import { artifactKinds, type ForgeState, type ModelTurnResult } from '../shared/types.js';
import type { InterviewPhase } from './interview.js';

const artifactSchema = z.object({
  kind: z.enum(artifactKinds),
  canonicalLabel: z.string().min(1),
  summary: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1).optional()
});

const resultSchema = z.object({
  acknowledgement: z.string().min(1),
  facts: z.array(z.string()).default([]),
  artifacts: z.array(artifactSchema).default([]),
  phaseComplete: z.boolean().default(true),
  followUpQuestion: z.string().optional()
});

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model did not return a JSON object');
  return JSON.parse(source.slice(start, end + 1));
}

function fallback(phase: InterviewPhase, message: string): ModelTurnResult {
  return {
    acknowledgement: 'Registrei esta parte da especificação. Sem um LLM configurado, o Forger preserva a resposta como evidência da entrevista e continua o roteiro determinístico.',
    facts: [`${phase.id}: ${message}`],
    artifacts: [],
    phaseComplete: true
  };
}

export async function analyzeTurn(state: ForgeState, phase: InterviewPhase, message: string): Promise<ModelTurnResult> {
  const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return fallback(phase, message);

  const baseUrl = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL ?? 'gpt-5';
  const existing = state.artifacts.map((a) => `${a.kind}:${a.canonicalLabel}`).slice(-80);

  const system = `You are the semantic interviewer inside Semantic-as-Code Forger.
Your job is to extract AllasCode Blueprint semantics from a user's answer. Never generate implementation code and never perform filesystem operations.
Return strict JSON only with: acknowledgement, facts[], artifacts[], phaseComplete, optional followUpQuestion.
Artifact kinds: ${artifactKinds.join(', ')}.
Each artifact has kind, canonicalLabel, summary, data, optional confidence.
Rules:
- Preserve the user's domain vocabulary. Do not invent domain rules.
- Intent is the immutable desired outcome, not an HTTP endpoint.
- Distinguish reusable atomic_behavior from domain_action instantiated for an Intent.
- A concrete Agent+Intent behavior canonical label should be AgentName.IntentName when enough information exists.
- Result events are structural consequences and are NEVER configurable: <behavior>.Ok and <behavior>.Error. Do not emit custom terminal result events.
- Capture the listened event for a Domain Action in data.listenEvent when known; it is injected by the flow.
- Put invariants in data.invariants and forbidden situations in data.forbidden.
- Self-healing is mandatory for failure paths; capture healing constraints rather than inventing retries.
- Entities should capture semantic identity, aliases/canonical characteristics and behavior-completing relationships when the user describes them.
- Capabilities describe what is required, not a vendor unless the user explicitly chose one.
- If information is materially missing for the current phase, set phaseComplete=false and ask one focused follow-up question.
- Do not duplicate existing artifacts unless the answer updates them.`;

  const user = JSON.stringify({
    project: { name: state.projectName, summary: state.summary },
    phase: { id: phase.id, goal: phase.goal },
    existingArtifacts: existing,
    knownFacts: state.facts.slice(-80),
    answer: message
  });

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error('LLM response had no content');
  return resultSchema.parse(extractJson(text));
}
