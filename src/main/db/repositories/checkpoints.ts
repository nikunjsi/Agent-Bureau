import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { CheckpointSchema, NewCheckpointInputSchema, type Checkpoint, type NewCheckpointInput } from '../../../shared/models/checkpoint';

export function insertCheckpoint(db: Database.Database, input: NewCheckpointInput): Checkpoint {
  const parsed = NewCheckpointInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO checkpoints (
       id, project_id, task_id, employee_id, type, urgency, tool_call_id, tool_name, args_preview,
       title, context, options, preview, default_action, status, answer, answered_by,
       expires_at, answered_at, created_at, updated_at
     ) VALUES (
       @id, @project_id, @task_id, @employee_id, @type, @urgency, @tool_call_id, @tool_name, @args_preview,
       @title, @context, @options, @preview, @default_action, @status, NULL, NULL,
       @expires_at, NULL, @created_at, @updated_at
     )`,
  ).run({
    id,
    project_id: parsed.project_id,
    task_id: parsed.task_id,
    employee_id: parsed.employee_id,
    type: parsed.type,
    urgency: parsed.urgency,
    tool_call_id: parsed.tool_call_id,
    tool_name: parsed.tool_name,
    args_preview: parsed.args_preview,
    title: parsed.title,
    context: parsed.context,
    options: parsed.options === null ? null : toJsonColumn(parsed.options),
    preview: parsed.preview === null ? null : toJsonColumn(parsed.preview),
    default_action: parsed.default_action,
    status: parsed.status,
    expires_at: parsed.expires_at,
    created_at: now,
    updated_at: now,
  });
  return getCheckpointById(db, id) as Checkpoint;
}

export function getCheckpointById(db: Database.Database, id: string): Checkpoint | null {
  const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id);
  return row ? CheckpointSchema.parse(row) : null;
}
