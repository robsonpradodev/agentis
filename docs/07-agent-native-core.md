# 07 · Agent-Native Core

The whole platform is exposed to agents as a single typed SDK they operate *as code*. This is
what makes Agentis agent-native rather than agent-adjacent: agents compose behavior in a
language they are fluent in, not by choreographing dozens of discrete tool calls.

## The `agentis.*` tool registry

`services/agentisToolRegistry.ts` + `services/agentisToolHandlers/`. One registry, dispatched
through a single path to chat, the workflow engine, MCP, and code-mode. **More than 130 tools**; every
result is `{ ok, result | error, costCents, durationMs }` — errors are data, never thrown, and
every settled state carries `compass.next` (the Paved Road: an actionable next call).

Families (representative, not exhaustive):

- **Build & prove** — `build_workflow`, `agentis.app.plan`, `agentis.app.verify`, `workflow.{create,patch,validate,dry_run,scope,test,harden,restore_blueprint,bless,deliver}`, `plan_workflow`, `evaluate`, `reflect`, `workflow.{patterns,learn}`.
- **Run & observe** — `run.{await,status,diagnose,cancel,replay,inspect}`, `workflow.{status,list}`, `run.query`, `trace.inspect`, `ephemeral.run`.
- **Data & apps** — `app.{create,list,archive,delete,adopt_workflow,scaffold,plan}`, `data.{define_collection,insert,update,upsert,delete,query,promote_memory}`.
- **UI** — `ui.{render,patch,compose,perform_region,action_schema,lint}`.
- **Memory & knowledge** — `brain.search`, `memory.{write,read,delete}`, `knowledge.{write,search,archive}`, `skill.{load,promote_example}`.
- **Media & assets** — `media.generate`, `assets.{list,search,read,save}`, `browser.{screenshot,navigate,extract_text}`.
- **Channels & conversations** — `channel.{list,send}`, `connection.{request,grant,grants}`, `conversation.{define,enroll,flag_needs_attention}`.
- **Agents & specialists** — `agents.{list,create}`, `agent.{spawn,dispatch}`, `specialist.{create,request}`, `routing.preview`.
- **Extensions & capabilities** — `extension.{create,test,resolve,inspect}`, `extensions.list`, `capability.{search,load,invoke}`.
- **Experiments, tasks, subjects** — `experiment.{define,assign,record,results}`, `task.{accept,set_steps,advance_step,record_decision,flag_deviation,bind_run}`, `subject.{enroll,post,get,list,update_relationship}`. Relationship Subjects keep bounded goals, facts, commitments, blockers, and a restart-durable next action; they do not duplicate Brain episodes or transcripts.
- **Inspect & govern** — `orient`, `space.summary`, `audit_trail`, `approval.{list,resolve}`, `command.{review,note}`, `gateways.status`.

External CLI/IDE harnesses (Claude Code, Codex, Cursor) see a compact MCP gateway rather than a
flat dump of the registry. At most six progressive-disclosure operations are advertised:
`agentis.orient`, `agentis.tools.search`, `agentis.tools.describe`, `agentis.tools.call`,
`agentis.code.execute`, and `agentis.task.status`. Legacy tool names remain directly callable for
compatibility. Ask/Plan/Auto policy is still enforced by the registry, including mutations made
inside code-mode; inner calls retain attribution and advance the lease-state frontier. Gateway
output is bounded to 12,000 characters by default, with explicit `full` or `graph` detail for
larger responses.

Tool activity is normalized before it reaches Chat, the canvas, or observability: a wrapped
`agentis.tools.call` event is rendered as the underlying requested operation, with only a safe
argument summary. Credentials and hidden reasoning are redacted. This keeps the operator-facing
trace useful without exposing gateway plumbing or treating model narration as evidence.

## Code-mode

`services/codeMode.ts`. Agents write async JavaScript against the whole registry as one
`agentis.*` object (`await agentis.workflow.run({...})`, loops, conditionals,
find-or-create-then-wire). Composition happens in code — where LLMs are strongest — instead of
in 70-tool JSON choreography (the Anthropic/Cloudflare result: ~150k → ~2k tokens).

