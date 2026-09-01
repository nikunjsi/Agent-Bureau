import { describe, expect, it } from 'vitest';
import { checkLevel, checkAllLevels, localMidnightIso, type LevelCheckInput, type LevelInputs } from '../../../src/main/cost/budgetCheck';

describe('checkLevel (§11.5/§16.1) — stateless before/after crossing detection', () => {
  it('is ok when no budget is configured at this level', () => {
    const result = checkLevel({ beforeMicros: 999_999, afterMicros: 1_000_000, budgetMicros: null }, 80);
    expect(result).toEqual({ outcome: 'ok', crossedWarnThisTurn: false, crossedExceededThisTurn: false });
  });

  it('is ok when a budget is configured but this turn does not cross the warn threshold', () => {
    const result = checkLevel({ beforeMicros: 0, afterMicros: 100, budgetMicros: 1_000_000 }, 80);
    expect(result.outcome).toBe('ok');
  });

  it('fires warn exactly on the turn that crosses the warn threshold, not before', () => {
    // budget 1,000,000, warnAtPct 80 -> threshold 800,000
    const before: LevelCheckInput = { beforeMicros: 790_000, afterMicros: 799_999, budgetMicros: 1_000_000 };
    expect(checkLevel(before, 80).outcome).toBe('ok');

    const crossing: LevelCheckInput = { beforeMicros: 790_000, afterMicros: 810_000, budgetMicros: 1_000_000 };
    const result = checkLevel(crossing, 80);
    expect(result.outcome).toBe('warn');
    expect(result.crossedWarnThisTurn).toBe(true);
    expect(result.crossedExceededThisTurn).toBe(false);
  });

  it('does not re-report a turn that is already past the warn threshold before it starts — the crossing already happened on an earlier turn, and outcome is per-turn, not persistent state', () => {
    // Already past the warn threshold before this turn starts — the
    // crossing already happened on some earlier turn. No "already warned"
    // tracking column exists (by design — see budgetCheck.ts's own header
    // comment), so this turn's own outcome is 'ok': it neither crosses the
    // warn threshold nor the hard limit THIS turn.
    const stillWarn: LevelCheckInput = { beforeMicros: 810_000, afterMicros: 820_000, budgetMicros: 1_000_000 };
    const result = checkLevel(stillWarn, 80);
    expect(result.outcome).toBe('ok');
    expect(result.crossedWarnThisTurn).toBe(false);
  });

  it('fires exceeded exactly on the turn that crosses the hard limit, and outcome stays exceeded (idempotent) on a later turn without crossedExceededThisTurn firing again', () => {
    const crossing: LevelCheckInput = { beforeMicros: 950_000, afterMicros: 1_050_000, budgetMicros: 1_000_000 };
    const crossed = checkLevel(crossing, 80);
    expect(crossed.outcome).toBe('exceeded');
    expect(crossed.crossedExceededThisTurn).toBe(true);
    expect(crossed.crossedWarnThisTurn).toBe(false); // exceeded supersedes warn on the same turn

    const stillOver: LevelCheckInput = { beforeMicros: 1_050_000, afterMicros: 1_100_000, budgetMicros: 1_000_000 };
    const later = checkLevel(stillOver, 80);
    expect(later.outcome).toBe('exceeded'); // idempotent enforcement signal
    expect(later.crossedExceededThisTurn).toBe(false); // but not a repeat report
  });

  it('a single turn that jumps straight past both thresholds reports exceeded only, not warn-then-exceeded', () => {
    const jump: LevelCheckInput = { beforeMicros: 0, afterMicros: 2_000_000, budgetMicros: 1_000_000 };
    const result = checkLevel(jump, 80);
    expect(result.outcome).toBe('exceeded');
    expect(result.crossedExceededThisTurn).toBe(true);
    expect(result.crossedWarnThisTurn).toBe(false);
  });

  it('treats budgetMicros <= 0 the same as null — no budget configured', () => {
    const result = checkLevel({ beforeMicros: 0, afterMicros: 1_000_000, budgetMicros: 0 }, 80);
    expect(result.outcome).toBe('ok');
  });
});

