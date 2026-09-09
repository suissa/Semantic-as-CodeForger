import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import type { ForgeState, SemanticArtifact, ValidationFinding } from '../shared/types.js';

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boolField(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function entityRef(artifact: SemanticArtifact, key: string): string | undefined {
  return stringField(artifact.data, key);
}

async function writeYaml(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, YAML.stringify(value, { lineWidth: 110 }), 'utf8');
}

export function validateIdentityGraph(state: ForgeState): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const entityLabels = new Set(state.artifacts.filter((a) => a.kind === 'entity').map((a) => a.canonicalLabel));
  const properties = state.artifacts.filter((a) => a.kind === 'property');

  for (const artifact of state.artifacts) {
    if (artifact.kind === 'relationship') {
      const from = entityRef(artifact, 'fromEntity');
      const to = entityRef(artifact, 'toEntity');
      if (!from || !to) {
        findings.push({ severity: 'warning', code: 'RELATIONSHIP_ENDPOINT_MISSING', message: 'Relationship precisa declarar fromEntity e toEntity.', artifact: artifact.canonicalLabel });
        continue;
      }
      if (!entityLabels.has(from)) findings.push({ severity: 'warning', code: 'RELATIONSHIP_UNKNOWN_FROM_ENTITY', message: `Relationship referencia Entity de origem ainda não materializada: ${from}.`, artifact: artifact.canonicalLabel });
      if (!entityLabels.has(to)) findings.push({ severity: 'warning', code: 'RELATIONSHIP_UNKNOWN_TO_ENTITY', message: `Relationship referencia Entity de destino ainda não materializada: ${to}.`, artifact: artifact.canonicalLabel });

      if (boolField(artifact.data, 'behaviorCompleting')) {
        const characteristic = stringField(artifact.data, 'canonicalCharacteristic');
        if (!characteristic) {
          findings.push({ severity: 'warning', code: 'BEHAVIOR_COMPLETING_RELATIONSHIP_WITHOUT_CANONICAL_CHARACTERISTIC', message: 'Relationship que completa comportamento deve declarar a canonicalCharacteristic usada para absorver/ligar a outra Entity.', artifact: artifact.canonicalLabel });
        }
      }
    }

    if (artifact.kind === 'identity_rule') {
      const owner = entityRef(artifact, 'entity');
      const components = recordArray(artifact.data.components);
      if (!owner) {
        findings.push({ severity: 'warning', code: 'IDENTITY_RULE_WITHOUT_ENTITY', message: 'Identity rule precisa declarar a Entity cuja identidade está sendo formada.', artifact: artifact.canonicalLabel });
      } else if (!entityLabels.has(owner)) {
        findings.push({ severity: 'warning', code: 'IDENTITY_RULE_UNKNOWN_ENTITY', message: `Identity rule referencia Entity ainda não materializada: ${owner}.`, artifact: artifact.canonicalLabel });
      }
      if (components.length < 2) {
        findings.push({ severity: 'warning', code: 'IDENTITY_RULE_INSUFFICIENT_COMPONENTS', message: 'Identidade composta precisa de pelo menos duas características explícitas.', artifact: artifact.canonicalLabel });
      }

      let hasExternalComponent = false;
      for (const component of components) {
        const componentEntity = stringField(component, 'entity');
        const characteristic = stringField(component, 'characteristic');
        if (!componentEntity || !characteristic) {
          findings.push({ severity: 'warning', code: 'IDENTITY_COMPONENT_INCOMPLETE', message: 'Cada componente de identidade precisa declarar entity e characteristic.', artifact: artifact.canonicalLabel });
          continue;
        }
        if (owner && componentEntity !== owner) hasExternalComponent = true;
        if (!entityLabels.has(componentEntity)) {
          findings.push({ severity: 'warning', code: 'IDENTITY_COMPONENT_UNKNOWN_ENTITY', message: `Componente de identidade referencia Entity ainda não materializada: ${componentEntity}.`, artifact: artifact.canonicalLabel });
        }
      }

      if (boolField(artifact.data, 'behaviorCompleting') && !hasExternalComponent) {
        findings.push({ severity: 'warning', code: 'BEHAVIOR_COMPLETING_IDENTITY_WITHOUT_EXTERNAL_ENTITY', message: 'Regra marcada como behaviorCompleting deve incluir característica de outra Entity.', artifact: artifact.canonicalLabel });
      }
    }
  }

  for (const property of properties) {
    if (!boolField(property.data, 'canonicalCharacteristic')) continue;
    const owner = entityRef(property, 'entity');
    if (!owner) {
      findings.push({ severity: 'warning', code: 'CANONICAL_CHARACTERISTIC_WITHOUT_ENTITY', message: 'Property marcada como canonicalCharacteristic precisa declarar sua Entity.', artifact: property.canonicalLabel });
    } else if (!entityLabels.has(owner)) {
      findings.push({ severity: 'warning', code: 'CANONICAL_CHARACTERISTIC_UNKNOWN_ENTITY', message: `canonicalCharacteristic pertence a Entity ainda não materializada: ${owner}.`, artifact: property.canonicalLabel });
    }
  }

  return findings;
}

export async function materializeIdentityGraph(projectDirectory: string, state: ForgeState): Promise<void> {
  const entities = state.artifacts.filter((a) => a.kind === 'entity');
  const properties = state.artifacts.filter((a) => a.kind === 'property');
  const relationships = state.artifacts.filter((a) => a.kind === 'relationship');
  const identityRules = state.artifacts.filter((a) => a.kind === 'identity_rule');

  const canonicalByEntity = new Map<string, string[]>();
  for (const property of properties) {
    if (!boolField(property.data, 'canonicalCharacteristic')) continue;
    const owner = entityRef(property, 'entity');
    if (!owner) continue;
    const current = canonicalByEntity.get(owner) ?? [];
    current.push(property.canonicalLabel);
    canonicalByEntity.set(owner, current);
  }

  const graph = {
    api_version: 'allascode/v1',
    kind: 'SemanticIdentityGraph',
    semantics: {
      storage_independent: true,
      relationship_is_not_foreign_key: true,
      behavior_completion_supported: true,
      cross_entity_identity_supported: true
    },
    nodes: entities.map((entity) => ({
      entity: entity.canonicalLabel,
      aliases: Array.isArray(entity.data.aliases) ? entity.data.aliases : [],
      canonical_characteristics: canonicalByEntity.get(entity.canonicalLabel) ?? [],
      identity: entity.data.identity ?? null
    })),
    edges: relationships.map((relationship) => ({
      canonical_label: relationship.canonicalLabel,
      from: entityRef(relationship, 'fromEntity') ?? null,
      to: entityRef(relationship, 'toEntity') ?? null,
      relation: stringField(relationship.data, 'relation') ?? 'unspecified',
      behavior_completing: boolField(relationship.data, 'behaviorCompleting'),
      canonical_characteristic: stringField(relationship.data, 'canonicalCharacteristic') ?? null,
      context: stringField(relationship.data, 'context') ?? null
    })),
    identity_rules: identityRules.map((rule) => ({
      canonical_label: rule.canonicalLabel,
      entity: entityRef(rule, 'entity') ?? null,
      components: recordArray(rule.data.components),
      context: stringField(rule.data, 'context') ?? null,
      uniqueness: stringField(rule.data, 'uniqueness') ?? 'unspecified',
      behavior_completing: boolField(rule.data, 'behaviorCompleting')
    }))
  };

  await writeYaml(join(projectDirectory, 'identity/graph.yml'), graph);
}
