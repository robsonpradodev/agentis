# 06 · Omni-Reach

Omni-Reach is Agentis's connection surface: the channels, protocol servers, and integrations
agents use to reach people and systems. A **Connection** is one of the six primitives; all
projections share one registry so there is no protocol drift between channels, MCP, and A2A.

## Messaging channels

`apps/api/src/adapters/channels/`, tables `channel_connections`, `channel_peer_identities`,
`channel_deliveries`, `channel_auth_state`, `channel_turn_queue`. Routes: `/v1/channels`.

| Channel | Direction | Notes |
|---------|-----------|-------|
| Discord | outbound (V1) | multipart attachments |
| Slack | bidirectional | threads, file upload via external-upload flow |
| Telegram | bidirectional | webhook or polling; full inbound |
| WhatsApp | bidirectional | Baileys (QR link); media transcription |
| Voice | webhook ingress | transcription in, TTS reply buffer out |

Channel health checks are read-only: pressing **Test connection** validates credentials,
transport, routing, inbound readiness, and runtime availability without sending a message.
An actual outbound test is an explicit channel send.
An unchecked diagnostic is shown as **not yet verified**, not a connection failure. A live
persistent transport is healthy on its own evidence; credential, inbound, outbound, and runtime
checks remain neutral until their optional read-only test runs. Only an observed failed check
degrades or errors the connection.

For WhatsApp QR sessions, the id returned by `sendMessage()` is initially only a client
correlation id. Agentis records that attempt as `queued` and does not report `sent:true`
or advance workflow state until a WhatsApp server acknowledgement arrives. Later server,
delivery, and read receipts promote the durable journal to `accepted`, `delivered`, and
`read`. Requested, provider-resolved, and provider-echoed recipients remain separate in
the receipt so canonical number resolution is visible without being mistaken for proof.
Rich attachments and per-channel access control are supported; peer identity is resolved
across channels. Inbound messages are durably queued (`channel_turn_queue`) and dispatched to
the responsible agent/subject.

### Channel conversation and authority invariants

- `defaultChatId` is a routing fallback only. An explicit `to` always wins, and an omitted
  destination inside an inbound channel turn means that current conversation—not the
  connection-wide default.
- Owner authority requires the exact `channel_peer_identities` handle to be explicitly linked
  to the connection/workspace owner. Matching the default recipient alone never grants owner
  tools, private diagnostics, or owner-grade memory authority.
- The verified channel origin travels with the turn's revocable capability lease, including
  through an adapter-owned MCP loop. An unverified peer can reply only in its originating
  connection/conversation; it cannot initiate a cross-recipient or cross-connection send.
- When the inbound request explicitly names another recipient, the server records that intent
  on the turn. A channel tool call that omits `to`, falls back to the requester, or substitutes
  a different recipient is rejected instead of silently misrouting the message.
- Plain agent text is delivered automatically to the current conversation. A verified
  `agentis.channel.send` to that same peer is reconciled as the final delivery unless it is
  explicitly marked `deliveryRole:"progress"`; this prevents tool delivery plus final-text
  duplication across caller-loop and MCP-native adapters. The provider-backed delivery is
  mirrored into conversation history without being sent again. A send to a different recipient
  does not suppress the natural acknowledgement to the requester.
- A programmatic channel delivery, including a deterministic workflow's first contact, creates
  or reuses the same `(connectionId, chatId)` conversation and is persisted as business-side
  context with its durable delivery key. It starts as `sending` before the provider boundary and
  is reconciled to `sent`/`delivered` or `failed` from the same journal. Therefore the recipient's
  next message continues the exchange rather than starting with an empty transcript.