describe('checkAllLevels — per-level events, single most-severe verdict', () => {
  const budget1M = (before: number, after: number): LevelCheckInput => ({ beforeMicros: before, afterMicros: after, budgetMicros: 1_000_000 });

  it('returns an empty perLevel and null mostSevere when every level is null/ok', () => {
    const inputs: LevelInputs = {
      task: null,
      project: null,
      employeeDaily: null,
      globalDaily: budget1M(0, 100),
    };
    const result = checkAllLevels(inputs, 80);
    expect(result.perLevel).toHaveLength(1);
    expect(result.perLevel[0]?.result.outcome).toBe('ok');
    expect(result.mostSevere).toBeNull();
  });

  it('a project-level exceeded does not swallow a same-turn task-level warn — both get reported (the user\'s explicit per-level-event correction)', () => {
    const inputs: LevelInputs = {
      task: budget1M(790_000, 810_000), // crosses warn this turn
      project: { beforeMicros: 950_000, afterMicros: 1_050_000, budgetMicros: 1_000_000 }, // crosses exceeded this turn
      employeeDaily: null,
      globalDaily: budget1M(0, 100), // ok
    };
    const result = checkAllLevels(inputs, 80);

    const taskEntry = result.perLevel.find((p) => p.level === 'task');
    const projectEntry = result.perLevel.find((p) => p.level === 'project');
    expect(taskEntry?.result.crossedWarnThisTurn).toBe(true);
    expect(projectEntry?.result.crossedExceededThisTurn).toBe(true);

    // The single verdict the caller acts on is the most severe — exceeded
    // beats warn — but the task-level warn crossing is still present above,
    // not discarded.
    expect(result.mostSevere).toEqual({ level: 'project', outcome: 'exceeded' });
  });

  it('among equal severities, the first level in task > project > employeeDaily > globalDaily order wins attribution', () => {
    const inputs: LevelInputs = {
      task: budget1M(950_000, 1_050_000), // exceeded
      project: { beforeMicros: 950_000, afterMicros: 1_050_000, budgetMicros: 1_000_000 }, // also exceeded
      employeeDaily: null,
      globalDaily: budget1M(0, 100),
    };
    const result = checkAllLevels(inputs, 80);
    expect(result.mostSevere).toEqual({ level: 'task', outcome: 'exceeded' });
  });

  it('excludes null-input levels from perLevel entirely (e.g. Director\'s exempt employeeDaily)', () => {
    const inputs: LevelInputs = {
      task: null,
      project: null,
      employeeDaily: null, // Director exemption
      globalDaily: budget1M(0, 100),
    };
    const result = checkAllLevels(inputs, 80);
    expect(result.perLevel.map((p) => p.level)).toEqual(['globalDaily']);
  });
});

describe('localMidnightIso (§11.5.1: "day boundary is local midnight in the user\'s timezone")', () => {
  it('zeroes out the time-of-day components in local time', () => {
    const now = new Date(2026, 7, 29, 15, 42, 10); // 2026-08-29 15:42:10 local
    const midnight = new Date(localMidnightIso(now));
    expect(midnight.getFullYear()).toBe(2026);
    expect(midnight.getMonth()).toBe(7);
    expect(midnight.getDate()).toBe(29);
    expect(midnight.getHours()).toBe(0);
    expect(midnight.getMinutes()).toBe(0);
    expect(midnight.getSeconds()).toBe(0);
  });

  it('returns a real ISO string, matching every other ts column\'s storage convention', () => {
    const iso = localMidnightIso(new Date(2026, 0, 1, 9, 0, 0));
    expect(() => new Date(iso).toISOString()).not.toThrow();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
