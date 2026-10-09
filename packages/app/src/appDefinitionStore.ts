import { and, eq } from 'drizzle-orm';
import {
  AgentisError,
  appArtifactsFacetSchema,
  appBrainFacetSchema,
  appComponentFacetSchema,
  appContractFacetSchema,
  appFrontendFacetSchema,
  appOrchestrationFacetSchema,
  appPermissionsV3FacetSchema,
  appProtocolProjectionFacetSchema,
  appQualityFacetSchema,
  appStorageFacetSchema,
  type AppManifest,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

export type AppDefinition = Pick<
  AppManifest,
  | 'contract'
  | 'frontend'
  | 'components'
  | 'storage'
  | 'orchestration'
  | 'brainPolicy'
  | 'permissionsV3'
  | 'quality'
  | 'artifacts'
  | 'projections'
> & {
  appId: string;
  workspaceId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** Persistence seam for v3 facets which do not belong to the legacy App row. */
export class AppDefinitionStore {
  constructor(private readonly db: AgentisSqliteDb) {}

  get(workspaceId: string, appId: string): AppDefinition | null {
    const row = this.db
      .select()
      .from(schema.appDefinitions)
      .where(
        and(
          eq(schema.appDefinitions.workspaceId, workspaceId),
          eq(schema.appDefinitions.appId, appId),
        ),
      )
      .get();
    return row ? present(row) : null;
  }

  require(workspaceId: string, appId: string): AppDefinition {
    const value = this.get(workspaceId, appId);
    if (!value)
      throw new AgentisError('RESOURCE_NOT_FOUND', `Agentic App v3 definition not found: ${appId}`);
    return value;
  }

  upsert(workspaceId: string, appId: string, definition: Partial<AppDefinition>): AppDefinition {
    const app = this.db
      .select({ id: schema.apps.id })
      .from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, appId)))
      .get();
    if (!app) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    const current = this.get(workspaceId, appId);
    const now = new Date().toISOString();
    const contract = appContractFacetSchema.parse(definition.contract ?? current?.contract ?? {});
    const frontend = parseOptional(
      appFrontendFacetSchema,
      definition.frontend ?? current?.frontend,
    );
    const components = parseOptional(
      appComponentFacetSchema,
      definition.components ?? current?.components,
    );
    const storage = parseOptional(appStorageFacetSchema, definition.storage ?? current?.storage);
    const orchestration = parseOptional(
      appOrchestrationFacetSchema,
      definition.orchestration ?? current?.orchestration,
    );
    const brainPolicy = parseOptional(
      appBrainFacetSchema,
      definition.brainPolicy ?? current?.brainPolicy,
    );
    const permissionsV3 = parseOptional(
      appPermissionsV3FacetSchema,
      definition.permissionsV3 ?? current?.permissionsV3,
    );
    const quality = parseOptional(appQualityFacetSchema, definition.quality ?? current?.quality);
    const artifacts = parseOptional(
      appArtifactsFacetSchema,
      definition.artifacts ?? current?.artifacts,
    );
    const projections = parseOptional(
      appProtocolProjectionFacetSchema,
      definition.projections ?? current?.projections,
    );
    assertDefinitionIntegrity({
      contract,
      frontend,
      components,
      storage,
      orchestration,
      brainPolicy,
      permissionsV3,
      quality,
      artifacts,
      projections,
    });
    const values = {
      appId,
      workspaceId,
      revision: (current?.revision ?? 0) + 1,
      contractJson: contract,
      frontendJson: frontend,
      componentsJson: components,
      storageJson: storage,
      orchestrationJson: orchestration,
      brainPolicyJson: brainPolicy,
      permissionsJson: permissionsV3,
      qualityJson: quality,
      artifactsJson: artifacts,
      projectionsJson: projections,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .insert(schema.appDefinitions)
      .values(values)
      .onConflictDoUpdate({
        target: schema.appDefinitions.appId,
        set: { ...values, createdAt: current?.createdAt ?? now },
      })
      .run();
    return this.require(workspaceId, appId);
  }
}

type FacetKey =
  | 'contract'
  | 'frontend'
  | 'components'
  | 'storage'
  | 'orchestration'
  | 'brainPolicy'
  | 'permissionsV3'
  | 'quality'
  | 'artifacts'
  | 'projections';
type DefinitionFacets = { [K in FacetKey]: AppDefinition[K] | null | undefined };

