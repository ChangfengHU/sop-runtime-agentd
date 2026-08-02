import { DatabaseSync } from "node:sqlite";

import type { ExecutionRecord, RuntimeEvent } from "./contracts.js";
import { nowIso } from "./util.js";

interface JsonRow {
  payload_json: string;
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
        occurred_at TEXT NOT NULL,
        FOREIGN KEY(execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_events_execution_id
        ON runtime_events(execution_id, id);
    `);
  }

  close(): void {
    this.database.close();
  }

  createExecution(execution: ExecutionRecord): ExecutionRecord {
    this.database
      .prepare(`
        INSERT INTO executions (
          id, request_id, status, engine, instance_id, node_id,
          payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        execution.id,
        execution.requestId,
        execution.status,
        execution.engine,
        execution.instanceId,
        execution.nodeId,
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
        SET status = ?, engine = ?, instance_id = ?, node_id = ?, payload_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        execution.status,
        execution.engine,
        execution.instanceId,
        execution.nodeId,
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
      execution.status = "failed";
      execution.finishedAt = finishedAt;
      execution.error = "Runtime Agent Supervisor restarted before this execution completed";
      this.saveExecution(execution);
      this.appendEvent({
        executionId: execution.id,
        type: "execution.recovered_as_failed",
        status: "failed",
        producer: "runtime-agent-supervisor",
        subject: { kind: "execution", id: execution.id },
        summary: execution.error,
        data: { previousStatus: "interrupted" },
        occurredAt: finishedAt,
      });
    }
    return rows.length;
  }
}