Executed in a locked-down `node:vm` context: no ambient globals, a call cap, and a wall-clock
timeout (defaults: 30 calls, 20s). It is a capability surface + resource governor for the
operator's own trusted agents, **not** a hard security boundary. Returns
`{ ok, result, calls[], logs, error }` — never throws. `agentis.code.api()` returns the
callable surface for discovery. Tools: `agentis.code.{execute,api}`.

## Extensions

Agent-authored operations in a sandbox (`apps/api/src/extensions/`, `services/extensionRuntime.ts`):

- **Runtimes** — `node:vm` fallback (default, not a security boundary), `isolated-vm` V8
  isolate when installed (auto-downgrades otherwise), or opt-in Docker
  (`AGENTIS_EXTENSION_DOCKER`, `AGENTIS_EXTENSION_REQUIRE_ISOLATE`).
- **Permissions** — granular gates: `network`, `network.unrestricted`, `browser`,
  `browser.evaluate`, `browser.session.persist`, `browser.auth`, `listener`, and
  `listener.emit`. Injected HTTP and browser navigation are domain-scoped and SSRF-checked.
- **State** — listener sources hook `ctx.emit()`, `ctx.cursor` / `ctx.setCursor`, and
  `ctx.kv` (workspace-scoped, `extension_kv`).
- **Native browser bridge** — authorized `node_worker` extensions receive serializable
  `ctx.browser` methods backed by the shared headless Chromium pool. Sessions are isolated by
  workspace + extension + name, remain live within configured caps, and persist encrypted
  cookies/storage plus the last URL for restart-safe rehydration. Extensions never receive a
  Playwright object, filesystem path, raw cookie, host process, or CDP access.
- **Build loop** — `agentis.extension.test` dry-runs an operation with sample inputs and
  returns real output + `durationMs`, catching contract violations before wiring it into a
  workflow. Tables: `extensions`, `agent_packages`, `extension_executions`. Routes:
  `/v1/extensions`, `/v1/packages`, `/v1/capabilities`, `/v1/tools`.

**Portable components** are the hardened extension path for multi-file Python 3.12 and Node 20
packages. Its manifest pins the entrypoint, operations, dependency lock, bundle hash, permissions,
allowed domains, CPU/memory/timeout/tmp limits, and optional SBOM and healthcheck. Installation is
content-addressed under `AGENTIS_DATA_DIR/components/<hash>` and rejects traversal, symlinks,
checksum mismatches, missing locks, and missing entrypoints. `component_task` executes the pinned
component revision. Network is `none` by default; a component requesting network fails closed
unless both `AGENTIS_COMPONENT_NETWORK` and `AGENTIS_COMPONENT_EGRESS_PROXY` are configured.
Runtime inspection and installation are exposed through `GET /v1/extensions/runtime-health` and
`POST /v1/extensions/install-component`.

## Media, vision, assets

- `services/mediaService.ts` — `agentis.media.generate`: one capability that dispatches by
  modality (image / audio / speech / video) to a configured, provider-pluggable backend
  (OpenAI-compatible default, no vendor lock-in); supports generation and reference-image edit;
  outputs persist to the asset store.
- `services/visionService.ts` — image understanding; `services/transcriptionService.ts` —
  audio→text; `services/documentExtractionService.ts` — resilient task-input extraction for
  UTF-8/UTF-16 and Windows-1252 text, Markdown/structured text/source files, PDF, DOCX, and XLSX.
  Chat attachment context carries content plus provenance; large documents are bounded with an
  explicit truncation record rather than silently becoming filename-only input.
- `services/assetStore.ts` — content-addressed, deduped by SHA-256; tracks origin (agent / app
  / workflow / channel / manual). Agents persist via `agentis.assets.save` rather than writing
  to disk.

---

Back to the [Agentis README](../README.md) · start over at [00 · Foundation](./00-foundation.md).
