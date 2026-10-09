import { createHash } from 'node:crypto';
import { AgentisError, type AgentisToolContext } from '@agentis/core';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { ChannelKind, ChannelQuote, OutboundAttachmentRef, OutboundNativeContent } from '../../adapters/channels/types.js';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { resolveAndSend } from '../conversation/channelSend.js';
import { normalizeHandle } from '../conversation/channelAccess.js';
import type { ChannelPostAckMutation } from '../conversation/channelActionIntentService.js';

const CHANNEL_KINDS = new Set<ChannelKind>(['telegram', 'discord', 'slack', 'whatsapp', 'voice']);

function sameChannelRecipient(kind: string, left: string, right: string): boolean {
  if (kind === 'whatsapp' || kind === 'telegram') {
    const a = normalizeHandle(left);
    const b = normalizeHandle(right);
    return Boolean(a && b && a === b);
  }
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Stable for identical calls inside one durable turn/run, different for a new
 * explicit owner command. Provider and action ledgers both use this key. */
function channelToolIdempotencyKey(
  ctx: AgentisToolContext,
  operation: string,
  payload: Record<string, unknown>,
): string {
  const turn = ctx.missionId ?? ctx.durableTurnId ?? ctx.channelOrigin?.durableTurnId ?? ctx.runId ?? ctx.conversationId ?? 'undurable';
  const canonical = JSON.stringify(stableChannelPayload(payload));
  const digest = createHash('sha256').update(`${ctx.workspaceId}\n${ctx.agentId ?? ''}\n${turn}\n${operation}\n${canonical}`).digest('hex');
  return `agent-tool:${digest}`;
}

function stableChannelPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableChannelPayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableChannelPayload(entry)]));
  }
  return value;
}

/** One attachment item — shared by the top-level `attachments` and each `messages[]` entry. */
const ATTACHMENT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'artifact:<id>, data: URL, or http(s) URL.' },
    artifactId: { type: 'string', description: 'Artifact id (alternative to url).' },
    filename: { type: 'string' },
    mimeType: { type: 'string' },
    kind: { type: 'string', enum: ['image', 'video', 'audio', 'voice', 'sticker', 'file'], description: 'Delivery hint; inferred from MIME type when omitted. "voice" = a push-to-talk voice note; "sticker" = WebP.' },
    text: { type: 'string', description: 'For a spoken voice note with no file: set kind:"voice" and put the words here — a voice model synthesizes it (no encoding to worry about).' },
    caption: { type: 'string', description: 'Per-attachment caption.' },
  },
} as const;

const NATIVE_CONTENT_SCHEMA = {
  type: 'object',
  description: 'Provider-native location, contact card, or poll. Send separately from file attachments.',
  properties: {
    kind: { type: 'string', enum: ['location', 'contact', 'poll'] },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    name: { type: 'string' },
    address: { type: 'string' },
    displayName: { type: 'string' },
    phone: { type: 'string' },
    vcard: { type: 'string' },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    selectableCount: { type: 'number' },
  },
  required: ['kind'],
} as const;

