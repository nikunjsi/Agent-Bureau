import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { insertRole, getRoleByFullKey } from '../../../src/main/db/repositories/roles';
import { nowIso } from '../../../src/shared/models/ids';
import { writeMemory } from '../../../src/main/memory/memoryStore';
import {
  composeMemoryPack,
  estimateTokens,
  renderMemoryPack,
  semanticSearchState,
} from '../../../src/main/memory/memoryPack';
import type { Role } from '../../../src/shared/models/role';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §12.3's memory pack: *"pinned company standards + role playbook + project
 * decisions + top-K search hits for the task text + relevant past lessons,
 * capped at `memory_budget_tokens`."*
 *
 * Five clauses, and each is tested as a clause — because the failure this
 * file exists to catch is a clause that looks present and contributes
 * nothing. The first draft of the lessons clause was exactly that: it re-ran
 * the general search and filtered the results, so everything it found had
 * already been taken by `task_match` and was dropped by the dedupe. A branch
 * that can never contribute, carrying a comment saying what it does, is
 * worse than no branch.
 */
describe('§12.3: the memory pack', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let role: Role;

  const PROJECT_ID = 'proj-000000000000000000000';

  function note(
    scope: 'company' | 'project' | 'role',
    scopeRef: string | null,
    fileName: string,
    body: string,
    pinned = false,
  ): void {
    writeMemory(db, {
      baseDir: tmpDir,
      scope,
      scopeRef,
      fileName,
      title: fileName.replace(/\.md$/, ''),
      body,
      source: 'user_stated',
      pinned,
    });
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-mempack-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);

    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', '{}', nowIso(), nowIso());
    insertRole(db, {
      key: 'developer',
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes code',
      system_prompt_path: 'prompts/developer.md',
      skills: ['code'],
      deliverable_types: ['code'],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: ['company', 'project', 'role'],
      autonomy_default: 'guided',
      sprite_key: 'dev',
    } as never);
    role = getRoleByFullKey(db, 'engineering:developer') as Role;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('takes all five §12.3 clauses, each contributing something the others do not', () => {
    note('company', null, 'standards.md', '# Standards\n\nAlways write a test first.', true);
    note(
      'role',
      'engineering/developer',
      'playbook.md',
      '# Playbook\n\nOpen a branch per task.',
      true,
    );
    note('project', PROJECT_ID, 'decisions.md', '# Decisions\n\nWe chose SQLite.', true);
    note('project', PROJECT_ID, 'glossary.md', '# Glossary\n\nA ledger is an append-only file.');
    note(
      'role',
      'engineering/developer',
      'lessons.md',
      '# Lessons\n\nThe ledger import needs a bigger timeout.',
    );

    const pack = composeMemoryPack(db, {
      role,
      projectId: PROJECT_ID,
      taskText: 'Fix the ledger import',
    });

    const kinds = new Set(pack.items.map((item) => item.kind));
    expect(kinds).toContain('company_standard');
    expect(kinds).toContain('role_playbook');
    expect(kinds).toContain('project_decision');
    // The unpinned glossary reaches the pack only because it matches the
    // task text — the top-K clause doing its own job.
    expect(kinds).toContain('task_match');

    // Every note is in the pack, including the lesson.
    const paths = pack.items.map((item) => item.path);
    expect(paths).toContain('role/engineering/developer/lessons.md');

    // **The lesson's `kind` here is `task_match`, and that is correct.**
    // Clauses run in §12.3's order and a note is taken by the first one that
    // claims it, so a lesson the general search already found IS a task
    // match — labelling it twice would put it in the pack twice. What the
    // separate lessons clause buys is slots when the general search is full,
    // which is the next test.
    expect(pack.items.find((item) => item.path.endsWith('lessons.md'))?.kind).toBe('task_match');
  });

  it('the lessons clause has its own budget — it is not a filter over the top-K', () => {
    // The regression. With `topK: 1` the general search can hold exactly one
    // note, and here that slot goes to a non-lesson. A lessons clause
    // implemented as "search again and filter" contributes nothing under
    // these conditions; one with its own query still finds the lesson.
    note('project', PROJECT_ID, 'glossary.md', '# Glossary\n\nThe ledger is append-only.');
    note('project', PROJECT_ID, 'context.md', '# Context\n\nThe ledger is the core of it.');
    note(
      'role',
      'engineering/developer',
      'lessons.md',
      '# Lessons\n\nThe ledger import needs a bigger timeout.',
    );

    const pack = composeMemoryPack(db, {
      role,
      projectId: PROJECT_ID,
      taskText: 'ledger',
      topK: 1,
    });

    const lessons = pack.items.filter((item) => item.kind === 'lesson');
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.path).toBe('role/engineering/developer/lessons.md');
  });

  it('a note that is both pinned and a search hit appears once, as the higher clause', () => {
    note('company', null, 'standards.md', '# Standards\n\nThe ledger must balance.', true);

    const pack = composeMemoryPack(db, { role, projectId: PROJECT_ID, taskText: 'ledger' });

    expect(pack.items).toHaveLength(1);
    // §12.3's order is also the priority order: a company standard is a
    // company standard, not a keyword match that happens to be pinned.
    expect(pack.items[0]?.kind).toBe('company_standard');
  });

  it('stops at the budget, takes notes whole, and reports what it dropped', () => {
    const long = `# Long\n\n${'word '.repeat(400)}`;
    note('company', null, 'a.md', long, true);
    note('company', null, 'b.md', long, true);
    note('company', null, 'c.md', long, true);

    // Each note is ~500 estimated tokens, so this fits exactly one.
    setSetting(db, 'memory.defaultBudgetTokens', 600);
    db.prepare('UPDATE roles SET memory_budget_tokens = 600 WHERE full_key = ?').run(role.full_key);
    const budgeted = getRoleByFullKey(db, role.full_key) as Role;

    const pack = composeMemoryPack(db, { role: budgeted, projectId: null, taskText: 'nothing' });

    expect(pack.estimatedTokens).toBeLessThanOrEqual(600);
    expect(pack.items).toHaveLength(1);
    // Reported, never silently discarded: the caller can tell the difference
    // between "that is everything" and "that is what fitted".
    expect(pack.droppedCount).toBe(2);
    // Whole, not truncated: an agent cannot tell that a standard it is
    // reading stops mid-sentence, and half a rule reads like a whole one.
    for (const item of pack.items) {
      expect(item.body).toBe(long);
    }
  });

  it('a role with no memory scopes gets nothing, rather than everything', () => {
    note('company', null, 'standards.md', '# Standards\n\nSecret.', true);
    db.prepare("UPDATE roles SET memory_scopes = '[]' WHERE full_key = ?").run(role.full_key);
    const scopeless = getRoleByFullKey(db, role.full_key) as Role;

    const pack = composeMemoryPack(db, {
      role: scopeless,
      projectId: PROJECT_ID,
      taskText: 'standards',
    });

    expect(pack.items).toEqual([]);
    expect(renderMemoryPack(pack)).toBe('');
  });

  it('a task title full of FTS operators is a search, not a syntax error', () => {
    // §12.1: "search input is not a query language". The task text goes in
    // verbatim, and `-`, `NEAR` and an unbalanced quote are all plausible in
    // a real title.
    note('project', PROJECT_ID, 'context.md', '# Context\n\nThe importer is fussy.');

    expect(() =>
      composeMemoryPack(db, {
        role,
        projectId: PROJECT_ID,
        taskText: 'fix the "importer NEAR the -thing',
      }),
    ).not.toThrow();

    // And text with no searchable tokens matches nothing rather than
    // everything, which would silently blow the budget.
    const empty = composeMemoryPack(db, { role, projectId: PROJECT_ID, taskText: '--- *** ---' });
    expect(empty.items.filter((item) => item.kind === 'task_match')).toEqual([]);
  });

  it('reports the semantic layer honestly in both states', () => {
    expect(semanticSearchState(db)).toBe('off');
    setSetting(db, 'memory.semanticSearch', true);
    // §12.1's degrade-loudly: asked for, not available, and the caller is
    // told — never a silent fallback that looks like it worked.
    expect(semanticSearchState(db)).toBe('unavailable');
  });

  it('estimateTokens is an estimate, and says so by being one', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
