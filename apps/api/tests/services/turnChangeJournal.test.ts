import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite, type AgentisSqliteRaw } from '@agentis/db/sqlite';
import { createLogger } from '../../src/logger.js';
import { TurnChangeJournal } from '../../src/services/conversation/turnChangeJournal.js';

const handles: AgentisSqliteRaw[] = [];

afterEach(() => {
  while (handles.length) handles.pop()!.close();
});

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'agentis-turn-changes-')), 'data.db');
  const { sqlite } = openSqlite({ path });
  handles.push(sqlite);
  sqlite.exec(`
    INSERT INTO users (id, username, display_name, password_hash)
    VALUES ('user-1', 'owner', 'Owner', 'hash');
    INSERT INTO workspaces (id, user_id, name, slug)
    VALUES ('ws-1', 'user-1', 'Workspace', 'workspace');
    INSERT INTO agents (id, workspace_id, user_id, name, adapter_type)
    VALUES ('agent-1', 'ws-1', 'user-1', 'Bia', 'codex');
    INSERT INTO conversations (id, workspace_id, user_id, agent_id)
    VALUES ('conv-1', 'ws-1', 'user-1', 'agent-1');
  `);
  const journal = new TurnChangeJournal({ sqlite, logger: createLogger({ level: 'error' }) });
  return { sqlite, journal };
}

function turn(sqlite: AgentisSqliteRaw, id: string, clientTurnId = id) {
  sqlite.prepare(`
    INSERT INTO conversation_turns (
      id, workspace_id, conversation_id, agent_id, user_id,
      client_turn_id, prompt, status
    ) VALUES (?, 'ws-1', 'conv-1', 'agent-1', 'user-1', ?, 'change it', 'running')
  `).run(id, clientTurnId);
}

describe('TurnChangeJournal', () => {
  it('undoes and redoes only turn-owned fields while preserving later unrelated work', async () => {
    const { sqlite, journal } = fixture();
    turn(sqlite, 'turn-1');

    await journal.captureTool({
      workspaceId: 'ws-1', durableTurnId: 'turn-1', toolCallId: 'call-1', toolId: 'agentis.agents.update', behavior: 'local',
    }, () => {
      sqlite.prepare("UPDATE agents SET description = 'Changed by agent' WHERE id = 'agent-1'").run();
    });
    const sealed = journal.seal('ws-1', 'turn-1')!;
    expect(sealed).toMatchObject({ state: 'undoable', reversibleCount: 1, sensitiveCount: 0 });

    sqlite.prepare("UPDATE agents SET name = 'Bia Later' WHERE id = 'agent-1'").run();
    const undone = journal.undo({ workspaceId: 'ws-1', turnId: 'turn-1', expectedVersion: sealed.version });
    expect(undone.conflicts).toBeUndefined();
    expect(undone.changeSet.state).toBe('undone');
    expect(sqlite.prepare("SELECT name, description FROM agents WHERE id = 'agent-1'").get()).toEqual({
      name: 'Bia Later', description: null,
    });

    const redone = journal.redo({ workspaceId: 'ws-1', turnId: 'turn-1', expectedVersion: undone.changeSet.version });
    expect(redone.changeSet.state).toBe('undoable');
    expect(sqlite.prepare("SELECT name, description FROM agents WHERE id = 'agent-1'").get()).toEqual({
      name: 'Bia Later', description: 'Changed by agent',
    });
  });

  it('returns an atomic conflict preview when a later edit overlaps', async () => {
    const { sqlite, journal } = fixture();
    turn(sqlite, 'turn-2');
    await journal.captureTool({
      workspaceId: 'ws-1', durableTurnId: 'turn-2', toolCallId: 'call-2', toolId: 'agentis.agents.update', behavior: 'local',
    }, () => {
      sqlite.prepare("UPDATE agents SET description = 'Agent value' WHERE id = 'agent-1'").run();
    });
    const sealed = journal.seal('ws-1', 'turn-2')!;
    sqlite.prepare("UPDATE agents SET description = 'Later value' WHERE id = 'agent-1'").run();

    const result = journal.undo({ workspaceId: 'ws-1', turnId: 'turn-2', expectedVersion: sealed.version });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ resourceKind: 'agents', fields: ['description'], reason: 'overlapping_change' }),
    ]);
    expect(result.changeSet.state).toBe('undoable');
    expect(sqlite.prepare("SELECT description FROM agents WHERE id = 'agent-1'").get()).toEqual({ description: 'Later value' });
  });

  it('requires confirmation before restoring encrypted security state', async () => {
    const { sqlite, journal } = fixture();
    turn(sqlite, 'turn-3');
    await journal.captureTool({
      workspaceId: 'ws-1', durableTurnId: 'turn-3', toolCallId: 'call-3', toolId: 'agentis.credentials.create', behavior: 'local',
    }, () => {
      sqlite.prepare(`
        INSERT INTO credentials (id, workspace_id, user_id, name, credential_type, encrypted_value)
        VALUES ('credential-1', 'ws-1', 'user-1', 'Provider', 'token', 'ciphertext-only')
      `).run();
    });
    const sealed = journal.seal('ws-1', 'turn-3')!;
    expect(sealed.sensitiveCount).toBe(1);

    const blocked = journal.undo({ workspaceId: 'ws-1', turnId: 'turn-3', expectedVersion: sealed.version });
    expect(blocked.requiresSensitiveConfirmation).toBe(true);
    expect(sqlite.prepare("SELECT encrypted_value FROM credentials WHERE id = 'credential-1'").get()).toEqual({ encrypted_value: 'ciphertext-only' });

    const restored = journal.undo({ workspaceId: 'ws-1', turnId: 'turn-3', expectedVersion: sealed.version, confirmSensitive: true });
    expect(restored.changeSet.state).toBe('undone');
    expect(sqlite.prepare("SELECT id FROM credentials WHERE id = 'credential-1'").get()).toBeUndefined();
  });

  it('records mixed/external effects without claiming they are reversible', async () => {
    const { sqlite, journal } = fixture();
    turn(sqlite, 'turn-4');
    await journal.captureTool({
      workspaceId: 'ws-1', durableTurnId: 'turn-4', toolCallId: 'call-4', toolId: 'agentis.channel.send', behavior: 'external',
    }, () => ({ delivered: true }));
    const sealed = journal.seal('ws-1', 'turn-4')!;
    expect(sealed).toMatchObject({ reversibleCount: 0, externalEffectCount: 1 });
  });

  it('does not seal a cancelled turn until its in-flight mutation capture settles', async () => {
    const { sqlite, journal } = fixture();
    turn(sqlite, 'turn-5');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const capture = journal.captureTool({
      workspaceId: 'ws-1', durableTurnId: 'turn-5', toolCallId: 'call-5', toolId: 'agentis.agents.update', behavior: 'local',
    }, async () => {
      await gate;
      sqlite.prepare("UPDATE agents SET description = 'Settled change' WHERE id = 'agent-1'").run();
    });
    await expect.poll(() => journal.summary('ws-1', 'turn-5')).not.toBeNull();
    expect(journal.seal('ws-1', 'turn-5')).toMatchObject({ state: 'recording' });
    release();
    await capture;
    expect(journal.summary('ws-1', 'turn-5')).toMatchObject({ state: 'undoable', reversibleCount: 1 });
  });
});
