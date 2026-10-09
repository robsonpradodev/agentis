/**
 * IPI escalation classifier — the taint gate calls ChatToolExecutor.isHighImpact
 * to decide which tools require operator confirmation after untrusted content is
 * ingested. These cases don't need the registry configured (prefix + explicit
 * set), so they lock the classifier independently of the chat harness.
 */
import { describe, it, expect } from 'vitest';
import { ChatToolExecutor, canonicalAgentisToolName } from '../../src/services/chat/chatToolExecutor.js';

describe('ChatToolExecutor.isHighImpact', () => {
  it('normalizes model-native aliases before policy and execution', () => {
    expect(canonicalAgentisToolName('image.generate')).toBe('agentis.media.generate');
    expect(canonicalAgentisToolName('channel.send')).toBe('agentis.channel.send');
    expect(ChatToolExecutor.isHighImpact('channel.send')).toBe(true);
  });
  it('flags dynamic workflow + command tools by prefix', () => {
    expect(ChatToolExecutor.isHighImpact('workflow.abc123')).toBe(true);
    expect(ChatToolExecutor.isHighImpact('agentis.command.run')).toBe(true);
  });

  it('flags the explicit high-impact tool ids', () => {
    for (const id of [
      'agentis.extension.create',
      'agentis.component.install',
      'agentis.extension.test',
      'agentis.ability.create',
      'agentis.channel.send',
      'agentis.agents.create',
      'agentis.mcp.add',
      'agentis.build_workflow',
      'agentis.deploy',
    ]) {
      expect(ChatToolExecutor.isHighImpact(id), id).toBe(true);
    }
  });

  it('does not flag benign read-only tools', () => {
    for (const id of ['agentis.capability.search', 'agentis.workflow.status', 'agentis.agents.list']) {
      expect(ChatToolExecutor.isHighImpact(id), id).toBe(false);
    }
  });
});

describe('ChatToolExecutor.requiresConfirmation', () => {
  it('never confirms in auto/plan mode by name alone (taint gate handles auto)', () => {
    expect(ChatToolExecutor.requiresConfirmation('workflow.x', 'auto')).toBe(false);
    expect(ChatToolExecutor.requiresConfirmation('workflow.x', 'plan')).toBe(false);
  });

  it('uses the conversation sensitivity for medium-risk workflow runs', () => {
    expect(ChatToolExecutor.requiresConfirmation('workflow.x', 'ask', 'balanced')).toBe(false);
    expect(ChatToolExecutor.requiresConfirmation('workflow.x', 'ask', 'cautious')).toBe(true);
  });
});