export function registerChannelTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.channel.list',
        family: 'inspect',
        description: 'List native Agentis messaging channels, health, and transport capabilities. Use before sending to Telegram, WhatsApp, Slack, or Discord. mediaKinds means the channel can transport an existing artifact; it does not imply Agentis can generate that medium.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...CHANNEL_KINDS] },
            status: { type: 'string' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const kind = parseKind(args.kind);
        const status = typeof args.status === 'string' ? args.status : null;
        const channels = deps.channels
          .list(ctx.workspaceId)
          .filter((connection) => !kind || connection.kind === kind)
          .filter((connection) => !status || connection.status === status)
          .map((connection) => ({
            id: connection.id,
            kind: connection.kind,
            name: connection.name,
            appId: connection.appId,
            status: connection.status,
            mode: connection.mode,
            transport: connection.transport,
            defaultChatId: connection.defaultChatId,
            targetAliases: connection.targetAliases,
            health: connection.health,
            capabilities: deps.channels!.capabilitiesFor(connection.id),
            mediaGeneration: {
              modalities: deps.media?.modalities(ctx.workspaceId) ?? [],
              note: 'Separate from transport mediaKinds; only these modalities can be created from a prompt.',
            },
            lastError: connection.lastError,
          }));
        return { count: channels.length, channels };
      },
    },
    {
      definition: {
        id: 'agentis.channel.inbox',
        family: 'inspect',
        description: 'See the authorized channel inbox holistically: recent contacts, names, last inbound/outbound messages, relationship state, and stable recipientRef values. Use selector:"last_inbound" for “the last person who messaged”; never ask for a phone number or JID when this tool resolves a recipient.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['recent', 'search', 'get', 'history', 'resolve'], description: 'Default: recent.' },
            connectionId: { type: 'string' },
            query: { type: 'string', description: 'Contact name, alias, phone, username, or other provider identity.' },
            recipientRef: { type: 'string', description: 'Stable peer:<id> reference returned by this tool.' },
            conversationId: { type: 'string' },
            selector: { type: 'string', enum: ['last_inbound', 'last_contact'] },
            limit: { type: 'number', minimum: 1, maximum: 50 },
            cursor: { type: 'string' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.channelInbox) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel inbox is not configured');
        const operation = typeof args.operation === 'string' ? args.operation : 'recent';
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId : ctx.channelOrigin?.connectionId ?? null;
        if (operation === 'get') {
          const ref = typeof args.recipientRef === 'string' ? args.recipientRef : '';
          const peer = deps.channelInbox.get(ctx.workspaceId, ref);
          if (!peer) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel recipient not found');
          return { peer };
        }
        if (operation === 'history') {
          const ref = typeof args.recipientRef === 'string' ? args.recipientRef : '';
          return { recipientRef: ref, messages: deps.channelInbox.history(ctx.workspaceId, ref, numericLimit(args.limit, 30)) };
        }
        if (operation === 'resolve') {
          return deps.channelInbox.resolve({
            workspaceId: ctx.workspaceId,
            connectionId,
            recipientRef: typeof args.recipientRef === 'string' ? args.recipientRef : null,
            conversationId: typeof args.conversationId === 'string' ? args.conversationId : null,
            query: typeof args.query === 'string' ? args.query : null,
            selector: args.selector === 'last_inbound' ? 'last_inbound' : args.selector === 'last_contact' ? 'last_contact' : undefined,
          });
        }
        return deps.channelInbox.list({
          workspaceId: ctx.workspaceId,
          connectionId,
          query: operation === 'search' && typeof args.query === 'string' ? args.query : null,
          excludeOwner: true,
          limit: numericLimit(args.limit, 20),
          cursor: typeof args.cursor === 'string' ? args.cursor : null,
        });
      },
    },
    {
      definition: {
        id: 'agentis.channel.action.create',
        family: 'run',
        description: 'Create and, when authorized and due now, execute a durable goal-scoped outbound action to a canonical recipientRef. Verified-owner commands execute immediately; autonomous outreach must reference a subjectId or goalRef. Delivery is idempotent and resumable.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            recipientRef: { type: 'string' },
            recipientQuery: { type: 'string', description: 'Name, phone, or selector to resolve; retained as a durable missing slot when unresolved.' },
            goal: { type: 'string' },
            goalRef: { type: 'string' },
            subjectId: { type: 'string' },
            body: { type: 'string' },
            messages: { type: 'array', items: { type: 'object', properties: { body: { type: 'string' } } } },
            scheduledFor: { type: 'string' },
            requireApproval: { type: 'boolean' },
            postAckMutations: { type: 'array', items: { type: 'object' }, description: 'Data mutations committed only after provider acknowledgement.' },
          },
          required: ['goal'],
        },
        mutating: true,
        approval: { riskLevel: 'medium', reversible: false, externalSideEffects: true },
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channelActions) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel action engine is not configured');
        if (!ctx.agentId) throw new AgentisError('VALIDATION_FAILED', 'an operating agent is required');
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId : ctx.channelOrigin?.connectionId ?? '';
        const recipientRef = typeof args.recipientRef === 'string' ? args.recipientRef : undefined;
        const goal = typeof args.goal === 'string' ? args.goal : '';
        const ownerIdentity = ctx.channelOrigin?.ownerVerified && deps.channelIdentity
          ? deps.channelIdentity.principal({ workspaceId: ctx.workspaceId, connectionId: ctx.channelOrigin.connectionId, channelKind: ctx.channelOrigin.kind, handle: ctx.channelOrigin.chatId }).identityId
          : null;
        const body = typeof args.body === 'string' ? args.body : '';
        const messages = Array.isArray(args.messages) ? parseMessages(args.messages) : undefined;
        const recipientQuery = typeof args.recipientQuery === 'string' ? args.recipientQuery : undefined;
        return deps.channelActions.createAndExecute({
          workspaceId: ctx.workspaceId,
          appId: ctx.appId,
          agentId: ctx.agentId,
          missionId: ctx.missionId ?? null,
          requesterIdentityId: ownerIdentity,
          connectionId,
          recipientRef,
          recipientQuery,
          conversationId: null,
          subjectId: typeof args.subjectId === 'string' ? args.subjectId : null,
          goalRef: typeof args.goalRef === 'string' ? args.goalRef : null,
          goal,
          body,
          messages,
          authorizationBasis: ctx.channelOrigin?.ownerVerified ? 'verified_owner_command' : 'standing_goal',
          scheduledFor: typeof args.scheduledFor === 'string' ? args.scheduledFor : null,
          requireApproval: args.requireApproval === true,
          idempotencyKey: channelToolIdempotencyKey(ctx, 'action.create', {
            connectionId, recipientRef: recipientRef ?? '', recipientQuery: recipientQuery ?? '', goal,
            goalRef: typeof args.goalRef === 'string' ? args.goalRef : '',
            subjectId: typeof args.subjectId === 'string' ? args.subjectId : '', body, messages: messages ?? [],
          }),
          userId: ctx.userId,
          postAckMutations: parsePostAckMutations(args.postAckMutations),
        });
      },
    },
    {
      definition: {
        id: 'agentis.channel.action.resume',
        family: 'run',
        description: 'Fill the missing recipient on a durable channel action and resume its authorized delivery without re-drafting or re-asking approval.',
        inputSchema: { type: 'object', properties: { actionId: { type: 'string' }, recipient: { type: 'string' } }, required: ['actionId', 'recipient'] },
        mutating: true,
        approval: { riskLevel: 'medium', reversible: false, externalSideEffects: true },
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channelActions) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel action engine is not configured');
        return { action: await deps.channelActions.resolveRecipientAndExecute(ctx.workspaceId, String(args.actionId ?? ''), String(args.recipient ?? '')) };
      },
    },
    {
      definition: {
        id: 'agentis.channel.action.list',
        family: 'inspect',
        description: 'List durable planned, approval-held, executing, delivered, failed, or cancelled channel actions.',
        inputSchema: { type: 'object', properties: { connectionId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 } } },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.channelActions) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel action engine is not configured');
        return { actions: deps.channelActions.list(ctx.workspaceId, {
          ...(typeof args.connectionId === 'string' ? { connectionId: args.connectionId } : {}),
          ...(typeof args.status === 'string' ? { status: args.status as never } : {}),
          limit: numericLimit(args.limit, 30),
        }) };
      },
    },
    {
      definition: {
        id: 'agentis.channel.action.cancel',
        family: 'run',
        description: 'Cancel a pending durable channel action before delivery.',
        inputSchema: { type: 'object', properties: { actionId: { type: 'string' }, reason: { type: 'string' } }, required: ['actionId'] },
        mutating: true,
        approval: { riskLevel: 'low', reversible: false, externalSideEffects: false },
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.channelActions) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel action engine is not configured');
        return { action: deps.channelActions.cancel(ctx.workspaceId, String(args.actionId ?? ''), typeof args.reason === 'string' ? args.reason : 'cancelled by agent') };
      },
    },
    {
      definition: {
        id: 'agentis.connection.bind_app',
        family: 'run',
        description: 'Bind a native channel connection to an Agentic App so inbound conversations run in that App context. Pass appId:null to unbind. Both resources must belong to this workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            appId: { type: ['string', 'null'], description: 'App id to bind, or null to clear the binding.' },
          },
          required: ['connectionId', 'appId'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
        if (!connectionId) throw new AgentisError('VALIDATION_FAILED', 'connectionId is required');
        const appId = args.appId === null ? null : typeof args.appId === 'string' ? args.appId.trim() : '';
        if (appId === '') throw new AgentisError('VALIDATION_FAILED', 'appId must be a non-empty App id or null');

        const connection = deps.db.select({ agentId: schema.channelConnections.agentId })
          .from(schema.channelConnections)
          .where(and(
            eq(schema.channelConnections.id, connectionId),
            eq(schema.channelConnections.workspaceId, ctx.workspaceId),
          )).get();
        if (!connection) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${connectionId} not found`);
        if (ctx.agentId && deps.connectionGrants) {
          const decision = deps.connectionGrants.authorize({
            workspaceId: ctx.workspaceId,
            connectionId,
            agentId: ctx.agentId,
            required: 'manage',
            ownerAgentId: connection.agentId,
          });
          if (!decision.ok) throw new AgentisError('CONNECTION_SCOPE_MISSING', decision.reason ?? 'manage access to this connection is required');
        }
        const bound = deps.channels.bindApp(ctx.workspaceId, connectionId, appId);
        return {
          bound: appId !== null,
          connectionId: bound.id,
          appId: bound.appId,
          message: appId ? `Channel is now bound to App ${appId}.` : 'Channel App binding was cleared.',
        };
      },
    },
    {
      definition: {
        id: 'agentis.channel.reply',
        family: 'run',
        description: [
          'Send rich content to the CURRENT inbound channel conversation; no connectionId or recipient is needed or accepted.',
          'Use this instead of printing attachment syntax or provider formats into chat.',
          'Existing file/image/video/audio/sticker: attachments:[{url:"artifact:<id>",kind:"file|image|video|audio|sticker",filename:"name.ext"}].',
          'Spoken WhatsApp voice note: attachments:[{kind:"voice",text:"words to speak"}].',
          'Native contact: native:{kind:"contact",displayName:"Name",phone:"+15551234567"}.',
          'Native location: native:{kind:"location",latitude:0,longitude:0,name:"Place"}.',
          'Native poll: native:{kind:"poll",question:"Question",options:["A","B"]}.',
          'A successful delivery returns sent:true plus provider acknowledgement; never claim delivery without it.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            body: { type: 'string', description: 'Optional caption or accompanying message.' },
            quotedMessage: {
              type: 'object',
              description: 'Quote a message from the current conversation using its local message id.',
              properties: { messageId: { type: 'string' } },
              required: ['messageId'],
              additionalProperties: false,
            },
            deliveryRole: {
              type: 'string',
              enum: ['progress', 'final'],
              description: 'Defaults to final. Use progress only when another final answer will follow.',
            },
            attachments: {
              type: 'array',
              description: 'Existing artifacts/data URLs/HTTP URLs or text synthesized as a voice note.',
              items: ATTACHMENT_ITEM_SCHEMA,
            },
            native: NATIVE_CONTENT_SCHEMA,
            messages: {
              type: 'array',
              description: 'Optional ordered burst to the current conversation. Each item is a separate provider message.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  body: { type: 'string' },
                  attachments: { type: 'array', items: ATTACHMENT_ITEM_SCHEMA },
                  native: NATIVE_CONTENT_SCHEMA,
                  quotedMessage: {
                    type: 'object',
                    properties: { messageId: { type: 'string' } },
                    required: ['messageId'],
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
        mutating: true,
        approval: { riskLevel: 'medium', reversible: false, externalSideEffects: true },
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const origin = ctx.channelOrigin;
        if (!origin) {
          throw new AgentisError(
            'VALIDATION_FAILED',
            'agentis.channel.reply is available only while answering an inbound channel conversation; use agentis.channel.send elsewhere',
          );
        }
        const attachments = parseAttachments(args.attachments);
        const messages = Array.isArray(args.messages) ? parseMessages(args.messages) : undefined;
        const quotedMessage = parseQuotedMessage(args.quotedMessage);
        if (quotedMessage && messages?.length && !messages[0]!.quotedMessage) {
          messages[0]!.quotedMessage = quotedMessage;
        }
        return resolveAndSend(
          { channels: deps.channels, ...(deps.connectionGrants ? { connectionGrants: deps.connectionGrants } : {}) },
          {
            workspaceId: ctx.workspaceId,
            body: typeof args.body === 'string' ? args.body : '',
            connectionId: origin.connectionId,
            kind: origin.kind,
            to: origin.chatId,
            agentId: ctx.agentId ?? null,
            deliveryRole: args.deliveryRole === 'progress' ? 'progress' : 'final',
            attachments,
            ...(quotedMessage ? { quotedMessage } : {}),
            ...(args.native != null ? { native: parseNativeContent(args.native) } : {}),
            ...(messages ? { messages } : {}),
            idempotencyKey: channelToolIdempotencyKey(ctx, 'channel.reply', {
              connectionId: origin.connectionId,
              chatId: origin.chatId,
              body: typeof args.body === 'string' ? args.body : '',
              deliveryRole: args.deliveryRole === 'progress' ? 'progress' : 'final',
              attachments,
              quotedMessage: quotedMessage ?? null,
              native: args.native ?? null,
              messages: messages ?? [],
            }),
            ...(origin.conversationId ? { conversationId: origin.conversationId } : {}),
            ...(origin.automationEpoch !== undefined ? { expectedAutomationEpoch: origin.automationEpoch } : {}),
          },
        );
      },
    },
    {
      definition: {
        id: 'agentis.channel.send',
        family: 'run',
        description: 'Send a message through a native Agentis channel. Prefer recipientRef from agentis.channel.inbox for another contact; Agentis resolves provider addresses internally and records an idempotent action. Raw `to` remains for explicit phone/JID/backward compatibility. In a channel-origin turn, omit the destination only for the current conversation.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'Specific channel connection id. Optional when kind resolves to one active channel.' },
            kind: { type: 'string', enum: [...CHANNEL_KINDS], description: 'Channel kind to use when connectionId is omitted.' },
            to: { type: 'string', description: 'Channel destination. Use "default" or omit for the saved default target. WhatsApp may be a phone number, JID, or saved alias.' },
            recipientRef: { type: 'string', description: 'Stable peer:<id> returned by agentis.channel.inbox. Preferred for known contacts.' },
            conversationId: { type: 'string', description: 'Resolve the canonical recipient from an existing channel conversation.' },
            goal: { type: 'string', description: 'Why this cross-recipient send advances the owner command or standing goal.' },
            goalRef: { type: 'string', description: 'Durable plan/goal id for autonomous outreach.' },
            subjectId: { type: 'string', description: 'Durable relationship Subject for goal-scoped outreach.' },
            body: { type: 'string', description: 'Message body / caption. May be empty when sending attachments only. Ignored when messages[] is provided.' },
            deliveryRole: {
              type: 'string',
              enum: ['progress', 'final'],
              description: 'Optional lifecycle role. "progress" is a non-terminal update/acknowledgement; "final" means this tool delivery is the turn final answer.',
            },
            attachments: {
              type: 'array',
              description: 'Media to deliver. Each item points at one source: an artifact ("artifact:<id>" or artifactId), a data: URL, or an http(s) URL.',
              items: ATTACHMENT_ITEM_SCHEMA,
            },
            native: NATIVE_CONTENT_SCHEMA,
            quotedMessage: {
              type: 'object',
              description: 'Quote a message in the destination conversation using its local message id.',
              properties: { messageId: { type: 'string' } },
              required: ['messageId'],
              additionalProperties: false,
            },
            messages: {
              type: 'array',
              description: 'Send these as a natural burst, in order, to the same destination. Each item is its own message with an optional body and attachments. When set, top-level body/attachments are ignored.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Stable item id within this ordered burst.' },
                  requirementId: { type: 'string', description: 'Mission requirement id satisfied by this item after provider acknowledgement.' },
                  body: { type: 'string' },
                  attachments: { type: 'array', items: ATTACHMENT_ITEM_SCHEMA },
                  native: NATIVE_CONTENT_SCHEMA,
                  quotedMessage: {
                    type: 'object',
                    properties: { messageId: { type: 'string' } },
                    required: ['messageId'],
                    additionalProperties: false,
                  },
                },
              },
            },
            postAckMutations: { type: 'array', items: { type: 'object' }, description: 'App record updates to commit only after provider acknowledgement.' },
          },
        },
        mutating: true,
        approval: { riskLevel: 'medium', reversible: false, externalSideEffects: true },
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        let connectionId = typeof args.connectionId === 'string' ? args.connectionId : null;
        let kind = typeof args.kind === 'string' ? args.kind : null;
        let to = typeof args.to === 'string' ? args.to : null;
        const origin = ctx.channelOrigin;
        const recipientRef = typeof args.recipientRef === 'string' ? args.recipientRef : null;
        const targetConversationId = typeof args.conversationId === 'string' ? args.conversationId : null;
        if ((recipientRef || targetConversationId) && deps.channelInbox) {
          const resolved = deps.channelInbox.resolve({
            workspaceId: ctx.workspaceId,
            connectionId,
            recipientRef,
            conversationId: targetConversationId,
          });
          if (!resolved.resolved) throw new AgentisError('CHANNEL_TARGET_AMBIGUOUS_OR_MISSING', 'The canonical recipient could not be resolved.', { details: { candidates: resolved.candidates } });
          if (origin && !origin.ownerVerified) {
            const originPeerId = deps.channelIdentity?.principal({
              workspaceId: ctx.workspaceId,
              connectionId: origin.connectionId,
              channelKind: origin.kind,
              handle: origin.chatId,
            }).identityId ?? null;
            const sameCanonicalPeer = originPeerId
              ? originPeerId === resolved.peer.peerIdentityId
              : resolved.peer.connectionId === origin.connectionId
                && sameChannelRecipient(origin.kind, resolved.to, origin.chatId);
            if (!sameCanonicalPeer) {
              throw new AgentisError(
                'CONNECTION_SCOPE_MISSING',
                'A customer-originated turn cannot initiate an action toward another contact.',
                { remediation: 'Cross-recipient actions require a verified owner command or an authorized goal-driven background task.' },
              );
            }
          }
          connectionId = resolved.peer.connectionId;
          kind = resolved.peer.channelKind;
          to = resolved.to;
          if (deps.channelActions && ctx.agentId) {
            const requesterIdentityId = origin?.ownerVerified && deps.channelIdentity
              ? deps.channelIdentity.principal({ workspaceId: ctx.workspaceId, connectionId: origin.connectionId, channelKind: origin.kind, handle: origin.chatId }).identityId
              : null;
            const body = typeof args.body === 'string' ? args.body : '';
            const attachments = parseAttachments(args.attachments);
            const messages = Array.isArray(args.messages) ? parseMessages(args.messages) : undefined;
            const quotedMessage = parseQuotedMessage(args.quotedMessage);
            if (quotedMessage && messages?.length && !messages[0]!.quotedMessage) {
              messages[0]!.quotedMessage = quotedMessage;
            }
            const durableMessages = messages ?? (attachments.length > 0 || args.native != null || quotedMessage
              ? [{ body, attachments, ...(args.native != null ? { native: parseNativeContent(args.native) } : {}), ...(quotedMessage ? { quotedMessage } : {}) }]
              : undefined);
            const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal : 'fulfil the explicit outbound messaging instruction';
            const action = await deps.channelActions.createAndExecute({
              workspaceId: ctx.workspaceId,
              appId: ctx.appId,
              agentId: ctx.agentId,
              missionId: ctx.missionId ?? null,
              requesterIdentityId,
              connectionId,
              recipientRef: resolved.peer.recipientRef,
              conversationId: resolved.peer.conversationId,
              subjectId: typeof args.subjectId === 'string' ? args.subjectId : resolved.peer.subjectId,
              goalRef: typeof args.goalRef === 'string' ? args.goalRef : null,
              goal,
              body: durableMessages ? '' : body,
              messages: durableMessages,
              authorizationBasis: origin?.ownerVerified ? 'verified_owner_command' : 'standing_goal',
              idempotencyKey: channelToolIdempotencyKey(ctx, 'channel.send.action', {
                connectionId, recipientRef: resolved.peer.recipientRef, goal,
                goalRef: typeof args.goalRef === 'string' ? args.goalRef : '',
                subjectId: typeof args.subjectId === 'string' ? args.subjectId : resolved.peer.subjectId ?? '',
                body, messages: durableMessages ?? [], quotedMessage: quotedMessage ?? null,
              }),
              userId: ctx.userId,
              postAckMutations: parsePostAckMutations(args.postAckMutations),
            });
            return { ...action.result, action: action.action };
          }
        }
        if (origin) {
          const explicitlyNamedThirdParties = (origin.explicitRecipients ?? [])
            .filter((recipient) => !sameChannelRecipient(origin.kind, recipient, origin.chatId));
          if (explicitlyNamedThirdParties.length > 0) {
            const matchesNamedRecipient = Boolean(to?.trim())
              && !/^(?:me|default)$/i.test(to!.trim())
              && explicitlyNamedThirdParties.some((recipient) => sameChannelRecipient(origin.kind, recipient, to!));
            if (!matchesNamedRecipient) {
              throw new AgentisError(
                'VALIDATION_FAILED',
                'The request names an explicit recipient, but the channel send omitted it or selected a different destination.',
                { remediation: `Pass the explicit recipient in "to": ${explicitlyNamedThirdParties.join(', ')}. The current chat/default will not be substituted.` },
              );
            }
          }
          const switchesConnection = Boolean(connectionId && connectionId !== origin.connectionId);
          const switchesKind = Boolean(kind && kind !== origin.kind);
          if (!origin.ownerVerified && switchesConnection) {
            throw new AgentisError(
              'CONNECTION_SCOPE_MISSING',
              'A channel-originated turn cannot switch to a different connection implicitly.',
              { remediation: 'Continue on the originating connection, or have a verified owner start the cross-connection action from an owner-linked identity.' },
            );
          }
          if (!origin.ownerVerified && switchesKind) {
            throw new AgentisError('CONNECTION_SCOPE_MISSING', 'A channel-originated turn cannot switch channel kinds implicitly.');
          }
          if (!switchesConnection && !switchesKind) {
            connectionId = origin.connectionId;
            kind = origin.kind;

            // Within an inbound channel turn, an omitted/default destination means
            // the current peer. It must never jump to the connection-wide default.
            if (!to?.trim() || /^(?:me|default)$/i.test(to.trim())) {
              to = origin.chatId;
            } else if (!origin.ownerVerified) {
              const resolved = deps.channels.resolveDestination({ connectionId, to });
              if (!resolved.chatId || !sameChannelRecipient(origin.kind, resolved.chatId, origin.chatId)) {
                throw new AgentisError(
                  'CONNECTION_SCOPE_MISSING',
                  'This channel sender is not a verified owner and cannot initiate a message to another recipient.',
                  { remediation: 'Reply only in the current conversation, or ask the explicitly linked owner to initiate the cross-recipient send.' },
                );
              }
            }
          }
        }
        // All external sends, including legacy raw-number calls, are converted
        // into the same durable effect intent. No tool path may bypass receipts.
        const body = typeof args.body === 'string' ? args.body : '';
        const attachments = parseAttachments(args.attachments);
        const messages = Array.isArray(args.messages) ? parseMessages(args.messages) : undefined;
        const quotedMessage = parseQuotedMessage(args.quotedMessage);
        if (quotedMessage && messages?.length && !messages[0]!.quotedMessage) {
          messages[0]!.quotedMessage = quotedMessage;
        }
        if (deps.channelActions && deps.channelInbox && ctx.agentId) {
          const resolvedConnectionId = connectionId ?? resolveConnectionId(deps.channels, ctx.workspaceId, { connectionId, kind });
          if (!resolvedConnectionId) throw new AgentisError('CHANNEL_TARGET_AMBIGUOUS_OR_MISSING', 'No single authorized channel connection matched.');
          const connection = deps.channels.get(ctx.workspaceId, resolvedConnectionId);
          const destination = deps.channels.resolveDestination({ connectionId: resolvedConnectionId, to });
          if (!destination.chatId) throw new AgentisError('CHANNEL_TARGET_AMBIGUOUS_OR_MISSING', 'No channel recipient could be resolved.');
          const peer = deps.channelInbox.ensurePeer({
            workspaceId: ctx.workspaceId, connectionId: resolvedConnectionId,
            channelKind: connection.kind, address: destination.chatId,
          });
          const requesterIdentityId = origin?.ownerVerified && deps.channelIdentity
            ? deps.channelIdentity.principal({ workspaceId: ctx.workspaceId, connectionId: origin.connectionId, channelKind: origin.kind, handle: origin.chatId }).identityId
            : null;
          const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal : 'fulfil the requested outbound message';
          const durableMessages = messages ?? (attachments.length > 0 || args.native != null || quotedMessage
            ? [{ body, attachments, ...(args.native != null ? { native: parseNativeContent(args.native) } : {}), ...(quotedMessage ? { quotedMessage } : {}) }]
            : undefined);
          const action = await deps.channelActions.createAndExecute({
            workspaceId: ctx.workspaceId, appId: ctx.appId, agentId: ctx.agentId, missionId: ctx.missionId ?? null,
            requesterIdentityId, connectionId: resolvedConnectionId, recipientRef: peer.recipientRef,
            // The effect belongs to the TARGET peer's conversation. Reusing the
            // verified owner's origin conversation for a raw-number send binds
            // one conversation to two canonical peers and is correctly rejected
            // by ChannelBridge before transport. A new peer has no conversation
            // yet; the durable delivery path creates it after provider dispatch.
            conversationId: peer.conversationId,
            subjectId: typeof args.subjectId === 'string' ? args.subjectId : peer.subjectId,
            goalRef: typeof args.goalRef === 'string' ? args.goalRef : null,
            goal, body: durableMessages ? '' : body, messages: durableMessages,
            authorizationBasis: origin?.ownerVerified ? 'verified_owner_command' : 'standing_goal',
            idempotencyKey: channelToolIdempotencyKey(ctx, 'channel.send.effect', {
              connectionId: resolvedConnectionId, recipientRef: peer.recipientRef, goal,
              body, messages: durableMessages ?? [], quotedMessage: quotedMessage ?? null,
            }),
            userId: ctx.userId, postAckMutations: parsePostAckMutations(args.postAckMutations),
          });
          return { ...action.result, action: action.action };
        }
        return resolveAndSend(
          { channels: deps.channels, ...(deps.connectionGrants ? { connectionGrants: deps.connectionGrants } : {}) },
          {
            workspaceId: ctx.workspaceId,
            body,
            kind,
            connectionId,
            to,
            agentId: ctx.agentId ?? null,
            ...(args.deliveryRole === 'progress' || args.deliveryRole === 'final' ? { deliveryRole: args.deliveryRole } : {}),
            attachments,
            ...(quotedMessage ? { quotedMessage } : {}),
            ...(args.native != null ? { native: parseNativeContent(args.native) } : {}),
            ...(messages ? { messages } : {}),
            idempotencyKey: channelToolIdempotencyKey(ctx, 'channel.send.direct', {
              connectionId: connectionId ?? '', kind: kind ?? '', to: to ?? '', body,
              deliveryRole: typeof args.deliveryRole === 'string' ? args.deliveryRole : '',
              attachments, native: args.native ?? null, quotedMessage: quotedMessage ?? null, messages: messages ?? [],
            }),
            ...(targetConversationId
              ? { conversationId: targetConversationId }
              : origin?.conversationId && sameChannelRecipient(origin.kind, to ?? origin.chatId, origin.chatId)
                ? { conversationId: origin.conversationId }
                : {}),
            ...(origin?.automationEpoch !== undefined ? { expectedAutomationEpoch: origin.automationEpoch } : {}),
          },
        );
      },
    },
    {
      definition: {
        id: 'agentis.channel.read',
        family: 'run',
        description: 'Acknowledge the inbound message that started this conversation turn as read. Uses the provider message reference and connection policy; only supported for WhatsApp QR and Cloud.',
        inputSchema: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: 'Optional local message ID from this conversation; defaults to the current inbound message.' },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const origin = ctx.channelOrigin;
        if (!deps.channels || !origin?.conversationId) {
          throw new AgentisError('VALIDATION_FAILED', 'channel.read is available only in an inbound channel conversation');
        }
        const messageId = typeof args.messageId === 'string' && args.messageId.trim()
          ? args.messageId.trim()
          : origin.inboundMessageId;
        if (!messageId) {
          throw new AgentisError('VALIDATION_FAILED', 'No inbound provider message is available to acknowledge');
        }
        return deps.channels.markMessageRead(ctx.workspaceId, origin.connectionId, origin.conversationId, messageId);
      },
    },
    {
      definition: {
        id: 'agentis.channel.templates',
        family: 'inspect',
        description: 'Discover approved WhatsApp Cloud message templates available on the current Cloud connection. QR connections do not support templates.',
        inputSchema: { type: 'object', properties: { connectionId: { type: 'string' } } },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const connectionId = ctx.channelOrigin?.connectionId ?? resolveConnectionId(deps.channels, ctx.workspaceId, args);
        if (!connectionId) throw new AgentisError('RESOURCE_NOT_FOUND', 'no matching channel connection');
        const capabilities = deps.channels.capabilitiesFor(connectionId);
        if (!capabilities?.supportsTemplates) {
          throw new AgentisError('VALIDATION_FAILED', 'This channel connection does not support templates');
        }
        return deps.channels.listWhatsAppCloudTemplates(ctx.workspaceId, connectionId);
      },
    },
    {
      definition: {
        id: 'agentis.channel.capabilities',
        family: 'inspect',
        description: 'Report what a channel connection can transport (media kinds, reactions, typing/presence, location, contacts, polls, quoted replies, mentions, bursts, human-like pacing). Transport support means an existing artifact can be delivered; creating an image/audio/video requires a separate configured media capability.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'Connection to inspect. Optional when kind resolves to one active channel.' },
            kind: { type: 'string', enum: [...CHANNEL_KINDS], description: 'Channel kind (used when connectionId is omitted).' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const connectionId = resolveConnectionId(deps.channels, ctx.workspaceId, args);
        if (!connectionId) throw new AgentisError('RESOURCE_NOT_FOUND', 'no matching channel connection; pass connectionId or a kind with exactly one active connection');
        const capabilities = deps.channels.capabilitiesFor(connectionId);
        if (!capabilities) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${connectionId} not found`);
        return { connectionId, capabilities };
      },
    },
    {
      definition: {
        id: 'agentis.channel.typing',
        family: 'run',
        description: 'Show or clear a "typing…" indicator in a channel chat (best-effort; supported on WhatsApp/Telegram live sessions). Use to make a reply feel human before sending.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            kind: { type: 'string', enum: [...CHANNEL_KINDS] },
            to: { type: 'string', description: 'Destination chat (phone/JID/chat id, or "default").' },
            on: { type: 'boolean', description: 'true = show typing, false = clear. Defaults to true.' },
          },
          required: ['to'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const connectionId = resolveConnectionId(deps.channels, ctx.workspaceId, args);
        if (!connectionId) throw new AgentisError('RESOURCE_NOT_FOUND', 'no matching channel connection');
        const resolved = deps.channels.resolveDestination({ connectionId, to: typeof args.to === 'string' ? args.to : null });
        if (!resolved.chatId) throw new AgentisError('VALIDATION_FAILED', 'no destination chat resolved for typing');
        await deps.channels.setTyping(connectionId, resolved.chatId, args.on !== false);
        return { ok: true, connectionId, to: resolved.chatId, typing: args.on !== false };
      },
    },
    {
      definition: {
        id: 'agentis.channel.react',
        family: 'run',
        description: 'Add or clear an emoji reaction on a prior message in a channel chat (best-effort; WhatsApp live sessions). Pass an empty emoji to clear.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            kind: { type: 'string', enum: [...CHANNEL_KINDS] },
            to: { type: 'string', description: 'Destination chat (phone/JID/chat id, or "default").' },
            messageId: { type: 'string', description: 'Provider message id of the message to react to.' },
            emoji: { type: 'string', description: 'Reaction emoji, or "" to clear.' },
          },
          required: ['to', 'messageId', 'emoji'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const connectionId = resolveConnectionId(deps.channels, ctx.workspaceId, args);
        if (!connectionId) throw new AgentisError('RESOURCE_NOT_FOUND', 'no matching channel connection');
        const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
        if (!messageId) throw new AgentisError('VALIDATION_FAILED', 'messageId is required');
        const resolved = deps.channels.resolveDestination({ connectionId, to: typeof args.to === 'string' ? args.to : null });
        if (!resolved.chatId) throw new AgentisError('VALIDATION_FAILED', 'no destination chat resolved for reaction');
        await deps.channels.reactToMessage(connectionId, resolved.chatId, messageId, typeof args.emoji === 'string' ? args.emoji : '');
        return { ok: true, connectionId, to: resolved.chatId, messageId };
      },
    },
    {
      definition: {
        id: 'agentis.connection.grants',
        family: 'inspect',
        description: 'Inspect per-agent authority over connections (Agent-Native §3.3). List the grants governing a connection, the grants YOU hold, or pending requests awaiting operator approval.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'List grants governing this connection.' },
            mine: { type: 'boolean', description: 'List the grants the calling agent holds.' },
            pending: { type: 'boolean', description: 'List requests awaiting operator approval.' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.connectionGrants) throw new AgentisError('CONNECTION_GRANTS_UNAVAILABLE', 'connection grant service not configured');
        if (args.pending) return { requests: deps.connectionGrants.listRequests(ctx.workspaceId) };
        if (args.mine && ctx.agentId) return { grants: deps.connectionGrants.listForAgent(ctx.workspaceId, ctx.agentId) };
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
        if (connectionId) return { grants: deps.connectionGrants.list(ctx.workspaceId, connectionId) };
        return { grants: ctx.agentId ? deps.connectionGrants.listForAgent(ctx.workspaceId, ctx.agentId) : [] };
      },
    },
    {
      definition: {
        id: 'agentis.connection.request',
        family: 'run',
        description: 'Capability negotiation (Agent-Native §3.3): request authority to use a connection you do not yet own — e.g. "I need to send on WhatsApp to run this outreach". Records an operator-approved request; does NOT grant access itself.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'Connection to request access to.' },
            connectionKind: { type: 'string', enum: ['channel', 'credential', 'mcp'], description: 'Resource family. Defaults to channel.' },
            scope: { type: 'string', enum: ['read', 'send', 'manage'], description: 'Least-privilege scope needed. Defaults to send.' },
            reason: { type: 'string', description: 'Why you need it — surfaced to the operator.' },
          },
          required: ['connectionId'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.connectionGrants) throw new AgentisError('CONNECTION_GRANTS_UNAVAILABLE', 'connection grant service not configured');
        if (!ctx.agentId) throw new AgentisError('VALIDATION_FAILED', 'connection.request must be called by an agent (no agent context)');
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
        if (!connectionId) throw new AgentisError('VALIDATION_FAILED', 'connectionId is required');
        const grant = deps.connectionGrants.request({
          workspaceId: ctx.workspaceId,
          connectionKind: parseConnectionKind(args.connectionKind),
          connectionId,
          agentId: ctx.agentId,
          scope: parseScope(args.scope),
          note: typeof args.reason === 'string' ? args.reason.trim() : null,
          grantedBy: ctx.agentId,
        });
        return { requested: true, grantId: grant.id, status: 'requested', message: 'Operator approval pending. The operator grants it with agentis.connection.grant.' };
      },
    },
    {
      definition: {
        id: 'agentis.connection.grant',
        family: 'run',
        description: 'Operator action (Agent-Native §3.3): grant an agent scoped authority over a connection, or approve a pending request. Once any grant exists on a connection, only granted agents (plus its owner) may use it.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            agentId: { type: 'string', description: 'Agent to authorize.' },
            connectionKind: { type: 'string', enum: ['channel', 'credential', 'mcp'] },
            scope: { type: 'string', enum: ['read', 'send', 'manage'], description: 'Defaults to send.' },
            expiresAt: { type: 'string', description: 'Optional ISO expiry.' },
          },
          required: ['connectionId', 'agentId'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.connectionGrants) throw new AgentisError('CONNECTION_GRANTS_UNAVAILABLE', 'connection grant service not configured');
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
        const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
        if (!connectionId || !agentId) throw new AgentisError('VALIDATION_FAILED', 'connectionId and agentId are required');
        const grant = deps.connectionGrants.grant({
          workspaceId: ctx.workspaceId,
          connectionKind: parseConnectionKind(args.connectionKind),
          connectionId,
          agentId,
          scope: parseScope(args.scope),
          grantedBy: ctx.userId,
          expiresAt: typeof args.expiresAt === 'string' ? args.expiresAt : null,
        });
        return { granted: true, grantId: grant.id, agentId, scope: grant.scope };
      },
    },
  ]);
}

