import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertConversationMessage } from '../../../src/main/db/repositories/conversationMessages';
import { writeMemory } from '../../../src/main/memory/memoryStore';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { transitionDirectorState } from '../../../src/main/director/directorState';
import { assembleDirectorContext } from '../../../src/main/director/assembleDirectorContext';
import { seedBrief, seedPhase, seedPlan, seedProject, seedTask } from '../../helpers/dbFixtures';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * §8.0.1's assembly and Appendix A.2's slots, each filled from real rows
 * (M11 context assembly). One conversation with a project, a brief, a plan,
 * tasks, spend, a roster, pinned notes, a decision log, a searchable note,
 * and chat history with two attachments — one inside the project, one not
 * (decision E-3).
 */
const SHIPPED_PACKS = path.resolve('packs');

describe("the Director's context, assembled from real rows", () => {
  let tmpDir: string;
  let baseDir: string;
  let projectDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let conversationId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-director-context-'));
    baseDir = path.join(tmpDir, 'userData');
    projectDir = path.join(tmpDir, 'bakery-site');
    mkdirSync(projectDir, { recursive: true });
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
    const company = seedCompany(db, path.join(tmpDir, 'home'));
    db.prepare('UPDATE companies SET name = ? WHERE id = ?').run('Crumb & Co', company.id);
    installShippedPack({ db, activityLog, baseDir, packKey: 'operations' });
    installShippedPack({ db, activityLog, baseDir, packKey: 'engineering' });
    hireEmployee({
      db,
      activityLog,
      companyId: company.id,
      baseDir,
      roleKey: 'operations:director',
    });
    hireEmployee({
      db,
      activityLog,
      companyId: company.id,
      baseDir,
      roleKey: 'engineering:developer',
      name: 'Quinn',
    });

    const project = seedProject(db, { name: 'Bakery website', path: projectDir });
    db.prepare(
      'UPDATE projects SET stage = ?, budget_usd_micros = ?, spend_usd_micros = ? WHERE id = ?',
    ).run('executing', 5_000_000, 1_250_000, project.id);
    const brief = seedBrief(db, {
      project_id: project.id,
      markdown: 'A small site where families order cakes online.',
      content: { summary: 'A small site where families order cakes online.' },
    } as never);
    const plan = seedPlan(db, { project_id: project.id, brief_id: brief.id });
    seedPhase(db, { plan_id: plan.id, name: 'Menu page', goal: 'Show the cakes.' });
    seedTask(db, { project_id: project.id, title: 'Menu', status: 'done' });
    seedTask(db, { project_id: project.id, title: 'Order form', status: 'done' });
    seedTask(db, { project_id: project.id, title: 'Payments', status: 'queued' });

    writeMemory(db, {
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      baseDir,
      title: 'Standards',
      body: 'Every site we ship passes an accessibility check.',
      source: 'user_stated',
      pinned: true,
    } as never);
    writeMemory(db, {
      scope: 'project',
      scopeRef: project.id,
      fileName: 'decisions.md',
      baseDir,
      title: 'Decisions',
      body: '- Payments go through the bakery’s existing card reader provider.',
      source: 'observed',
      pinned: true,
    } as never);
    writeMemory(db, {
      scope: 'company',
      scopeRef: null,
      fileName: 'cakes.md',
      baseDir,
      title: 'Cake pricing',
      body: 'Custom cakes are quoted per tier, never per slice.',
      source: 'user_stated',
    } as never);

    conversationId = insertConversation(db, {
      company_id: company.id,
      project_id: project.id,
      title: 'Bakery website',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    }).id;
    transitionDirectorState(db, activityLog, conversationId, 'INTAKE', { trigger: 'new_project' });
    insertConversationMessage(db, {
      conversation_id: conversationId,
      project_id: project.id,
      author: 'user',
      kind: 'text',
      body: 'Here is the menu and last year’s price list.',
      payload: {
        attachments: [
          path.join(projectDir, 'menu.pdf'),
          'C:\\Users\\someone\\Desktop\\prices.xlsx',
        ],
      },
      checkpoint_id: null,
      status: 'complete',
    });
    insertConversationMessage(db, {
      conversation_id: conversationId,
      project_id: project.id,
      author: 'user',
      kind: 'text',
      body: 'What does custom cake pricing look like?',
      payload: null,
      checkpoint_id: null,
      status: 'complete',
    });
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const assemble = (budgetTokens?: number) =>
    assembleDirectorContext(
      { db, baseDir, bundledPacksDir: SHIPPED_PACKS },
      { conversationId, ...(budgetTokens === undefined ? {} : { budgetTokens }) },
    );

  it('every Appendix A.2 slot is filled from a real row, and none is left as a placeholder', () => {
    const { text, dropped } = assemble();
    expect(dropped).toEqual([]);
    expect(text).not.toMatch(/\{\{[a-z_]+\}\}/);
    // company_name, user_name
    expect(text).toContain('You are the Director of Crumb & Co');
    expect(text).toContain('for one person: the user');
    // director_state (S1-14)
    expect(text).toContain('Your current state in this conversation: INTAKE');
    // standards: a pinned company note
    expect(text).toContain('Every site we ship passes an accessibility check.');
    // project: name, stage, brief, plan, progress, spend
    expect(text).toContain('Bakery website');
    expect(text).toContain('stage: executing');
    expect(text).toContain('A small site where families order cakes online.');
    expect(text).toContain('Menu page');
    expect(text).toContain('2/3 tasks done');
    expect(text).toContain('$1.25 of $5.00');
    // decision_log
    expect(text).toContain('existing card reader provider');
    // team
    expect(text).toContain('Quinn');
    // memory_pack: the searchable note, found from the latest user message
    expect(text).toContain('quoted per tier');
    // recent conversation, newest first, with E-3's attachments
    const newest = text.indexOf('What does custom cake pricing look like?');
    const older = text.indexOf('Here is the menu');
    expect(newest).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(newest);
    expect(text).toContain(
      `${path.join(projectDir, 'menu.pdf')} (inside the project — you can Read it)`,
    );
    expect(text).toContain(
      'C:\\Users\\someone\\Desktop\\prices.xlsx (outside the project — you cannot open it; ask the user for what you need from it)',
    );
    // max_intake_rounds, tool_list
    expect(text).toContain('Cap the interview at 3 rounds');
    expect(text).toContain('bureau_report');
  });

  it('over the budget, layers go from the bottom and the slot says so', () => {
    const full = assemble();
    const { text, dropped } = assemble(full.estimatedTokens - 1);
    expect(dropped).toEqual(['conversation']);
    expect(text).not.toContain('What does custom cake pricing look like?');
    expect(text).toContain('Not included this turn');
    expect(text).toContain('Every site we ship passes an accessibility check.');
  });

  it('the budget is `director.contextBudgetTokens` when none is given', () => {
    setSetting(db, 'director.contextBudgetTokens', 1);
    const { dropped, text } = assemble();
    expect(dropped).toEqual(
      ['standards', 'project', 'decisions', 'team', 'memory', 'conversation'].reverse(),
    );
    expect(text).toContain('You are the Director of Crumb & Co');
  });
});
