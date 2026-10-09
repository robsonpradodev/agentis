/**
 * genui — the design-taste layer behind surface generation (shared).
 *
 * Classifies an App's data shape into an archetype and composes a distinct,
 * themed, data-bound `ViewNode` tree for it. This is the SINGLE source used by
 * both the API generator (`surfaceGenerator`) and the web "create interface"
 * default (`surfaceTemplates.buildStarterSurface`), so a new surface looks like
 * a designer built it everywhere — no two ways to make a starter surface.
 *
 * APP-INTERFACE-10X: every archetype now scaffolds a MISSION-CONTROL product,
 * not a page — the working composite that fits the data (Kanban / RecordMaster /
 * Roadmap / Chart) beside a live operations rail (RunMonitor + AgentFeed), under
 * the App's OrchestrationPanel. The App Shell (runtime chrome) wraps all of it.
 */
import { z } from 'zod';
import type { CollectionInfo } from './types/datastore.js';
import { accentSchema } from './types/view.js';
import type { SurfaceAction, ViewNode } from './types/view.js';

export type Archetype = 'analytics' | 'pipeline' | 'crm' | 'roadmap' | 'operations';

export interface BuiltSurface {
  view: ViewNode;
  actions: SurfaceAction[];
  archetype: Archetype;
}