function parseScope(value: unknown): 'read' | 'send' | 'manage' {
  return value === 'read' || value === 'manage' ? value : 'send';
}

function parseConnectionKind(value: unknown): 'channel' | 'credential' | 'mcp' {
  return value === 'credential' || value === 'mcp' ? value : 'channel';
}

/** Normalize loosely-typed attachment args into typed references. */
function parseAttachments(value: unknown): OutboundAttachmentRef[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new AgentisError('VALIDATION_FAILED', 'attachments must be an array');
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AgentisError('VALIDATION_FAILED', `attachment[${i}] must be an object`);
    }
    const obj = raw as Record<string, unknown>;
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    const artifactId = typeof obj.artifactId === 'string' ? obj.artifactId.trim() : '';
    const speakText = typeof obj.text === 'string' ? obj.text.trim() : '';
    if (!url && !artifactId && !speakText) throw new AgentisError('VALIDATION_FAILED', `attachment[${i}] needs a url, artifactId, or text (for a spoken voice note)`);
    const ref: OutboundAttachmentRef = {};
    if (url) ref.url = url;
    if (artifactId) ref.artifactId = artifactId;
    if (speakText) { ref.text = speakText; if (!obj.kind) ref.kind = 'voice'; }
    if (typeof obj.filename === 'string' && obj.filename.trim()) ref.filename = obj.filename.trim();
    if (typeof obj.mimeType === 'string' && obj.mimeType.trim()) ref.mimeType = obj.mimeType.trim();
    if (obj.kind === 'image' || obj.kind === 'video' || obj.kind === 'audio' || obj.kind === 'voice' || obj.kind === 'sticker' || obj.kind === 'file') ref.kind = obj.kind;
    if (typeof obj.caption === 'string' && obj.caption.trim()) ref.caption = obj.caption.trim();
    return ref;
  });
}

