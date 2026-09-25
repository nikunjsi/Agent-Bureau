import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { spawnSupervisedEmployee } from '../../../src/main/engine/spawnSupervisedEmployee';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { composeEmployeeContext } from '../../../src/main/company/composeEmployeeContext';
import { insertBrief } from '../../../src/main/db/repositories/briefs';
import {
  setProjectApprovedBrief,
  setProjectBriefAndPlan,
} from '../../../src/main/db/repositories/projects';
import { setEmployeeWorktree } from '../../../src/main/db/repositories/employees';
import { appendDirectorDecision } from '../../../src/main/checkpoints/decisionLog';
import { writeMemory } from '../../../src/main/memory/memoryStore';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { seedPhase, seedPlan, seedProject, seedTask, seedWorktree } from '../../helpers/dbFixtures';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';

/**
 * M11 S3-1, `NEXT-VERSION` §H.6 and §M.5, Appendix B: an employee's first
 * message on a task is Appendix B, every slot filled from real rows —
 * composed by `composeEmployeeContext` (a production function now, not the
 * boundary test's shape) and rendered by the Supervisor when it sends the
 * task. The decision log and the memory pack are two slots of **one**
 * composition. The context carries no model: `Supervisor.assign()` is the
 * one place a model is decided.
 */
describe('an employee’s first message on a task is Appendix B, every slot filled', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let supervisorRegistry: SupervisorRegistry;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-appendix-b-'));
    baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: path.resolve('src/main/db/migrations'),
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    supervisorRegistry = new SupervisorRegistry();
  });

  afterEach(async () => {
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders the role, the task and its criteria, the brief, decisions, memory, workspace, autonomy and escalation', async () => {
    const company = seedCompany(db, path.join(tmpDir, 'home'), 'Luigi & Co');
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });
    const employee = hireEmployee({
      db,
      activityLog,
      companyId: company.id,
      baseDir,
      roleKey: 'engineering:developer',
      name: 'Quinn',
    }).employee;

    const project = seedProject(db, { name: 'Luigi Trattoria' });
    const brief = insertBrief(db, {
      project_id: project.id,
      version: 1,
      status: 'approved',
      markdown: '# Brief',
      content: {
        title: 'Luigi Trattoria website',
        one_liner: 'A small site where diners see the menu and find the phone number.',
        goal: 'Diners can see what is on tonight and call to book.',
        kind: 'software',
        users: 'Diners, mostly on phones.',
        scope: ['A menu page with prices'],
        non_goals: ['Online booking'],
        deliverables: [
          { type: 'repository', name: 'Website', description: 'The site.', acceptance: ['Loads'] },
        ],
        constraints: { tech: [], platform: ['Web'], deadline: null, budget_usd: null, other: [] },
        existing_assets: [],
        success_criteria: ['Diners find the phone number in one tap'],
        assumptions: [],
        open_questions: [],
        risks: [],
      },
    });
    setProjectApprovedBrief(db, project.id, brief.id, 'software');
    const plan = seedPlan(db, { project_id: project.id, brief_id: brief.id, status: 'approved' });
    setProjectBriefAndPlan(db, project.id, brief.id, plan.id);
    const phase = seedPhase(db, { plan_id: plan.id });
    const task = seedTask(db, {
      project_id: project.id,
      phase_id: phase.id,
      title: 'Menu page',
      body: 'Build the menu page from menu.json.',
      acceptance_criteria: ['Every dish shows its price', 'It reads well on a phone'],
    });
    const worktree = seedWorktree(db, {
      project_id: project.id,
      path: path.join(tmpDir, 'worktrees', 'quinn'),
    });
    setEmployeeWorktree(db, employee.id, worktree.id);

    appendDirectorDecision(db, {
      baseDir,
      projectId: project.id,
      decision: {
        title: 'How should diners book a table?',
        askedBecause: 'The site could take bookings.',
        options: ['By phone', 'Online'],
        chosen: 'By phone',
        consequence: 'No booking system; the site shows the number.',
        decidedAtIso: '2026-09-25T10:00:00.000Z',
      },
    });
    writeMemory(db, {
      baseDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'house-style.md',
      title: 'House style',
      body: 'Every page uses the menu font, Lora.',
      source: 'user_stated',
      pinned: true,
    });

    const adapter = new FakeAdapter({ keepOpen: true });
    const spawned = await spawnSupervisedEmployee({
      db,
      activityLog,
      tokenRegistry: new TokenRegistry(),
      supervisorRegistry,
      controlChannelPort: 1,
      employeeId: employee.id,
      adapter,
      baseDir,
    });
    const ctx = composeEmployeeContext(
      {
        db,
        baseDir,
        bundledPacksDir: path.resolve('packs'),
        broker: noopSecretBroker,
        resolveToolsScriptPath: resolveBureauToolsScriptPathForTests,
      },
      spawned,
      employee.id,
      task.id,
    );

    // No model decided here: assign() is the one place (§7.5).
    expect(ctx.modelId).toBeNull();
    expect(ctx.worktreePath).toBe(worktree.path);
    expect(ctx.task?.id).toBe(task.id);

    await spawned.supervisor.assign(ctx);
    const deadline = Date.now() + 5_000;
    while (adapter.sentMessages.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const first = adapter.sentMessages[0]!.text;

    // Who, and the role's own prompt (its first line).
    expect(first).toContain('You are Quinn, a Developer at Luigi & Co.');
    const rolePrompt = readFileSync(path.resolve('packs/engineering/prompts/developer.md'), 'utf8');
    expect(first).toContain(rolePrompt.split('\n').find((line) => line.trim().length > 0)!);
    // The task, and what done means.
    expect(first).toContain(`**${task.display_key} — Menu page**`);
    expect(first).toContain('Build the menu page from menu.json.');
    expect(first).toContain('- Every dish shows its price');
    expect(first).toContain('- It reads well on a phone');
    // The brief.
    expect(first).toContain('A small site where diners see the menu and find the phone number.');
    // One composition, two slots: the decision under its heading, the note under its own.
    const decisions = first.indexOf('## Decisions already made — follow these, do not revisit');
    const known = first.indexOf('## What you know');
    expect(decisions).toBeGreaterThan(-1);
    expect(known).toBeGreaterThan(decisions);
    expect(first.slice(decisions, known)).toContain('How should diners book a table?');
    expect(first.slice(known)).toContain('Every page uses the menu font, Lora.');
    expect(first.slice(known)).not.toContain('How should diners book a table?');
    // The environment.
    expect(first).toContain(`Your workspace: \`${worktree.path}\``);
    expect(first).toContain(`Autonomy level: **${employee.autonomy}**`);
    // When to ask.
    expect(first).toContain('- the acceptance criteria are ambiguous or contradict the brief');
    expect(first).toContain('what you did NOT');
  });
});
