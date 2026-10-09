import { z } from 'zod';

/** Public, protocol-neutral lifecycle for durable App work. */
export const appTaskStatusSchema = z.enum([
  'submitted',
  'working',
  'input_required',
  'approval_required',
  'waiting',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'rejected',
]);
export type AppTaskStatus = z.infer<typeof appTaskStatusSchema>;

export const effectLevelSchema = z.enum(['read', 'reversible', 'compensatable', 'irreversible']);
export type EffectLevel = z.infer<typeof effectLevelSchema>;

export const delegationGrantSchema = z.object({
  id: z.string().min(1),
  delegatorPrincipalId: z.string().min(1),
  delegatePrincipalId: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  resourceConstraints: z
    .array(
      z.object({
        resourceType: z.string().min(1),
        resourceIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  maxEffectLevel: effectLevelSchema.default('read'),
  maxSpendCents: z.number().int().nonnegative().nullable().optional(),
  issuedAt: z.string(),
  expiresAt: z.string().nullable().optional(),
  parentGrantId: z.string().nullable().optional(),
});
export type DelegationGrant = z.infer<typeof delegationGrantSchema>;

/**
 * Immutable authority lineage carried through App, Workflow, Mission, MCP and
 * A2A calls. A delegate may narrow this envelope, never widen it.
 */
export const authorityContextSchema = z.object({
  workspaceId: z.string().min(1),
  ownerPrincipalId: z.string().min(1),
  initiatorPrincipalId: z.string().min(1),
  actorPrincipalId: z.string().min(1),
  subjectPrincipalId: z.string().nullable().optional(),
  delegationChain: z.array(delegationGrantSchema).default([]),
  appId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  workflowRunId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  scopes: z.array(z.string()).default([]),
  maxEffectLevel: effectLevelSchema.default('read'),
  maxSpendCents: z.number().int().nonnegative().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});
export type AuthorityContext = z.infer<typeof authorityContextSchema>;

export const contentProvenanceSchema = z.object({
  origin: z.enum(['owner', 'agentis', 'external', 'generated', 'third_party']),
  sourceRef: z.string().nullable().optional(),
  observedAt: z.string(),
});

export const contentEnvelopeSchema = z.object({
  data: z.unknown(),
  provenance: contentProvenanceSchema,
  trust: z.enum(['trusted', 'untrusted', 'unknown', 'quarantined']).default('unknown'),
  instructionAuthority: z.enum(['none', 'operator', 'system']).default('none'),
  securityLabels: z.array(z.string()).default([]),
});
export type ContentEnvelope = z.infer<typeof contentEnvelopeSchema>;

export const appArtifactRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  mimeType: z.string().nullable().optional(),
  uri: z.string().nullable().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  provenance: contentProvenanceSchema.optional(),
  securityLabels: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type AppArtifactRef = z.infer<typeof appArtifactRefSchema>;

export const taskInputRequestSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  schema: z.record(z.unknown()).default({ type: 'object' }),
  status: z.enum(['pending', 'fulfilled', 'cancelled']).default('pending'),
  response: z.unknown().optional(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable().optional(),
});
export type TaskInputRequest = z.infer<typeof taskInputRequestSchema>;

export const taskApprovalRequestSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().optional(),
  effectPlanId: z.string().nullable().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']).default('pending'),
  requestedAt: z.string(),
  decidedAt: z.string().nullable().optional(),
  decidedBy: z.string().nullable().optional(),
});
export type TaskApprovalRequest = z.infer<typeof taskApprovalRequestSchema>;

export const operationEconomicsSchema = z.object({
  latencyClass: z.enum(['realtime', 'interactive', 'background', 'batch']).optional(),
  targetLatencyMs: z.number().int().positive().optional(),
  maxLatencyMs: z.number().int().positive().optional(),
  estimatedCostCents: z
    .object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
    .optional(),
  quotaUnits: z.number().nonnegative().optional(),
  rateLimitBucket: z.string().optional(),
  qualityTier: z.string().optional(),
});
export type OperationEconomics = z.infer<typeof operationEconomicsSchema>;

export const effectDeclarationSchema = z.object({
  kind: z.string().min(1),
  level: effectLevelSchema,
  targetResourceType: z.string().optional(),
  compensationOperationId: z.string().nullable().optional(),
  approval: z.enum(['never', 'policy', 'always']).default('policy'),
});

export const effectPlanStatusSchema = z.enum([
  'prepared',
  'awaiting_authorization',
  'authorized',
  'executing',
  'reconciling',
  'completed',
  'failed',
  'cancelled',
  'compensated',
]);
export type EffectPlanStatus = z.infer<typeof effectPlanStatusSchema>;