/** Normalize a burst of loosely-typed messages into typed send messages. */
function parseMessages(value: unknown): { id?: string; requirementId?: string; body?: string; attachments?: OutboundAttachmentRef[]; native?: OutboundNativeContent; quotedMessage?: ChannelQuote }[] {
  if (!Array.isArray(value)) throw new AgentisError('VALIDATION_FAILED', 'messages must be an array');
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AgentisError('VALIDATION_FAILED', `messages[${i}] must be an object`);
    }
    const obj = raw as Record<string, unknown>;
    const message: { id?: string; requirementId?: string; body?: string; attachments?: OutboundAttachmentRef[]; native?: OutboundNativeContent; quotedMessage?: ChannelQuote } = {};
    if (typeof obj.id === 'string' && obj.id.trim()) message.id = obj.id.trim();
    if (typeof obj.requirementId === 'string' && obj.requirementId.trim()) message.requirementId = obj.requirementId.trim();
    if (typeof obj.body === 'string') message.body = obj.body;
    if (obj.attachments != null) message.attachments = parseAttachments(obj.attachments);
    if (obj.native != null) message.native = parseNativeContent(obj.native);
    if (obj.quotedMessage != null) message.quotedMessage = parseQuotedMessage(obj.quotedMessage);
    return message;
  });
}

