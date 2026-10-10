import { and, eq } from 'drizzle-orm';
import type { AgentAdapter, NormalizedTask } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

/** Direct task dispatch uses the same registry/permission loop as chat and workflows. */
export async function runProviderTask(db: AgentisSqliteDb, workspaceId: string, agentId: string, adapter: AgentAdapter,
  task: NormalizedTask, signal: AbortSignal, progress: (message: string) => void): Promise<Record<string, unknown>> {
  const agent = db.select().from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId))).get();
  if (!agent) throw new Error('Provider task agent is unavailable.');
  const { ChatSessionExecutor } = await import('../chat/chatSessionExecutor.js');
  let text = '';
  let finished = false;
  const errors = new Map<string, string>();
  const session = `provider-task:${task.runId}:${task.taskId}`;
  // Tools with durable state need a real isolated conversation, including its FK.
  db.insert(schema.conversations).values({ id: session, workspaceId, userId: agent.userId, agentId, title: task.title, permissionMode: 'ask' }).onConflictDoNothing().run();
  const conversation = db.select({ workspaceId: schema.conversations.workspaceId, agentId: schema.conversations.agentId }).from(schema.conversations).where(eq(schema.conversations.id, session)).get();
  if (conversation?.workspaceId !== workspaceId || conversation.agentId !== agentId) throw new Error('Provider task conversation identity conflict.');
  for await (const delta of ChatSessionExecutor.turn(adapter, [], `${task.title}\n${task.description}\nINPUT:\n${JSON.stringify(task.inputData)}\nSTATE:\n${JSON.stringify(task.scratchpadSnapshot)}`, {
    workspaceId, agentId, userId: agent.userId, conversationId: session, clientTurnId: session,
    runId: task.runId, ambientId: agent.ambientId ?? undefined, signal, executionMode: 'chat', permissionMode: 'ask',
  }, { toolMode: 'caller_loop', sessionKey: session, maxTurns: 8, skipRuntimePreflight: true })) {
    if (delta.type === 'text') text += delta.delta;
    if (delta.type === 'activity') progress(delta.label);
    if (delta.type === 'tool_result') { if (delta.error) errors.set(delta.name, delta.error); else errors.delete(delta.name); }
    if (delta.type === 'confirmation_required') throw new Error('This task requires operator approval. Continue it in the agent chat.');
    if (delta.type === 'done') finished = delta.finishReason === 'stop';
  }
  if (!finished || signal.aborted || errors.size) throw new Error(errors.values().next().value ?? 'Provider task did not finish.');
  return { text };
}
