import { setEmployeeStatusDetail } from '../../db/repositories/employees';
import { ReportStatusArgsSchema } from './schemas';
import type { ToolHandler } from './types';

/**
 * §7.9: bureau_report_status — FULL. Sets employees.status_detail (drives
 * the speech bubble), always the *caller's own* row — no employee_id
 * argument exists to accept, closing any cross-employee question at the
 * design level. Rate limiting (1/3s) is enforced server-side in server.ts
 * before this handler ever runs (RateLimiter, keyed by tool name).
 */
export const handleReportStatus: ToolHandler = (ctx, rawArgs) => {
  const parsed = ReportStatusArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_report_status: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  setEmployeeStatusDetail(ctx.db, ctx.employeeId, parsed.data.status_detail);
  ctx.activityLog.logEvent({
    actor: `employee:${ctx.employeeId}`,
    type: 'employee.status_reported',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: ctx.employeeId,
    checkpoint_id: null,
    payload: { status_detail: parsed.data.status_detail },
  });

  return { ok: true, data: { ok: true } };
};