function parseQuotedMessage(value: unknown): ChannelQuote | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentisError('VALIDATION_FAILED', 'quotedMessage must contain a local messageId');
  }
  const messageId = (value as Record<string, unknown>).messageId;
  if (typeof messageId !== 'string' || !messageId.trim()) {
    throw new AgentisError('VALIDATION_FAILED', 'quotedMessage requires a local messageId');
  }
  return { messageId: messageId.trim() };
}

function parsePostAckMutations(value: unknown): ChannelPostAckMutation[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new AgentisError('VALIDATION_FAILED', 'postAckMutations must be an array');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AgentisError('VALIDATION_FAILED', `postAckMutations[${index}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const appId = typeof entry.appId === 'string' ? entry.appId.trim() : '';
    const collection = typeof entry.collection === 'string' ? entry.collection.trim() : '';
    const recordId = typeof entry.recordId === 'string' ? entry.recordId.trim() : '';
    const patch = entry.patch && typeof entry.patch === 'object' && !Array.isArray(entry.patch)
      ? entry.patch as Record<string, unknown> : null;
    if (entry.kind !== 'app_data_update' || !appId || !collection || !recordId || !patch) {
      throw new AgentisError('VALIDATION_FAILED', `postAckMutations[${index}] requires kind=app_data_update, appId, collection, recordId, and patch`);
    }
    return {
      kind: 'app_data_update', appId, collection, recordId, patch,
      ...(typeof entry.expectedVersion === 'number' ? { expectedVersion: entry.expectedVersion } : {}),
      ...(entry.receiptKind === 'subject_update' ? { receiptKind: 'subject_update' as const } : {}),
    };
  });
}

function parseNativeContent(value: unknown): OutboundNativeContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentisError('VALIDATION_FAILED', 'native must be a location, contact, or poll object');
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind === 'location') {
    if (typeof obj.latitude !== 'number' || !Number.isFinite(obj.latitude) || typeof obj.longitude !== 'number' || !Number.isFinite(obj.longitude)) {
      throw new AgentisError('VALIDATION_FAILED', 'native location requires finite latitude and longitude');
    }
    return {
      kind: 'location', latitude: obj.latitude, longitude: obj.longitude,
      ...(typeof obj.name === 'string' && obj.name.trim() ? { name: obj.name.trim() } : {}),
      ...(typeof obj.address === 'string' && obj.address.trim() ? { address: obj.address.trim() } : {}),
    };
  }
  if (obj.kind === 'contact') {
    const displayName = typeof obj.displayName === 'string' ? obj.displayName.trim() : '';
    const phone = typeof obj.phone === 'string' ? obj.phone.trim() : '';
    if (!displayName || !phone) throw new AgentisError('VALIDATION_FAILED', 'native contact requires displayName and phone');
    return { kind: 'contact', displayName, phone, ...(typeof obj.vcard === 'string' && obj.vcard.trim() ? { vcard: obj.vcard.trim() } : {}) };
  }
  if (obj.kind === 'poll') {
    const question = typeof obj.question === 'string' ? obj.question.trim() : '';
    const options = Array.isArray(obj.options)
      ? obj.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : [];
    if (!question || options.length < 2) throw new AgentisError('VALIDATION_FAILED', 'native poll requires a question and at least two options');
    return {
      kind: 'poll', question, options,
      ...(typeof obj.selectableCount === 'number' && Number.isInteger(obj.selectableCount) && obj.selectableCount > 0 ? { selectableCount: obj.selectableCount } : {}),
    };
  }
  throw new AgentisError('VALIDATION_FAILED', 'native.kind must be location, contact, or poll');
}

function parseKind(value: unknown): ChannelKind | null {
  if (typeof value !== 'string') return null;
  return CHANNEL_KINDS.has(value as ChannelKind) ? value as ChannelKind : null;
}

function numericLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** Resolve a connection id from explicit id, or a kind that maps to one active/default connection. */
function resolveConnectionId(
  channels: NonNullable<ToolHandlerDeps['channels']>,
  workspaceId: string,
  args: { connectionId?: unknown; kind?: unknown },
): string | null {
  const explicit = typeof args.connectionId === 'string' && args.connectionId.trim() ? args.connectionId.trim() : '';
  if (explicit) return explicit;
  const kind = parseKind(args.kind);
  const active = channels.list(workspaceId).filter((c) => c.status === 'active' && (!kind || c.kind === kind));
  if (active.length === 1) return active[0]!.id;
  if (kind) {
    const defaultId = channels.defaultConnectionFor(workspaceId, kind);
    if (defaultId) return defaultId;
  }
  return null;
}