- Agent-owned connections are an isolation boundary. A workflow resolves through its direct
  `ownerAgentId` (or its owning App's agent), and an agent can use another agent's connection only
  through an active explicit grant. Workspace-owned connections remain shared until governed;
  an unauthorized workspace default is never silently selected over the caller's eligible channel.
  A workflow without an agent/App owner may use only workspace-owned connections until it is
  attributed explicitly.
- Internal strategy state, tool/runtime events, JIDs, connection settings, routing diagnostics,
  and provider receipts remain Agentis telemetry. Channel users receive the natural response;
  the only optional external status is the generic, identity-verified owner reasoning indicator.
- A newly observed, uncorrelated WhatsApp `fromMe` event from the primary phone or another
  companion normally claims that conversation for the human until an explicit **Hand back**. The
  exception is the connection-scoped owner/operator peer, established either by the saved
  `ownerChatId` or a verified Owner identity: it always keeps automation available so the owner can
  talk to their agent naturally. WhatsApp PN, LID, formatting, and device-qualified aliases are
  compared as the same provider peer. Manual-message takeover remains configurable for
  customer conversations. `defaultChatId` never creates the operator exception;
  it can be auto-populated and is routing only. The claim is durable and conversation-local:
  Agentis aborts the active turn and companion lane, revokes the tool lease, clears typing, cancels
  pending durable turn jobs, and fences every automated provider send with a monotonic
  `automationEpoch`. Agentis-originated provider echoes never claim ownership.
  Any stale handoff on an owner/operator conversation is released on its next inbound message;
  customer conversations remain human-owned until explicit **Hand back**.
- Operator messages are business-side conversation context and compile as model role `assistant`;
  customer messages compile as `user`. Platform-chat actor semantics are unchanged. This prevents
  a manual promise such as “I will send the proposal” from being interpreted as a new customer
  instruction when automation resumes.
- Baileys recent/bootstrap history is reconciled silently. Agentis keeps at most 160 messages per
  conversation and 2,000 per sync session, persists them oldest-to-newest idempotently, and never
  starts turns, increments unread, claims ownership, emits replies, or promotes imported text into
  workspace memory. Only the newest 20 imported items per conversation may download media under
  the existing limits; older media keeps truthful type/caption placeholders.
- Model context is separate from the durable transcript: the newest complete exchanges are bounded
  to 20 messages and 12,000 characters, with a relationship summary capped at 1,800 characters and
  advanced by message watermark. History import invalidates and rebuilds that local summary in the
  background without delaying the first live reply.

### Principals, utterances, and continuing relationships

Channel identity is a verified principal, not a reply address. `channel_peer_identities` is scoped
by `(workspaceId, connectionId, channelKind, handle)` and records a durable authority role:
`external`, `owner`, or `delegate`. A workspace has one primary owner person (who may have several
verified handles) and explicit delegates can be revoked or expired. Saving `ownerChatId` from an
authenticated configuration creates this durable owner binding; `defaultChatId` remains routing
only and can never grant control. Settings → Channel identities exposes the binding and authority.
The manual-outbound exception reads this canonical verified Owner binding as well as `ownerChatId`;
delegates and external peers retain normal last-human-responder takeover semantics.
The legacy workspace/channel/handle index must not coexist with the connection-scoped principal
index; migration v136 removes it from databases that briefly recreated it after v135.

Principal authority does not promote the resident agent's organizational role. A worker or
specialist channel receives only its own Brain, relationship, current-channel/media, and App data
tools. It cannot list or reconfigure agents, inspect other connections, or write another agent's
Brain. Orchestrators and managers remain the explicit control-plane roles. On a verified-owner
turn, a worker may persist a durable correction only into its own Brain; omitting the target is
safely narrowed to that agent. Raw SQL/provider/runtime errors stay in operator telemetry and are
replaced by a generic retry message at the external channel boundary.

WhatsApp provider addresses are aliases, not people. `channel_peer_aliases` folds phone-number
JIDs (`@s.whatsapp.net`), LIDs (`@lid`), formatted phone numbers, and later provider mappings into
one connection-scoped canonical peer. `conversations.channel_peer_identity_id` keeps every alias on
the same transcript and relationship. Alias observation uses conflict-safe upserts, so concurrent
history reconciliation and live ingress cannot expose a uniqueness constraint to the customer.
Groups, status broadcasts, and newsletters are excluded from the direct-contact inbox.

`agentis.channel.inbox` gives an authorized agent a bounded, canonical view of recent contacts,
last inbound/outbound activity, message preview, handoff state, relationship stage/goal, aliases,
and an opaque `peer:<id>` `recipientRef`. The selectors `last_inbound` and `last_contact` resolve
requests such as “message the last person who wrote” without asking the operator for a JID. REST
projections are `GET /v1/channels/inbox`, `GET /v1/channels/inbox/resolve`, and
`GET /v1/channels/inbox/:recipientRef`. Workspace and connection authority still apply.

Cross-recipient work is an action, not an improvised send. `channel_action_intents` persists the
recipient, operating agent, requester, goal/relationship reference, exact message, authorization
basis, approval, idempotency key, schedule, attempts, provider receipt, and terminal state before
delivery. `agentis.channel.action.{create,list,cancel}` and `/v1/channels/actions` expose that ledger.
Verified-owner commands can execute immediately; autonomous outreach must point to durable goal or
relationship state and pass the App autonomy/outbound envelope. Quiet hours and rolling rate limits
are re-evaluated at delivery time, approval resolves the exact held action, provider uncertainty is
never blindly resent, and a new inbound reply cancels obsolete planned work for that peer. A
customer-originated turn can never use a `recipientRef` to contact another person.

Provider messages are not model turns. Rapid bubbles are assembled in
`channel_utterance_batches` with a quiet deadline and an eight-second hard deadline; the batch
survives restart and enters the normal durable channel queue once. While cognition is active,
ordinary bubbles join its live mailbox without producing another answer. Only an explicit status
request uses the companion lane.

Every external principal is grounded to one `durable_entities(kind='subject')` relationship actor.
Its bounded state contains identity handles, provenance-bearing facts, engagements/goals/stages,
commitments, open questions, blockers, and one next action. Contacts are a query/UI projection that
links back through `subject_id`. A scheduled next action arms the Subject wake clock, reuses the
normal channel turn/delivery/approval engine, and is cancelled when the person replies first.
Expired low-value facts are archived and eventually pruned; full transcripts and Brain episodes
remain outside the compact Subject state.

App `policy.autonomy` chooses `reply_only`, `policy`, or `broad`, with per-action and per-Subject
overrides. Inbound replies, proactive follow-ups, reads, mutations, contractual/financial,
destructive, cross-recipient, and escalation actions can each be allowed, approval-gated, or denied.
`GET /v1/apps/:appId/contacts` returns each contact with its compact relationship state and effective
case override; `PATCH /v1/apps/:appId/contacts/:contactId/autonomy` changes that case alone.
The existing Brain PACER lifecycle remains authoritative for durable learning.

The allow-listed WhatsApp behavior profile is version 4. Existing settings resolve lazily with safe
defaults: `manualOutboundTakeover:"until_handback"`,
`ownerManualOutboundTakeover:"off"`, and `historyReconciliation:"recent"`. The explicit
`ownerChatId` and optional `ownerName` let the agent recognize its configured owner/operator in
that conversation. Authenticated configuration materializes an explicit owner principal binding;
editing a default recipient does not.
Channel transcript identity is `(workspaceId, connectionId, chatId)`, independent of whichever
agent currently owns the connection. Rebinding an agent or receiving activity in an archived thread
reactivates the same durable transcript instead of creating a context-free parallel conversation.
Operators may configure these behaviors without exposing arbitrary Baileys socket options or
browser-identity knobs. Generic clients can transfer ownership with
`PATCH /v1/conversations/:conversationId/handoff` and `{ "state": "human" | "agent" }`; the App
takeover route delegates to the same service.

Inbound voice notes are understood by default. Agentis first uses a workspace transcription
provider when configured, then a pinned Apache-2.0 local Whisper q8 fallback. The fallback is
channel-scoped: `agentis up` does not globally acquire it. WhatsApp/Telegram startup prepares
its immutable revision and SHA-256-verified artifacts without loading ONNX into memory; the
pipeline loads on first audio. `agentis setup --channels` or `agentis warmup --transcription`
prepares it explicitly, `--repair` preserves the previous cache, and
`AGENTIS_TRANSCRIPTION_OFFLINE=true` forbids network acquisition. OGG/Opus and common channel
audio containers use the packaged portable decoder; system FFmpeg is only a compatibility
fallback for containers outside that decoder set.

Outbound generation is separately configurable per workspace for image, speech/voice, and generic
audio. Each modality accepts a free-text model id, base URL, and optional API key; unauthenticated
local endpoints are valid. The built-in protocol adapters use compatible `/images`, `/audio/speech`,
and `/audio/generations` contracts behind the common media-provider interface. Generated artifacts
can be delivered without a text body, and speech is mapped to a native voice note where supported.

### Audio decoder contract and transcript admission

`@audio/decode` v3 returns an `AudioData`-shaped object (`sampleRate` plus
`channelData: Float32Array[]`), not a Web Audio `AudioBuffer`. Channel code must derive the
sample count from `channelData[0].length`, validate equal channel lengths, then mix and resample
from those real samples. It must not infer sample count from an optional `length` property or
cast an external decoder result unchecked: doing so can turn a valid OGG/Opus voice note into a
near-zero silent buffer and make speech recognition hallucinate text.

Transcript admission is part of the input trust boundary. Empty, impossible-for-duration, or
pathologically repetitive output is rejected before it becomes a channel message, conversation
context, or memory input. Preserve the original attachment and emit structured diagnostics, but
never replace an uncertain transcript with invented content.

### OSS release invariant for channel media

The dependency contract must be tested against the version shipped in the npm tarball, not only a
hand-written mock. The media release gate is: decode a real OGG/Opus fixture through the packaged
dependency, confirm non-zero PCM duration and resampling, execute a local Whisper transcription,
then `npm pack` and install the tarball into a clean directory before exercising the same decoder.
Do not commit private customer voice notes as fixtures; generate or license a small public fixture
for CI. The bundle guard must keep the decoder as an exact runtime dependency so a global npm
install has its codec assets as well as the JavaScript import.

## Email

Four providers: **Gmail** (OAuth), **SMTP** (custom), **Outlook** (OAuth), and **AgentMail**
(agent-native, API-key only — the zero-config "email me" default).

## MCP capability plane (bilateral)

`services/mcp/`. Routes: `/v1/mcp`, `/v1/mcp-servers`, `/v1/mcp-oauth`.

- **Consumer** — mount MCP servers (40+ preconfigured: Supabase, GitHub, Notion, Linear,
  Vercel, Stripe, …). Full OAuth discovery (RFC 9728 / 8414 / 7591 / 7636) with dynamic client
  registration (`mcpOAuthService.ts`). Tools are namespaced `mcp__<slug>__<tool>`, cached, and
  can grant a RAL affordance when tagged (`mcpToolBridge.ts`).
- **Provider** — publish any workflow as an MCP tool over JSON-RPC 2.0 Streamable HTTP; the
  published surface is the same one the engine and chat use.

Unleased external clients receive the compact progressive-disclosure gateway. A native chat
harness carrying a revocable conversation lease instead receives the exact server-selected tool
schemas for that turn; `tools/list`, direct calls, and calls through `agentis.tools.call` enforce the
same allow-list. This preserves model capabilities without creating a second tool owner or a way
to escape channel authority.

- Tools: `agentis.mcp.{list,call}`, `agentis.capability.{search,load,invoke}`.

## Integrations

`services/integrationRegistry.ts`, `packages/integrations/`. Routes: `/v1/integrations`.
~95 connectors across three implementations:

- **Hand-written** — HTTP, Webhook, Slack, Gmail, GitHub, Google Sheets, AgentMail.
- **Templated HTTP** — ~40 connectors auto-rendered from manifests (Supabase, Stripe, Notion,
  …).
- **Generic HTTP fallback** — caller supplies the URL.
- **Custom** — workspace-authored JSON-Schema manifests.

Auth types: none / bearer / api_key / basic / oauth2 / custom-headers. Operation repair
(`integrationOperationRepair.ts`) heals drifted operations. Used from the `integration`
workflow node and `agentis.integration.{list,call}`.

## Agent-to-agent (A2A)

Published workflows are exposed as A2A skills; task reception and invocation run over the same
execution path as MCP (no separate protocol). Route: `/v1/a2a`.

## Webhooks & gateways

Routes: `/v1/webhooks`, `/v1/gateways`. Table `webhook_deliveries`.

- `/v1/webhooks/trigger/:triggerId` — signed inbound trigger (HMAC-SHA256, timestamp +
  idempotency replay defense).
- `/v1/webhooks/connector/:triggerId` — native SaaS connector webhooks (GitHub, Stripe, …).
- `/v1/webhooks/channel/:connectionId` — adapter-specific channel webhooks.
- Outbound deliveries are logged with retry state.

## Safety

- **Credential vault** — per-connection secrets encrypted (see [Sovereignty](./05-sovereignty.md)).
- **Outbound policy** (`services/outboundPolicy.ts`) — gates agent-initiated outreach with
  rate limits, quiet hours, and claim guards; not-allowed sends are held pending approval.
- **SSRF guards** — outbound HTTP is IP-pinned and blocks private ranges by default.

---

**Next:** [07 · Agent-Native Core →](./07-agent-native-core.md)