/** Cross-facet validation. Zod proves shape; this proves the graph is coherent. */
export function assertDefinitionIntegrity(definition: DefinitionFacets): void {
  const issues: string[] = [];
  const operationIds = uniqueIds(definition.contract?.operations ?? [], 'operation', issues);
  uniqueIds(definition.contract?.resources ?? [], 'resource', issues);
  uniqueIds(definition.contract?.events ?? [], 'event', issues);
  const components = new Map(
    (definition.components?.components ?? []).map((component) => [component.id, component]),
  );
  if (components.size !== (definition.components?.components.length ?? 0))
    issues.push('component ids must be unique');
  for (const operation of definition.contract?.operations ?? []) {
    if (operation.handler.kind === 'component') {
      const component = components.get(operation.handler.component);
      if (!component)
        issues.push(
          `operation '${operation.id}' references undeclared component '${operation.handler.component}'`,
        );
      else if (!component.exports.includes(operation.handler.export))
        issues.push(`component '${component.id}' does not export '${operation.handler.export}'`);
    }
    for (const effect of operation.effects) {
      if (effect.compensationOperationId && !operationIds.has(effect.compensationOperationId)) {
        issues.push(
          `operation '${operation.id}' references missing compensation operation '${effect.compensationOperationId}'`,
        );
      }
      if (effect.level === 'irreversible' && effect.compensationOperationId) {
        issues.push(
          `irreversible effect '${operation.id}/${effect.kind}' cannot declare compensation`,
        );
      }
    }
  }
  for (const trigger of definition.orchestration?.triggers ?? []) {
    if (!operationIds.has(trigger.operationId))
      issues.push(`orchestration trigger references missing operation '${trigger.operationId}'`);
  }
  uniqueIds(definition.orchestration?.missionTemplates ?? [], 'mission template', issues);
  const suiteIds = uniqueIds(definition.quality?.suites ?? [], 'quality suite', issues);
  for (const gate of definition.quality?.releaseGates ?? []) {
    if (!suiteIds.has(gate.suiteId))
      issues.push(`release gate references missing suite '${gate.suiteId}'`);
  }
  for (const operationId of definition.projections?.a2a.exposeOperations ?? []) {
    if (!operationIds.has(operationId))
      issues.push(`A2A projection references missing operation '${operationId}'`);
  }
  const declaredScopes = new Set(definition.permissionsV3?.scopes ?? []);
  for (const operation of definition.contract?.operations ?? []) {
    for (const scope of operation.scopes)
      if (!declaredScopes.has(scope))
        issues.push(`operation '${operation.id}' uses undeclared scope '${scope}'`);
  }
  if (issues.length)
    throw new AgentisError(
      'VALIDATION_FAILED',
      `Invalid Agentic App definition: ${issues.join('; ')}`,
    );
}

function uniqueIds(rows: Array<{ id: string }>, label: string, issues: string[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) issues.push(`duplicate ${label} id '${row.id}'`);
    ids.add(row.id);
  }
  return ids;
}

function parseOptional<T>(schemaValue: { parse(value: unknown): T }, value: unknown): T | null {
  return value == null ? null : schemaValue.parse(value);
}

function present(row: typeof schema.appDefinitions.$inferSelect): AppDefinition {
  return {
    appId: row.appId,
    workspaceId: row.workspaceId,
    revision: row.revision,
    contract: appContractFacetSchema.parse(row.contractJson),
    ...(row.frontendJson ? { frontend: appFrontendFacetSchema.parse(row.frontendJson) } : {}),
    ...(row.componentsJson
      ? { components: appComponentFacetSchema.parse(row.componentsJson) }
      : {}),
    ...(row.storageJson ? { storage: appStorageFacetSchema.parse(row.storageJson) } : {}),
    ...(row.orchestrationJson
      ? { orchestration: appOrchestrationFacetSchema.parse(row.orchestrationJson) }
      : {}),
    ...(row.brainPolicyJson ? { brainPolicy: appBrainFacetSchema.parse(row.brainPolicyJson) } : {}),
    ...(row.permissionsJson
      ? { permissionsV3: appPermissionsV3FacetSchema.parse(row.permissionsJson) }
      : {}),
    ...(row.qualityJson ? { quality: appQualityFacetSchema.parse(row.qualityJson) } : {}),
    ...(row.artifactsJson ? { artifacts: appArtifactsFacetSchema.parse(row.artifactsJson) } : {}),
    ...(row.projectionsJson
      ? { projections: appProtocolProjectionFacetSchema.parse(row.projectionsJson) }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
