import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SemanticArtifact, ValidationFinding } from '../shared/types.js';

export type TwoFlowNodeKind = 'input' | 'output' | 'call' | 'called' | 'parallel' | 'try' | 'catch' | 'error_ref' | 'statement';

export interface TwoFlowNode {
  id: string;
  kind: TwoFlowNodeKind;
  expression: string;
  raw: string;
  children?: TwoFlowNode[];
}

export interface TwoFlowAst {
  version: '2flow/0.1';
  source: string;
  nodes: TwoFlowNode[];
}

function classify(raw: string, id: string): TwoFlowNode {
  const line = raw.trim();
  if (/^try\b/.test(line)) return { id, kind: 'try', expression: line.replace(/^try\s*/, '').trim(), raw };
  if (/^catch\b/.test(line)) return { id, kind: 'catch', expression: line.replace(/^catch\s*/, '').trim(), raw };
  if (line === 'error#last-error' || line.includes('error#last-error')) return { id, kind: 'error_ref', expression: 'error#last-error', raw };
  if (line.startsWith('->>')) return { id, kind: 'call', expression: line.slice(3).trim(), raw };
  if (line.startsWith('<<-')) return { id, kind: 'called', expression: line.slice(3).trim(), raw };
  if (line.startsWith('->')) return { id, kind: 'input', expression: line.slice(2).trim(), raw };
  if (line.startsWith('<-')) return { id, kind: 'output', expression: line.slice(2).trim(), raw };
  return { id, kind: 'statement', expression: line, raw };
}

function parseParallel(line: string, id: string): TwoFlowNode | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  const inside = trimmed.slice(1, -1).trim();
  const parts = inside.split(',').map((part) => part.trim()).filter(Boolean);
  return {
    id,
    kind: 'parallel',
    expression: inside,
    raw: line,
    children: parts.map((part, index) => classify(part, `${id}.${index + 1}`))
  };
}

export function parseTwoFlow(source: string): TwoFlowAst {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const nodes = lines.map((line, index) => parseParallel(line, `n${index + 1}`) ?? classify(line, `n${index + 1}`));
  return { version: '2flow/0.1', source, nodes };
}

function mermaidEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function nodeLabel(node: TwoFlowNode): string {
  const prefix: Record<TwoFlowNodeKind, string> = {
    input: 'INPUT', output: 'OUTPUT', call: 'CALL', called: 'CALLED', parallel: 'PARALLEL', try: 'TRY', catch: 'CATCH', error_ref: 'ERROR', statement: 'STEP'
  };
  return `${prefix[node.kind]} ${node.expression}`.trim();
}

export function renderTwoFlowMermaid(ast: TwoFlowAst): string {
  const lines = ['flowchart TD'];
  for (const node of ast.nodes) {
    lines.push(`  ${node.id}["${mermaidEscape(nodeLabel(node))}"]`);
    for (const child of node.children ?? []) {
      lines.push(`  ${child.id.replace('.', '_')}["${mermaidEscape(nodeLabel(child))}"]`);
      lines.push(`  ${node.id} --> ${child.id.replace('.', '_')}`);
    }
  }
  for (let index = 0; index < ast.nodes.length - 1; index += 1) {
    const current = ast.nodes[index]!;
    const next = ast.nodes[index + 1]!;
    if (current.kind === 'parallel' && current.children?.length) {
      for (const child of current.children) lines.push(`  ${child.id.replace('.', '_')} --> ${next.id}`);
    } else {
      lines.push(`  ${current.id} --> ${next.id}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function validateTwoFlow(artifact: SemanticArtifact): ValidationFinding[] {
  if (artifact.kind !== 'flow') return [];
  const source = typeof artifact.data.twoFlow === 'string' ? artifact.data.twoFlow.trim() : '';
  if (!source) return [];
  const ast = parseTwoFlow(source);
  const findings: ValidationFinding[] = [];
  for (const node of ast.nodes) {
    if (node.kind === 'statement') {
      findings.push({ severity: 'warning', code: 'TWOFLOW_UNCLASSIFIED_STATEMENT', message: `Trecho 2flow não reconhecido como operador estrutural: ${node.expression}`, artifact: artifact.canonicalLabel });
    }
    if (node.kind === 'parallel' && (!node.children || node.children.length < 2)) {
      findings.push({ severity: 'warning', code: 'TWOFLOW_PARALLEL_WITHOUT_BRANCHES', message: 'Grupo paralelo 2flow deve conter ao menos dois ramos separados por vírgula.', artifact: artifact.canonicalLabel });
    }
  }
  return findings;
}

export async function materializeTwoFlow(projectDirectory: string, artifact: SemanticArtifact): Promise<void> {
  if (artifact.kind !== 'flow') return;
  const source = typeof artifact.data.twoFlow === 'string' ? artifact.data.twoFlow.trim() : '';
  if (!source) return;
  const safeLabel = artifact.canonicalLabel.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/\./g, '-');
  const ast = parseTwoFlow(source);
  const astPath = join(projectDirectory, 'flows', `${safeLabel}.ast.json`);
  const diagramPath = join(projectDirectory, 'flows', `${safeLabel}.mmd`);
  await mkdir(dirname(astPath), { recursive: true });
  await writeFile(astPath, `${JSON.stringify(ast, null, 2)}\n`, 'utf8');
  await writeFile(diagramPath, renderTwoFlowMermaid(ast), 'utf8');
}
