import { ipcOk } from '../../../shared/ipc/envelope';
import { Costs as CostsSchemas } from '../../../shared/ipc/schemas/costs';
import { stub, type Handler, type HandlerContext } from './types';

/**
 * §16's Costs group: "spend by day / project / employee / role, budget
 * usage bars, the top-10 most expensive tasks, and the model pricing
 * table in force." Real aggregation over M1's `usage` table (no
 * orchestration needed for *reported* spend) — `pricingTable` alone stays
 * a stub, since it needs M6's actual pricing table.
 *
 * Known simplification, flagged rather than silently claimed as precise:
 * §11.5 defines the cost day-boundary as "local midnight in the user's
 * timezone." Bucketing here uses `date(ts)` (UTC) — genuinely correct
 * per-user-timezone bucketing is real work involving the renderer's
 * timezone or a settings value, which is out of scope for M2's transport.
 */
function summary(ctx: HandlerContext, projectId: string | null) {
  const taskJoin = projectId !== null ? 'JOIN tasks t ON u.task_id = t.id' : '';
  const projectFilter = projectId !== null ? 'AND t.project_id = ?' : '';
  const params: unknown[] = projectId !== null ? [projectId] : [];

  const totalRow = ctx.db
    .prepare(`SELECT COALESCE(SUM(u.cost_usd_micros), 0) as total FROM usage u ${taskJoin} WHERE 1=1 ${projectFilter}`)
    .get(...params) as { total: number };

  const todayRow = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(u.cost_usd_micros), 0) as total FROM usage u ${taskJoin}
       WHERE date(u.ts) = date('now') ${projectFilter}`,
    )
    .get(...params) as { total: number };

  const byDay = ctx.db
    .prepare(
      `SELECT date(u.ts) as date, COALESCE(SUM(u.cost_usd_micros), 0) as usdMicros FROM usage u ${taskJoin}
       WHERE 1=1 ${projectFilter} GROUP BY date(u.ts) ORDER BY date(u.ts) DESC LIMIT 30`,
    )
    .all(...params) as Array<{ date: string; usdMicros: number }>;

  return { totalUsdMicros: totalRow.total, todayUsdMicros: todayRow.total, byDay };
}

function byProject(ctx: HandlerContext) {
  return ctx.db
    .prepare(
      `SELECT p.id as id, p.name as label, COALESCE(SUM(u.cost_usd_micros), 0) as usdMicros
       FROM usage u JOIN tasks t ON u.task_id = t.id JOIN projects p ON t.project_id = p.id
       GROUP BY p.id ORDER BY usdMicros DESC`,
    )
    .all();
}

function byEmployee(ctx: HandlerContext) {
  return ctx.db
    .prepare(
      `SELECT e.id as id, e.name as label, COALESCE(SUM(u.cost_usd_micros), 0) as usdMicros
       FROM usage u JOIN employees e ON u.employee_id = e.id
       GROUP BY e.id ORDER BY usdMicros DESC`,
    )
    .all();
}

function byRole(ctx: HandlerContext) {
  return ctx.db
    .prepare(
      `SELECT e.role_key as id, e.role_key as label, COALESCE(SUM(u.cost_usd_micros), 0) as usdMicros
       FROM usage u JOIN employees e ON u.employee_id = e.id
       GROUP BY e.role_key ORDER BY usdMicros DESC`,
    )
    .all();
}

function topTasks(ctx: HandlerContext, limit: number) {
  return ctx.db
    .prepare(
      `SELECT t.id as taskId, t.display_key as displayKey, t.title as title,
              COALESCE(SUM(u.cost_usd_micros), 0) as usdMicros
       FROM usage u JOIN tasks t ON u.task_id = t.id
       GROUP BY t.id ORDER BY usdMicros DESC LIMIT ?`,
    )
    .all(limit);
}

export const costsHandlers: Record<string, Handler> = {
  summary: (input, ctx) => {
    const { projectId } = CostsSchemas.summary.input.parse(input);
    return ipcOk({ item: summary(ctx, projectId) });
  },
  byProject: (_input, ctx) => ipcOk({ items: byProject(ctx) }),
  byEmployee: (_input, ctx) => ipcOk({ items: byEmployee(ctx) }),
  byRole: (_input, ctx) => ipcOk({ items: byRole(ctx) }),
  topTasks: (input, ctx) => {
    const { limit } = CostsSchemas.topTasks.input.parse(input);
    return ipcOk({ items: topTasks(ctx, limit) });
  },
  pricingTable: stub('M6'),
};