function humanize(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

type FormFieldType = 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date';

function formFieldType(type: CollectionInfo['schema']['fields'][number]['type']): FormFieldType {
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'checkbox';
  if (type === 'date') return 'date';
  if (type === 'json') return 'textarea';
  return 'text';
}

interface Ctx {
  name: string;
  columns: Array<{ key: string; label: string }>;
  formFields: Array<{ key: string; label: string; type: FormFieldType; required?: boolean }>;
  createAction: string;
  updateAction: string;
  statusField?: string;
  numberFields: string[];
  dateFields: string[];
  stringFields: string[];
  titleField?: string;
  subtitleField?: string;
  xField: string;
}

const CONTACTISH = /email|phone|company|first_?name|last_?name|full_?name|contact|customer|client|address/i;

function buildCtx(collection: CollectionInfo): Ctx {
  const all = collection.schema.fields;
  const fields = all.filter((f) => f.key !== 'id');
  const base = fields.length > 0 ? fields : all;
  const columns = base.slice(0, 5).map((f) => ({ key: f.key, label: humanize(f.key) }));
  const formSource = fields.length > 0 ? fields : [{ key: 'name', type: 'string' as const, required: false, indexed: false }];
  const formFields = formSource.map((f) => ({
    key: f.key,
    label: humanize(f.key),
    type: formFieldType(f.type),
    ...(f.required ? { required: true } : {}),
  }));
  const statusField = fields.find((f) => ['status', 'stage', 'state'].includes(f.key))?.key;
  const numberFields = fields.filter((f) => f.type === 'number').map((f) => f.key);
  const dateFields = fields.filter((f) => f.type === 'date').map((f) => f.key);
  const stringFields = fields.filter((f) => f.type === 'string').map((f) => f.key);
  const titleField = stringFields.find((k) => k !== statusField);
  const subtitleField = stringFields.find((k) => k !== statusField && k !== titleField);
  const xField = titleField ?? fields[0]?.key ?? 'name';
  return {
    name: collection.name,
    columns,
    formFields,
    createAction: `create_${collection.name}`,
    updateAction: `update_${collection.name}`,
    ...(statusField ? { statusField } : {}),
    numberFields,
    dateFields,
    stringFields,
    ...(titleField ? { titleField } : {}),
    ...(subtitleField ? { subtitleField } : {}),
    xField,
  };
}

/** Insert + update data actions — every working composite (Form, Kanban drag) rides these. */
function crudActions(ctx: Ctx): SurfaceAction[] {
  return [
    { name: ctx.createAction, kind: 'data', target: `${ctx.name}.insert` },
    { name: ctx.updateAction, kind: 'data', target: `${ctx.name}.update` },
  ];
}

function addForm(ctx: Ctx): ViewNode {
  return { type: 'Form', fields: ctx.formFields, submit: { action: ctx.createAction }, submitLabel: 'Add' };
}

function recordsTable(ctx: Ctx): ViewNode {
  return { type: 'Table', bind: { collection: ctx.name, live: true, limit: 25 }, columns: ctx.columns };
}

/** The live operations rail — the App's agentic heartbeat beside the working area. */
function recordsTabs(ctx: Ctx, extra: ViewNode[] = []): ViewNode {
  return {
    type: 'Tabs',
    tabs: [
      { label: 'Records', children: [recordsTable(ctx), ...extra] },
      { label: `Add ${humanize(ctx.name)}`, children: [addForm(ctx)] },
    ],
  };
}

/**
 * Pick the archetype from the data shape — status → pipeline (kanban), dates →
 * roadmap, contact-ish strings → crm, numerics → analytics, else operations.
 */
export function classifyArchetype(collections: CollectionInfo[]): Archetype {
  const collection = collections[0];
  if (!collection) return 'operations';
  const fields = collection.schema.fields.filter((f) => f.key !== 'id');
  if (fields.some((f) => ['status', 'stage', 'state'].includes(f.key))) return 'pipeline';
  if (fields.some((f) => f.type === 'date') && fields.some((f) => f.type === 'string')) return 'roadmap';
  const strings = fields.filter((f) => f.type === 'string');
  if (strings.filter((f) => CONTACTISH.test(f.key)).length >= 2) return 'crm';
  if (fields.some((f) => f.type === 'number')) return 'analytics';
  if (strings.length >= 4) return 'crm';
  return 'operations';
}

// ── Templates ───────────────────────────────────────────────

/** Pipeline (kanban) — stage funnel over a drag-to-move board + the ops rail. */
function pipelineView(ctx: Ctx): BuiltSurface {
  const stageField = ctx.statusField ?? 'status';
  const kanban: ViewNode = {
    type: 'Kanban',
    style: { span: 2 },
    bind: { collection: ctx.name, live: true, limit: 200 },
    groupBy: stageField,
    update: { action: ctx.updateAction },
    ...(ctx.titleField ? { titleField: ctx.titleField } : {}),
    ...(ctx.subtitleField ? { subtitleField: ctx.subtitleField } : {}),
    ...(ctx.numberFields[0] ? { valueField: ctx.numberFields[0] } : {}),
  };
  const flow: ViewNode = {
    type: 'PipelineFlow',
    bind: { collection: ctx.name, live: true, limit: 500 },
    stageField,
    ...(ctx.numberFields[0] ? { valueField: ctx.numberFields[0] } : {}),
  };
  return {
    view: {
      type: 'Stack',
      gap: 16,
      style: { theme: 'product', design: 'editorial', density: 'compact' },
      children: [
        { type: 'Hero', eyebrow: 'Pipeline', title: humanize(ctx.name), subtitle: 'Move work forward with a live stage view.' },
        { type: 'Toolbar', title: humanize(ctx.name), children: [{ type: 'Badge', value: 'Live pipeline', tone: 'success' }] },
        { type: 'OrchestrationPanel' },
        flow,
        kanban,
        { type: 'ActivityStream', title: 'Recent movement', limit: 12 },
        recordsTabs(ctx),
      ],
    },
    actions: crudActions(ctx),
    archetype: 'pipeline',
  };
}

/** CRM — master-detail record workspace + the ops rail. */
function crmView(ctx: Ctx): BuiltSurface {
  const records: ViewNode = {
    type: 'RecordMaster',
    style: { span: 3 },
    bind: { collection: ctx.name, live: true, limit: 200 },
    ...(ctx.titleField ? { titleField: ctx.titleField } : {}),
    ...(ctx.subtitleField ? { subtitleField: ctx.subtitleField } : {}),
    ...(ctx.statusField ? { statusField: ctx.statusField } : {}),
  };
  return {
    view: {
      type: 'Stack',
      gap: 16,
      style: { theme: 'product', design: 'operations' },
      children: [
        { type: 'Hero', eyebrow: 'Relationships', title: humanize(ctx.name), subtitle: 'Search, review, and update the complete relationship history.' },
        { type: 'Toolbar', title: humanize(ctx.name), children: [{ type: 'Text', value: 'Search, review, and update the complete relationship history.' }] },
        records,
        { type: 'Accordion', sections: [{ title: `Add ${humanize(ctx.name)}`, children: [addForm(ctx)] }] },
      ],
    },
    actions: crudActions(ctx),
    archetype: 'crm',
  };
}

/** Roadmap — time lanes from the date fields + the ops rail. */
function roadmapView(ctx: Ctx): BuiltSurface {
  const start = ctx.dateFields[0] ?? 'date';
  const roadmap: ViewNode = {
    type: 'Roadmap',
    bind: { collection: ctx.name, live: true, limit: 200 },
    labelField: ctx.titleField ?? ctx.xField,
    startField: start,
    ...(ctx.dateFields[1] ? { endField: ctx.dateFields[1] } : {}),
    ...(ctx.statusField ? { laneField: ctx.statusField, statusField: ctx.statusField } : {}),
  };
  const table: ViewNode = { ...recordsTable(ctx), style: { span: 2 } };
  return {
    view: {
      type: 'Stack',
      gap: 16,
      style: { theme: 'product', design: 'agentis' },
      children: [
        { type: 'Hero', eyebrow: 'Plan', title: humanize(ctx.name), subtitle: 'Sequence milestones, dates, and delivery risk.' },
        roadmap,
        { type: 'Split', ratio: 2, left: table, right: { type: 'RunMonitor', title: 'Delivery automations', limit: 5, controls: true } },
        { type: 'Tabs', tabs: [{ label: `Add ${humanize(ctx.name)}`, children: [addForm(ctx)] }] },
      ],
    },
    actions: crudActions(ctx),
    archetype: 'roadmap',
  };
}

function analyticsView(ctx: Ctx): BuiltSurface {
  const y0 = ctx.numberFields[0] ?? ctx.xField;
  const chartCard: ViewNode = {
    type: 'Card',
    title: 'Trend',
    style: { span: 2 },
    children: [{
      type: 'Chart',
      bind: { collection: ctx.name, live: true, limit: 50 },
      chartType: 'area',
      x: ctx.xField,
      y: y0,
      area: true,
      curve: 'smooth',
      legend: ctx.numberFields.length > 1,
      ...(ctx.numberFields.length > 1 ? { series: ctx.numberFields.slice(0, 3).map((y) => ({ y, label: humanize(y) })) } : {}),
    }],
  };
  return {
    view: {
      type: 'Stack',
      gap: 16,
      style: { theme: 'analytics', design: 'agentis' },
      children: [
        { type: 'Hero', eyebrow: 'Analytics', title: humanize(ctx.name), subtitle: 'Read the signal, then inspect the records behind each movement.' },
        { type: 'Narrative', title: 'Reading the signal', value: 'Explore the trend, then inspect the records behind each movement.', tone: 'brief' },
        chartCard,
        recordsTabs(ctx),
      ],
    },
    actions: crudActions(ctx),
    archetype: 'analytics',
  };
}

function operationsView(ctx: Ctx): BuiltSurface {
  const overview: ViewNode[] = [];
  if (ctx.numberFields[0]) {
    overview.push({
      type: 'Card',
      title: 'Trend',
      children: [{ type: 'Chart', bind: { collection: ctx.name, live: true, limit: 50 }, chartType: 'area', x: ctx.xField, y: ctx.numberFields[0], area: true, curve: 'smooth' }],
    });
  }
  overview.push(recordsTable(ctx));
  const main: ViewNode = {
    type: 'Tabs',
    style: { span: 2 },
    tabs: [
      { label: 'Overview', children: overview },
      { label: `Add ${humanize(ctx.name)}`, children: [addForm(ctx)] },
    ],
  };
  return {
    view: {
      type: 'Stack',
      gap: 16,
      style: { theme: 'operations', design: 'agentis' },
      children: [
        { type: 'Hero', eyebrow: 'Operations', title: humanize(ctx.name), subtitle: 'Keep the work moving with a clear operational view.' },
        { type: 'Toolbar', title: humanize(ctx.name), children: [{ type: 'Badge', value: 'Operational', tone: 'neutral' }] },
        { type: 'OrchestrationPanel' },
        { type: 'Split', ratio: 2, left: main, right: { type: 'Stack', gap: 12, children: [{ type: 'RunMonitor', limit: 5 }, { type: 'AgentFeed', limit: 12 }] } },
      ],
    },
    actions: crudActions(ctx),
    archetype: 'operations',
  };
}

function emptyView(): BuiltSurface {
  return {
    view: {
      type: 'Stack',
      gap: 16,
      style: { theme: 'operations', design: 'agentis' },
      children: [
        { type: 'Hero', title: 'Your app' },
        { type: 'OrchestrationPanel' },
        {
          type: 'Grid',
          columns: 3,
          gap: 16,
          children: [
            { type: 'Stack', gap: 12, style: { span: 2 }, children: [{ type: 'RunMonitor' }, { type: 'ApprovalsInbox' }] },
            { type: 'Stack', gap: 12, style: { span: 1 }, children: [{ type: 'AgentFeed', limit: 20 }, { type: 'ActivityStream', title: 'Live activity' }] },
          ],
        },
      ],
    },
    actions: [],
    archetype: 'operations',
  };
}

/** Build a complete, archetype-matched, themed surface for the App's first collection. */
export function buildArchetypeSurface(collections: CollectionInfo[]): BuiltSurface {
  const collection = collections[0];
  if (!collection) return emptyView();
  const ctx = buildCtx(collection);
  switch (classifyArchetype(collections)) {
    case 'pipeline':
      return pipelineView(ctx);
    case 'crm':
      return crmView(ctx);
    case 'roadmap':
      return roadmapView(ctx);
    case 'analytics':
      return analyticsView(ctx);
    default:
      return operationsView(ctx);
  }
}

// ── InterfaceSpec — the typed intent layer (INTERFACE-OVERHAUL-10X §1.2) ────
// Agents author INTENT (pages: purpose + collection + copy + app-wide look
// knobs); THIS compiler owns composition. Every layout decision is made once,
// here, deterministically — never per-app by a model. The spec is small and
// zod-validatable, so a bad spec fails loud at the boundary, not as bad pixels.

export const interfacePageSpecSchema = z.object({
  /** Surface/page name ("home", "board", "records" — becomes a shell sidebar page). */
  name: z.string().min(1).max(120),
  /**
   * What the page is FOR — the compiler picks the professionally fixed template:
   * mission-control = the app home (archetype auto-classified from the data,
   * orchestration + live rail); board = Kanban pipeline; records = master-detail
   * workspace; roadmap = time lanes; analytics = charts-first; operations = the
   * dense default.
   */
  purpose: z.enum(['mission-control', 'board', 'records', 'roadmap', 'analytics', 'operations']),
  /** Primary collection the page works (defaults to the app's first collection). */
  collection: z.string().optional(),
  /** Page title/subtitle copy (defaults derive from the collection name). */
  title: z.string().optional(),
  subtitle: z.string().optional(),
});
export type InterfacePageSpec = z.infer<typeof interfacePageSpecSchema>;

export const interfaceSpecSchema = z.object({
  /** App-wide appearance pin (auto = follow the platform theme). */
  appearance: z.enum(['auto', 'light', 'dark']).optional(),
  /** App-wide accent re-branding (token-backed, no raw hex). */
  accent: accentSchema.optional(),
  pages: z.array(interfacePageSpecSchema).min(1),
});
export type InterfaceSpec = z.infer<typeof interfaceSpecSchema>;

export interface CompiledPage extends BuiltSurface {
  name: string;
}

/** Stamp app-wide look knobs on the root + page copy on the leading Hero. */
function applyPageChrome(view: ViewNode, page: InterfacePageSpec, spec: InterfaceSpec): ViewNode {
  let out = view;
  const appearance = spec.appearance && spec.appearance !== 'auto' ? spec.appearance : undefined;
  if (appearance || spec.accent) {
    out = {
      ...out,
      style: {
        ...out.style,
        ...(appearance ? { appearance } : {}),
        ...(spec.accent ? { accent: spec.accent } : {}),
      },
    } as ViewNode;
  }
  if ((page.title || page.subtitle) && 'children' in out && Array.isArray(out.children)) {
    const idx = out.children.findIndex((c) => c.type === 'Hero');
    if (idx >= 0) {
      const hero = out.children[idx] as Extract<ViewNode, { type: 'Hero' }>;
      const children = [...out.children];
      children[idx] = {
        ...hero,
        ...(page.title ? { title: page.title } : {}),
        ...(page.subtitle ? { subtitle: page.subtitle } : {}),
      } as ViewNode;
      out = { ...out, children } as ViewNode;
    }
  }
  return out;
}

/**
 * Lower an InterfaceSpec to complete, gate-clean surfaces — one per page.
 * Rides the SAME archetype builders the scaffold uses (single taste engine).
 * The caller persists each page as a surface (its declared actions included),
 * where the operability gate runs as usual.
 */
export function compileInterfaceSpec(spec: InterfaceSpec, collections: CollectionInfo[]): CompiledPage[] {
  return spec.pages.map((page) => {
    const primary = page.collection ? collections.find((c) => c.name === page.collection) : collections[0];
    const scoped = primary ? [primary, ...collections.filter((c) => c.name !== primary.name)] : collections;
    let built: BuiltSurface;
    if (page.purpose === 'mission-control' || !primary) {
      built = buildArchetypeSurface(scoped);
    } else {
      const ctx = buildCtx(primary);
      switch (page.purpose) {
        case 'board':
          built = pipelineView(ctx);
          break;
        case 'records':
          built = crmView(ctx);
          break;
        case 'roadmap':
          built = roadmapView(ctx);
          break;
        case 'analytics':
          built = analyticsView(ctx);
          break;
        default:
          built = operationsView(ctx);
      }
    }
    return { ...built, view: applyPageChrome(built.view, page, spec), name: page.name };
  });
}