export interface EffectPlan {
  id: string;
  workspaceId: string;
  missionId: string | null;
  appId: string | null;
  operationId: string;
  planHash: string;
  status: EffectPlanStatus;
  input: unknown;
  targets: Array<{ resourceType: string; resourceId?: string; description?: string }>;
  consequences: string[];
  reversibility: Exclude<EffectLevel, 'read'>;
  compensationOperationId: string | null;
  estimatedCostCents: { min: number; max: number } | null;
  estimatedLatencyMs: number | null;
  idempotencyKey: string;
  authorityContext: AuthorityContext;
  authorizationGrantId: string | null;
  result: unknown;
  lastError: string | null;
  expiresAt: string | null;
  authorizedAt: string | null;
  executedAt: string | null;
  reconciledAt: string | null;
  compensatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EffectAuthorizationGrant {
  id: string;
  workspaceId: string;
  effectPlanId: string;
  planHash: string;
  authorityContext: AuthorityContext;
  scopes: string[];
  maxEffectLevel: EffectLevel;
  maxSpendCents: number | null;
  approvedBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const appOperationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  mode: z.enum(['query', 'command', 'task', 'stream']),
  inputSchema: z.record(z.unknown()).default({ type: 'object' }),
  outputSchema: z.record(z.unknown()).default({ type: 'object' }),
  scopes: z.array(z.string()).default([]),
  effects: z.array(effectDeclarationSchema).default([]),
  economics: operationEconomicsSchema.optional(),
  idempotency: z
    .object({
      required: z.boolean().default(false),
      ttlSeconds: z.number().int().positive().optional(),
    })
    .optional(),
  handler: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workflow'), workflow: z.string().min(1) }),
    z.object({
      kind: z.literal('mission'),
      ownerAgent: z.string().min(1),
      objectiveTemplate: z.string().min(1),
    }),
    z.object({
      kind: z.literal('component'),
      component: z.string().min(1),
      export: z.string().min(1),
    }),
  ]),
});
export type AppOperation = z.infer<typeof appOperationSchema>;

export const appContractFacetSchema = z.object({
  operations: z.array(appOperationSchema).default([]),
  resources: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        uriTemplate: z.string().min(1),
        schema: z.record(z.unknown()).optional(),
        scopes: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  events: z
    .array(
      z.object({
        id: z.string().min(1),
        schema: z.record(z.unknown()).default({ type: 'object' }),
      }),
    )
    .default([]),
});
export type AppContractFacet = z.infer<typeof appContractFacetSchema>;

export const appOrchestrationFacetSchema = z.object({
  missionTemplates: z
    .array(
      z.object({
        id: z.string().min(1),
        ownerAgent: z.string().min(1),
        objectiveTemplate: z.string().min(1),
        workflow: z.string().nullable().optional(),
        maxChildren: z.number().int().positive().default(8),
        cancellation: z.enum(['none', 'children', 'tree']).default('children'),
        aggregation: z.enum(['all', 'any', 'best_effort']).default('all'),
      }),
    )
    .default([]),
  triggers: z
    .array(z.object({ event: z.string().min(1), operationId: z.string().min(1) }))
    .default([]),
  maxParallelTasks: z.number().int().positive().default(8),
});
export type AppOrchestrationFacet = z.infer<typeof appOrchestrationFacetSchema>;

export const appBrainFacetSchema = z.object({
  retrievalScopes: z.array(z.string()).default([]),
  workingSet: z
    .object({
      maxItems: z.number().int().positive().default(40),
      maxTokens: z.number().int().positive().optional(),
    })
    .default({ maxItems: 40 }),
  formation: z
    .object({
      enabled: z.boolean().default(true),
      minimumConfidence: z.number().min(0).max(1).default(0.65),
    })
    .default({ enabled: true, minimumConfidence: 0.65 }),
  retention: z
    .object({
      defaultDays: z.number().int().positive().nullable().default(null),
      decay: z.boolean().default(true),
    })
    .default({ defaultDays: null, decay: true }),
  minimumTrust: z.number().min(0).max(1).default(0.5),
  shareTaskContext: z.boolean().default(true),
});
export type AppBrainFacet = z.infer<typeof appBrainFacetSchema>;

