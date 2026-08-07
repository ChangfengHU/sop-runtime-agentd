import { DatabaseSync } from "node:sqlite";

import type { ExecutionRecord, RuntimeEvent, SessionRecord, WebhookRecord } from "./contracts.js";
import { nowIso } from "./util.js";

interface JsonRow {
  payload_json: string;
}

// 旧记录(0.5.0 之前写入)没有 target 字段,统一在反序列化处兜底为 "session",
// 避免在每个调用点各自判断。
function deserializeWebhook(json: string): WebhookRecord {
  const record = JSON.parse(json) as WebhookRecord;
  if (!record.target) record.target = "session";
  return record;
}

interface EventRow {
  id: number;
  payload_json: string;
}

export interface StoreHealth {
  ok: boolean;
  executionCount: number;
  eventCount: number;
  statusCounts: Record<string, number>;
}

export class SupervisorStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        engine TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_executions_status_created
        ON executions(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_executions_instance_created
        ON executions(instance_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_events_execution_id
        ON runtime_events(execution_id, id);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        request_id TEXT UNIQUE,
        instance_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_instance_created
        ON sessions(instance_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhooks_created
        ON webhooks(created_at DESC);
    `);
    this.migrateRuntimeEventsForeignKey();
    this.ensureExecutionSessionColumn();
  }

  // Session-level events have no executions row, so the legacy FOREIGN KEY on
  // runtime_events must go. Rebuilds the table once for databases created
  // before sessions became first-class; event ids are preserved.
  private migrateRuntimeEventsForeignKey(): void {
    const foreignKeys = this.database.prepare("PRAGMA foreign_key_list(runtime_events)").all();
    if (foreignKeys.length === 0) return;
    this.database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE runtime_events_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      INSERT INTO runtime_events_migrated (id, execution_id, event_type, payload_json, occurred_at)
        SELECT id, execution_id, event_type, payload_json, occurred_at FROM runtime_events;
      DROP TABLE runtime_events;
      ALTER TABLE runtime_events_migrated RENAME TO runtime_events;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    this.database.exec(
      "CREATE INDEX IF NOT EXISTS idx_runtime_events_execution_id ON runtime_events(execution_id, id);",
    );
  }

  private ensureExecutionSessionColumn(): void {
    const columns = this.database.prepare("PRAGMA table_info(executions)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "session_ref")) {
      this.database.exec("ALTER TABLE executions ADD COLUMN session_ref TEXT NOT NULL DEFAULT ''");
    }
    this.database.exec(
      "CREATE INDEX IF NOT EXISTS idx_executions_session_created ON executions(session_ref, created_at);",
    );
  }

  close(): void {
    this.database.close();
  }

  createExecution(execution: ExecutionRecord): ExecutionRecord {
    this.database
      .prepare(`
        INSERT INTO executions (
          id, request_id, status, engine, instance_id, node_id, session_ref,
          payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        execution.id,
        execution.requestId,
        execution.status,
        execution.engine,
        execution.instanceId,
        execution.nodeId,
        execution.sessionRef,
        JSON.stringify(execution),
        execution.createdAt,
        execution.createdAt,
      );
    return execution;
  }

  saveExecution(execution: ExecutionRecord): ExecutionRecord {
    const result = this.database
      .prepare(`
        UPDATE executions
        SET status = ?, engine = ?, instance_id = ?, node_id = ?, session_ref = ?, payload_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        execution.status,
        execution.engine,
        execution.instanceId,
        execution.nodeId,
        execution.sessionRef,
        JSON.stringify(execution),
        nowIso(),
        execution.id,
      );
    if (result.changes !== 1) {
      throw new Error(`Execution ${execution.id} does not exist`);
    }
    return execution;
  }

  getExecution(id: string): ExecutionRecord | undefined {
    const row = this.database
      .prepare("SELECT payload_json FROM executions WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row ? (JSON.parse(row.payload_json) as ExecutionRecord) : undefined;
  }

  getByRequestId(requestId: string): ExecutionRecord | undefined {
    const row = this.database
      .prepare("SELECT payload_json FROM executions WHERE request_id = ?")
      .get(requestId) as JsonRow | undefined;
    return row ? (JSON.parse(row.payload_json) as ExecutionRecord) : undefined;
  }

  listExecutions(limit = 50): ExecutionRecord[] {
    const rows = this.database
      .prepare("SELECT payload_json FROM executions ORDER BY created_at DESC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 500)) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as ExecutionRecord);
  }

  listExecutionsBySession(sessionRef: string, limit = 200): ExecutionRecord[] {
    const rows = this.database
      .prepare("SELECT payload_json FROM executions WHERE session_ref = ? ORDER BY created_at ASC LIMIT ?")
      .all(sessionRef, Math.min(Math.max(limit, 1), 1_000)) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as ExecutionRecord);
  }

  listActiveExecutions(): ExecutionRecord[] {
    const rows = this.database
      .prepare(`
        SELECT payload_json FROM executions
        WHERE status IN ('queued', 'running', 'waiting_approval')
        ORDER BY created_at ASC
      `)
      .all() as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as ExecutionRecord);
  }

  createSession(session: SessionRecord): SessionRecord {
    this.database
      .prepare(`
        INSERT INTO sessions (id, request_id, instance_id, engine, status, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.id,
        session.requestId || null,
        session.instanceId,
        session.engine,
        session.status,
        JSON.stringify(session),
        session.createdAt,
        session.createdAt,
      );
    return session;
  }

  saveSession(session: SessionRecord): SessionRecord {
    const result = this.database
      .prepare("UPDATE sessions SET status = ?, payload_json = ?, updated_at = ? WHERE id = ?")
      .run(session.status, JSON.stringify(session), nowIso(), session.id);
    if (result.changes !== 1) {
      throw new Error(`Session ${session.id} does not exist`);
    }
    return session;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.database
      .prepare("SELECT payload_json FROM sessions WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row ? (JSON.parse(row.payload_json) as SessionRecord) : undefined;
  }

  getSessionByRequestId(requestId: string): SessionRecord | undefined {
    const row = this.database
      .prepare("SELECT payload_json FROM sessions WHERE request_id = ?")
      .get(requestId) as JsonRow | undefined;
    return row ? (JSON.parse(row.payload_json) as SessionRecord) : undefined;
  }

  listSessions(limit = 50, instanceId?: string): SessionRecord[] {
    const rows = (
      instanceId
        ? this.database
            .prepare("SELECT payload_json FROM sessions WHERE instance_id = ? ORDER BY created_at DESC LIMIT ?")
            .all(instanceId, Math.min(Math.max(limit, 1), 500))
        : this.database
            .prepare("SELECT payload_json FROM sessions ORDER BY created_at DESC LIMIT ?")
            .all(Math.min(Math.max(limit, 1), 500))
    ) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as SessionRecord);
  }

  sessionCounts(): Record<string, number> {
    const rows = this.database
      .prepare("SELECT status, COUNT(*) AS count FROM sessions GROUP BY status")
      .all() as unknown as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  createWebhook(webhook: WebhookRecord): WebhookRecord {
    this.database
      .prepare(`
        INSERT INTO webhooks (id, name, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(webhook.id, webhook.name, JSON.stringify(webhook), webhook.createdAt, webhook.createdAt);
    return webhook;
  }

  saveWebhook(webhook: WebhookRecord): WebhookRecord {
    const result = this.database
      .prepare("UPDATE webhooks SET name = ?, payload_json = ?, updated_at = ? WHERE id = ?")
      .run(webhook.name, JSON.stringify(webhook), nowIso(), webhook.id);
    if (result.changes !== 1) {
      throw new Error(`Webhook ${webhook.id} does not exist`);
    }
    return webhook;
  }

  getWebhook(id: string): WebhookRecord | undefined {
    const row = this.database
      .prepare("SELECT payload_json FROM webhooks WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row ? deserializeWebhook(row.payload_json) : undefined;
  }

  getWebhookByName(name: string): WebhookRecord | undefined {
    const row = this.database
      .prepare("SELECT payload_json FROM webhooks WHERE name = ?")
      .get(name) as JsonRow | undefined;
    return row ? deserializeWebhook(row.payload_json) : undefined;
  }

  listWebhooks(): WebhookRecord[] {
    const rows = this.database
      .prepare("SELECT payload_json FROM webhooks ORDER BY created_at DESC")
      .all() as unknown as JsonRow[];
    return rows.map((row) => deserializeWebhook(row.payload_json));
  }

  deleteWebhook(id: string): boolean {
    const result = this.database.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
    return result.changes === 1;
  }

  appendEvent(event: Omit<RuntimeEvent, "id">): RuntimeEvent {
    const placeholder = { ...event, id: 0 } satisfies RuntimeEvent;
    const result = this.database
      .prepare(`
        INSERT INTO runtime_events (execution_id, event_type, payload_json, occurred_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(event.executionId, event.type, JSON.stringify(placeholder), event.occurredAt);
    const stored = { ...event, id: Number(result.lastInsertRowid) } satisfies RuntimeEvent;
    this.database
      .prepare("UPDATE runtime_events SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(stored), stored.id);
    return stored;
  }

  listAllEvents(afterId = 0, limit = 500): RuntimeEvent[] {
    const rows = this.database
      .prepare("SELECT id, payload_json FROM runtime_events WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(Math.max(afterId, 0), Math.min(Math.max(limit, 1), 2_000)) as unknown as EventRow[];
    return rows.map((row) => ({ ...(JSON.parse(row.payload_json) as RuntimeEvent), id: row.id }));
  }

  lastEventId(): number {
    const row = this.database.prepare("SELECT MAX(id) AS id FROM runtime_events").get() as { id: number | null };
    return Number(row.id ?? 0);
  }

  listEvents(executionId: string, afterId = 0, limit = 500): RuntimeEvent[] {
    const rows = this.database
      .prepare(`
        SELECT id, payload_json FROM runtime_events
        WHERE execution_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(executionId, Math.max(afterId, 0), Math.min(Math.max(limit, 1), 2_000)) as unknown as EventRow[];
    return rows.map((row) => ({ ...(JSON.parse(row.payload_json) as RuntimeEvent), id: row.id }));
  }

  health(): StoreHealth {
    const executionCount = Number(
      (this.database.prepare("SELECT COUNT(*) AS count FROM executions").get() as { count: number }).count,
    );
    const eventCount = Number(
      (this.database.prepare("SELECT COUNT(*) AS count FROM runtime_events").get() as { count: number }).count,
    );
    const rows = this.database
      .prepare("SELECT status, COUNT(*) AS count FROM executions GROUP BY status")
      .all() as unknown as Array<{ status: string; count: number }>;
    return {
      ok: true,
      executionCount,
      eventCount,
      statusCounts: Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])),
    };
  }

  recoverInterruptedExecutions(): number {
    const rows = this.database
      .prepare(`
        SELECT payload_json FROM executions
        WHERE status IN ('queued', 'running', 'waiting_approval')
      `)
      .all() as unknown as JsonRow[];
    const finishedAt = nowIso();
    for (const row of rows) {
      const execution = JSON.parse(row.payload_json) as ExecutionRecord;
      const previousStatus = execution.status;
      execution.status = "failed";
      execution.finishedAt = finishedAt;
      execution.error = "Runtime Gateway restarted while this execution was in flight (process_lost)";
      this.saveExecution(execution);
      this.appendEvent({
        executionId: execution.id,
        type: "execution.reconciled",
        status: "failed",
        producer: "runtime-agent-supervisor",
        subject: { kind: "execution", id: execution.id },
        summary: execution.error,
        data: { reason: "process_lost", previousStatus, sessionRef: execution.sessionRef },
        occurredAt: finishedAt,
      });
    }
    return rows.length;
  }

  reconcileSessions(): number {
    const rows = this.database
      .prepare("SELECT payload_json FROM sessions WHERE status = 'active'")
      .all() as unknown as JsonRow[];
    const timestamp = nowIso();
    for (const row of rows) {
      const session = JSON.parse(row.payload_json) as SessionRecord;
      session.status = "idle";
      if (session.activeExecutionId) {
        session.lastExecutionId = session.activeExecutionId;
        session.activeExecutionId = "";
      }
      session.lastActivityAt = timestamp;
      this.saveSession(session);
      this.appendEvent({
        executionId: "",
        type: "session.reconciled",
        status: "idle",
        producer: "runtime-agent-supervisor",
        subject: { kind: "session", id: session.id },
        summary: "Session returned to idle after the Runtime Gateway restarted",
        data: { reason: "process_lost" },
        occurredAt: timestamp,
      });
    }
    return rows.length;
  }
}
