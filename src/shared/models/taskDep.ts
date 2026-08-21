import { z } from 'zod';
import { IdSchema } from './ids';

/** `(task_id, depends_on_task_id)` composite PK. A join table (§5.0
 * exception) — no timestamps. Cycle rejection is application logic (a
 * graph walk before insert), not a declarative constraint SQLite can
 * express — see `db/repositories/taskDeps.ts`. */
export const TaskDepSchema = z.object({
  task_id: IdSchema,
  depends_on_task_id: IdSchema,
});
export type TaskDep = z.infer<typeof TaskDepSchema>;
