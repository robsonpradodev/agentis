/**
 * /v1/webhooks/trigger/:triggerId — public webhook ingress.
 *
 * Headers required:
 *   x-agentis-timestamp : unix ms
 *   x-agentis-signature : hex HMAC-SHA256 of `${ts}.${rawBody}` using the
 *                         trigger's webhookSecret
 *   x-agentis-delivery  : idempotency key
 *
 * Verification, replay defense, and idempotency are handled in
 * TriggerRuntime.fireWebhook.
 *
 * /v1/webhooks/channel/:connectionId — Batch 4 channel-bridge ingress.
 *
 * Adapter-specific authentication (e.g. Telegram's
 * `X-Telegram-Bot-Api-Secret-Token`) is verified inside
 * `ChannelBridge.handleInbound`. Idempotency is keyed by the adapter's own
 * external id (e.g. Telegram update_id).
 */

import { Hono } from 'hono';
import { AgentisError } from '@agentis/core';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import type { ChannelBridge } from '../services/conversation/channelBridge.js';
import type { VoiceChannelAdapter } from '../adapters/channels/voice.js';

export function buildWebhookRoutes(deps: {
  runtime: TriggerRuntime;
  bridge?: ChannelBridge;
  /**
   * Voice channel (G6): exposes the buffered agent reply so a voice provider can
   * retrieve + vocalize it after posting a transcript. Optional — absent leaves
   * the reply-retrieval route off (inbound still works via the channel webhook).
   */
  voice?: VoiceChannelAdapter;
}) {
  const app = new Hono();
  app.post('/trigger/:triggerId', async (c) => {
    const triggerId = c.req.param('triggerId');
    const ts = c.req.header('x-agentis-timestamp') ?? '';
    const sig = c.req.header('x-agentis-signature') ?? '';
    const delivery = c.req.header('x-agentis-delivery') ?? '';
    if (!ts || !sig || !delivery) {
      throw new AgentisError('VALIDATION_FAILED', 'webhook headers missing (x-agentis-timestamp, x-agentis-signature, x-agentis-delivery)');
    }
    const rawBody = await c.req.text();
    const result = await deps.runtime.fireWebhook({
      triggerId,
      rawBody,
      signature: sig,
      timestampHeader: ts,
      deliveryId: delivery,
    });
    return c.json(result, result.idempotent ? 200 : 202);
  });

  // Native SaaS webhook ingress — provider-signed (GitHub/Stripe/Slack/…). The
  // trigger config names the provider; its webhookSecret is the provider's
  // signing secret. Verification happens in TriggerRuntime.fireConnectorWebhook.
  app.post('/connector/:triggerId', async (c) => {
    const triggerId = c.req.param('triggerId');
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const rawBody = await c.req.text();
    const result = await deps.runtime.fireConnectorWebhook({ triggerId, rawBody, headers });
    return c.json(result, result.idempotent ? 200 : 202);
  });

  // Meta uses one callback URL per app/WABA integration. Resolve each event to
  // its workspace-owned phone_number_id instead of requiring a callback URL per
  // customer connection. Per-connection routes remain available for migrations.
  app.get('/whatsapp', (c) => {
    if (!deps.bridge) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
    const query: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(c.req.query())) query[key] = value;
    const verified = deps.bridge.verifyWhatsAppCloudWebhook(query);
    return c.body(verified.body, 200, { 'content-type': 'text/plain; charset=utf-8' });
  });

  app.post('/whatsapp', async (c) => {
    if (!deps.bridge) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    const rawBody = await c.req.text();
    const result = await deps.bridge.handleWhatsAppCloudWebhook({ headers, rawBody });
    return c.json(result, result.accepted ? 200 : 202);
  });

  app.post('/channel/:connectionId', async (c) => {
    if (!deps.bridge) {
      throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
    }
    const connectionId = c.req.param('connectionId');
    // Collect headers as a flat record for the adapter contract.
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const rawBody = await c.req.text();
    const result = await deps.bridge.handleInbound({ connectionId, headers, rawBody });
    if (result.responseBody !== undefined) {
      return c.json(result.responseBody as Record<string, unknown>, 200);
    }
    return c.json(result, result.idempotent ? 200 : 202);
  });

  // Voice reply retrieval (G6): after POSTing a transcript to /channel/:id, a
  // voice provider fetches the agent's spoken answer here. The reply is buffered
  // by the VoiceChannelAdapter keyed by callId; this GET consumes it. Auth reuses
  // the same per-connection shared secret (x-agentis-voice-secret header), so an
  // unauthenticated caller cannot drain another line's replies.
  app.get('/voice/:connectionId/reply/:callId', (c) => {
    if (!deps.bridge || !deps.voice) {
      throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'voice channel not configured');
    }
    const connectionId = c.req.param('connectionId');
    const presented = c.req.header('x-agentis-voice-secret') ?? '';
    if (!deps.bridge.verifyVoiceSecret(connectionId, presented)) {
      throw new AgentisError('CHANNEL_SIGNATURE_INVALID', 'voice reply secret did not match');
    }
    const callId = c.req.param('callId');
    const reply = deps.voice.takeReply(callId);
    if (!reply) return c.json({ pending: true }, 200);
    // `speak` is the provider-facing field: the text to vocalize, plus an
    // optional pre-synthesized audio URL (null → provider does its own TTS).
    return c.json({ pending: false, speak: reply.text, ttsUrl: reply.ttsUrl, at: reply.at }, 200);
  });

  app.get('/channel/:connectionId', (c) => {
    if (!deps.bridge) {
      throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
    }
    const query: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(c.req.query())) query[key] = value;
    const result = deps.bridge.handleWebhookVerification({
      connectionId: c.req.param('connectionId'),
      query,
    });
    return c.body(result.body, 200, { 'content-type': result.contentType ?? 'text/plain; charset=utf-8' });
  });

  return app;
}

