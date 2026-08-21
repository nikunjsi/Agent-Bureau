import { describe, expect, it } from 'vitest';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { ProjectSchema } from '../../../src/shared/models/project';
import { BriefSchema } from '../../../src/shared/models/brief';
import { PlanSchema } from '../../../src/shared/models/plan';
import { PhaseSchema } from '../../../src/shared/models/phase';
import { TaskSchema } from '../../../src/shared/models/task';
import { TaskDepSchema } from '../../../src/shared/models/taskDep';
import { WorktreeSchema } from '../../../src/shared/models/worktree';

describe('ProjectSchema', () => {
  it('parses protected_refs JSON and the display key format', () => {
    const now = nowIso();
    const parsed = ProjectSchema.parse({
      id: newId(),
      display_key: 'P-003',
      name: 'Test',
      path: 'C:\\home\\test',
      repo_initialised: 1,
      base_ref: 'main',
      protected_refs: JSON.stringify(['main', 'master']),
      kind: 'software',
      stage: 'intake',
      brief_id: null,
      plan_id: null,
      budget_usd_micros: null,
      spend_usd_micros: 0,
      created_at: now,
      updated_at: now,
    });
    expect(parsed.protected_refs).toEqual(['main', 'master']);
    expect(parsed.repo_initialised).toBe(true);
  });
});

describe('BriefSchema / PlanSchema', () => {
  it('both have updated_at even though only §5.1s own listing shows created_at (finding #1)', () => {
    const now = nowIso();
    const brief = BriefSchema.parse({
      id: newId(),
      project_id: newId(),
      version: 1,
      content: '{}',
      markdown: '# Brief',
      status: 'draft',
      approved_at: null,
      created_at: now,
      updated_at: now,
    });
    expect(brief.updated_at).toBe(now);

    const plan = PlanSchema.parse({
      id: newId(),
      project_id: newId(),
      brief_id: newId(),
      version: 1,
      content: '{}',
      estimated_cost_usd_micros: null,
      status: 'draft',
      approved_at: null,
      created_at: now,
      updated_at: now,
    });
    expect(plan.updated_at).toBe(now);
  });
});

describe('PhaseSchema', () => {
  it('parses review_required as boolean and requires created_at/updated_at (finding #1)', () => {
    const now = nowIso();
    const parsed = PhaseSchema.parse({
      id: newId(),
      plan_id: newId(),
      ordinal: 1,
      name: 'Phase 1',
      goal: 'Ship it',
      review_required: 1,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
    expect(parsed.review_required).toBe(true);
  });
});

describe('TaskSchema', () => {
  it('requires a non-empty acceptance_criteria array', () => {
    const now = nowIso();
    expect(() =>
      TaskSchema.parse({
        id: newId(),
        display_key: 'T-0001',
        project_id: newId(),
        phase_id: null,
        parent_task_id: null,
        title: 'x',
        body: 'x',
        acceptance_criteria: '[]',
        required_skills: '[]',
        deliverable_type: null,
        assignee_employee_id: null,
        excluded_employees: '[]',
        status: 'queued',
        status_reason: null,
        priority: 50,
        attempts: 0,
        reassignments: 0,
        estimated_cost_usd_micros: null,
        spend_usd_micros: null,
        result_summary: null,
        started_at: null,
        finished_at: null,
        created_at: now,
        updated_at: now,
      }),
    ).toThrow(/acceptance_criteria|too_small|array/i);
  });

  it('accepts a task with acceptance criteria', () => {
    const now = nowIso();
    const parsed = TaskSchema.parse({
      id: newId(),
      display_key: 'T-0001',
      project_id: newId(),
      phase_id: null,
      parent_task_id: null,
      title: 'x',
      body: 'x',
      acceptance_criteria: JSON.stringify(['it builds', 'tests pass']),
      required_skills: '[]',
      deliverable_type: 'code',
      assignee_employee_id: null,
      excluded_employees: '[]',
      status: 'queued',
      status_reason: null,
      priority: 50,
      attempts: 0,
      reassignments: 0,
      estimated_cost_usd_micros: null,
      spend_usd_micros: null,
      result_summary: null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
    });
    expect(parsed.acceptance_criteria).toEqual(['it builds', 'tests pass']);
  });
});

describe('TaskDepSchema', () => {
  it('is just the composite key pair, no timestamps (join-table exception)', () => {
    const parsed = TaskDepSchema.parse({ task_id: newId(), depends_on_task_id: newId() });
    expect(Object.keys(parsed).sort()).toEqual(['depends_on_task_id', 'task_id']);
  });
});

describe('WorktreeSchema', () => {
  it('parses status and requires created_at/updated_at (finding #1)', () => {
    const now = nowIso();
    const parsed = WorktreeSchema.parse({
      id: newId(),
      project_id: newId(),
      path: 'C:\\worktrees\\a',
      branch: 'bureau/ravi/T-0001',
      base_commit: 'abc123',
      lease_holder: null,
      lease_expires_at: null,
      status: 'free',
      created_at: now,
      updated_at: now,
    });
    expect(parsed.status).toBe('free');
  });
});