export const appPermissionsV3FacetSchema = z.object({
  scopes: z.array(z.string()).default([]),
  egress: z
    .array(
      z.object({
        host: z.string().min(1),
        ports: z.array(z.number().int().positive()).default([443]),
      }),
    )
    .default([]),
  maxEffectLevel: effectLevelSchema.default('read'),
  maxSpendCentsPerTask: z.number().int().nonnegative().nullable().default(null),
  guardrails: z
    .array(
      z.object({
        id: z.string().min(1),
        phase: z.enum(['prepare', 'authorize', 'execute', 'reconcile']),
        expression: z.string().min(1),
        onViolation: z.enum(['deny', 'approval', 'escalate', 'throttle']),
      }),
    )
    .default([]),
  escalation: z
    .object({
      agentId: z.string().nullable().optional(),
      approvalQueue: z.string().nullable().optional(),
    })
    .optional(),
});
export type AppPermissionsV3Facet = z.infer<typeof appPermissionsV3FacetSchema>;

export const appQualityFacetSchema = z.object({
  suites: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        kind: z.enum(['correctness', 'safety', 'regression', 'benchmark']),
        datasetArtifactId: z.string().nullable().optional(),
        rubric: z.array(z.string()).default([]),
        minimumScore: z.number().min(0).max(1).default(1),
      }),
    )
    .default([]),
  budgets: z
    .object({
      maxCostCents: z.number().int().nonnegative().optional(),
      maxTokens: z.number().int().nonnegative().optional(),
      maxDurationMs: z.number().int().nonnegative().optional(),
      maxExternalEffects: z.number().int().nonnegative().optional(),
    })
    .default({}),
  slos: z
    .object({
      successRate: z.number().min(0).max(1).optional(),
      p50LatencyMs: z.number().int().nonnegative().optional(),
      p95LatencyMs: z.number().int().nonnegative().optional(),
      maxCostPerSuccessfulTaskCents: z.number().nonnegative().optional(),
    })
    .default({}),
  releaseGates: z
    .array(z.object({ suiteId: z.string().min(1), required: z.boolean().default(true) }))
    .default([]),
});
export type AppQualityFacet = z.infer<typeof appQualityFacetSchema>;

export const appFrontendFacetSchema = z.object({
  framework: z.enum(['react', 'static', 'custom']).default('react'),
  entry: z.string().min(1),
  outputDir: z.string().min(1).default('dist'),
  styling: z.enum(['tailwind', 'css', 'custom']).default('tailwind'),
});

export const appComponentFacetSchema = z.object({
  components: z
    .array(
      z.object({
        id: z.string().min(1),
        runtime: z.enum(['node', 'python', 'oci']),
        entry: z.string().min(1),
        exports: z.array(z.string()).default([]),
        network: z.enum(['none', 'permissioned']).default('none'),
      }),
    )
    .default([]),
});

export const appStorageFacetSchema = z.object({
  engine: z.enum(['sqlite', 'postgres', 'portable_relational']).default('portable_relational'),
  migrationsDir: z.string().default('migrations'),
  postgresRequirements: z.array(z.string()).default([]),
});

export const appArtifactsFacetSchema = z.object({
  sourceIncluded: z.boolean().default(true),
  sbom: z.string().nullable().optional(),
  provenance: z.string().nullable().optional(),
  datasets: z.array(appArtifactRefSchema).default([]),
});

export const appProtocolProjectionFacetSchema = z.object({
  rest: z.boolean().default(true),
  mcp: z
    .object({ enabled: z.boolean().default(true), tasks: z.boolean().default(true) })
    .default({ enabled: true, tasks: true }),
  a2a: z
    .object({
      enabled: z.boolean().default(true),
      exposeOperations: z.array(z.string()).default([]),
    })
    .default({ enabled: true, exposeOperations: [] }),
});

export function assertDelegationDoesNotAmplify(
  parent: AuthorityContext,
  child: AuthorityContext,
): void {
  const levels: EffectLevel[] = ['read', 'reversible', 'compensatable', 'irreversible'];
  if (parent.workspaceId !== child.workspaceId)
    throw new Error('Delegation cannot cross workspaces.');
  if (levels.indexOf(child.maxEffectLevel) > levels.indexOf(parent.maxEffectLevel)) {
    throw new Error('Delegation cannot increase effect authority.');
  }
  if (
    parent.maxSpendCents != null &&
    (child.maxSpendCents == null || child.maxSpendCents > parent.maxSpendCents)
  ) {
    throw new Error('Delegation cannot increase the spend ceiling.');
  }
  const parentScopes = new Set(parent.scopes);
  if (child.scopes.some((scope) => !parentScopes.has(scope)))
    throw new Error('Delegation cannot add scopes.');
  if (parent.expiresAt && (!child.expiresAt || child.expiresAt > parent.expiresAt)) {
    throw new Error('Delegation cannot outlive its parent authority.');
  }
}
