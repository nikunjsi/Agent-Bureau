import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { CheckpointSchema, type Checkpoint, type NewCheckpointInput } from '../../../shared/models/checkpoint';

export function insertCheckpoint(db: Database.Database, input: NewCheckpointInput): Checkpoint {
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
    project_id: input.project_id,
    task_id: input.task_id,
    employee_id: input.employee_id,
    type: input.type,
    urgency: input.urgency,
    tool_call_id: input.tool_call_id,
    tool_name: input.tool_name,
    args_preview: input.args_preview,
    title: input.title,
    context: input.context,
    options: input.options === null ? null : toJsonColumn(input.options),
    preview: input.preview === null ? null : toJsonColumn(input.preview),
    default_action: input.default_action,
    status: input.status,
    expires_at: input.expires_at,
    created_at: now,
    updated_at: now,
  });
  return getCheckpointById(db, id) as Checkpoint;
}

export function getCheckpointById(db: Database.Database, id: string): Checkpoint | null {
  const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id);
  return row ? CheckpointSchema.parse(row) : null;
}
