import type Database from 'better-sqlite3';
import type { EngineAdapter } from '../../shared/engine/adapter';
import type { Employee } from '../../shared/models/employee';
import type { Role } from '../../shared/models/role';
import { createClaudeCodeAdapterFromSettings } from './claudeCodeAdapter';
import { GenericPtyAdapter } from './genericPtyAdapter';
import type { ContainProcess } from './containEngineChild';

/**
 * The adapter an employee runs under (M11 S3-1; pre-M11 §F P-2), built the
 * one way that carries the user's settings and Bureau's containment:
 *
 * - `claude-code` through `createClaudeCodeAdapterFromSettings`, like the
 *   Director's (S1-8);
 * - `generic-pty` **bound to the role's `engine_options.command`**. Until a
 *   command is bound, `GenericPtyAdapter.probe()` answers "no command
 *   configured", which `assign()` refuses (P-2), so an unbound one could
 *   never start.
 *
 * Both get `containProcess` (S1-9), so an employee's engine is in Bureau's
 * Job Object like the Director's. An engine Bureau has no adapter for is
 * refused rather than guessed at. The assignment loop (S3-2) is the caller.
 */
export function createEmployeeAdapter(
  db: Database.Database,
  employee: Employee,
  role: Role,
  options: { readonly containProcess?: ContainProcess } = {},
): EngineAdapter {
  const contain =
    options.containProcess === undefined ? {} : { containProcess: options.containProcess };
  switch (employee.engine) {
    case 'claude-code':
      return createClaudeCodeAdapterFromSettings(db, contain);
    case 'generic-pty': {
      const engineOptions = role.engine_options;
      const command =
        engineOptions !== null && 'command' in engineOptions ? engineOptions.command : undefined;
      return new GenericPtyAdapter({ ...(command ? { boundCommand: command } : {}), ...contain });
    }
    default:
      throw new Error(
        `${employee.name} runs on "${employee.engine}", which Bureau has no adapter for`,
      );
  }
}
