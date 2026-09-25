import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertBrief } from '../../../src/main/db/repositories/briefs';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import { createProject } from '../../../src/main/projects/createProject';
import { approveBriefWithDeliverables } from '../../../src/main/projects/briefApproval';
import { ensureProjectWorkspace } from '../../../src/main/workspace/projectWorkspace';
import { hireEmployeeWorktree } from '../../../src/main/workspace/employeeWorktree';
import { seedEmployee } from '../../helpers/dbFixtures';
import { seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S3-0 (2), §F S2-1b: `createProject` records `<home>/<slug>` as a
 * chat-created project's folder and creates nothing on disk, and the first
 * assignment needs a git repository there to branch a worktree from.
 *
 * `ensureProjectWorkspace` is what the first assignment calls (S3-2). It
 * never runs before the brief is approved (invariant #2). It uses a folder
 * the approved brief names as existing work (§8.1, "Existing assets") and
 * verifies it; otherwise it creates `<home>/<slug>` and initialises it with
 * an initial commit. It is idempotent, emits exactly one
 * `project.workspace_ready`, and a failure comes back as a plain reason for
 * the caller to block the task with — never a blind retry.
 *
 * Real git throughout.
 */
describe('a project’s folder is a real repository before its first assignment', () => {
  let tmpDir: string;
  let homeDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-project-ws-'));
    homeDir = path.join(tmpDir, 'home');
    mkdirSync(homeDir, { recursive: true });
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
    companyId = seedCompany(db, homeDir).id;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const events = (type: string) =>
    readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === type);

  /** A project created from the chat, the way S2-1b creates one. */
  function chatProject(): string {
    const conversation = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Test Co',
    });
    return createProject(
      { db, activityLog },
      {
        companyId,
        name: 'Luigi Trattoria',
        conversation: { bind: conversation.id },
        actor: 'user',
        reason: 'test',
      },
    ).project.id;
  }

  function approveBrief(projectId: string, existingAssets: string[]): void {
    const brief = insertBrief(db, {
      project_id: projectId,
      version: 1,
      status: 'awaiting_approval',
      markdown: '# Brief',
      content: {
        title: 'Luigi Trattoria website',
        one_liner: 'A small site.',
        goal: 'Diners can find the phone number.',
        kind: 'software',
        users: 'Diners.',
        scope: ['A menu page'],
        non_goals: [],
        deliverables: [
          {
            type: 'repository',
            name: 'Website source',
            description: 'The site.',
            acceptance: ['It loads'],
          },
        ],
        constraints: { tech: [], platform: [], deadline: null, budget_usd: null, other: [] },
        existing_assets: existingAssets,
        success_criteria: ['It loads'],
        assumptions: [],
        open_questions: [],
        risks: [],
      },
    });
    expect(approveBriefWithDeliverables({ db, activityLog }, brief.id).kind).toBe('approved');
  }

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  it('a chat-created project gets <home>/<slug> as a repository with a commit, once', async () => {
    const projectId = chatProject();
    const folder = getProjectById(db, projectId)!.path;
    expect(existsSync(folder)).toBe(false);
    approveBrief(projectId, []);

    const result = await ensureProjectWorkspace({ db, activityLog }, projectId);

    expect(result).toEqual({ ok: true, path: folder });
    expect(git(folder, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    const head = git(folder, 'rev-parse', 'HEAD');
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    // Its first branch is the project’s base, whatever git would call it here.
    expect(git(folder, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(getProjectById(db, projectId)!.base_ref).toBe('main');
    expect(getProjectById(db, projectId)).toMatchObject({ path: folder, repo_initialised: true });
    expect(events('project.workspace_ready')).toHaveLength(1);
    expect(events('project.workspace_ready')[0]!.payload).toMatchObject({
      path: folder,
      source: 'created',
    });

    // Idempotent: nothing new, no second event.
    expect(await ensureProjectWorkspace({ db, activityLog }, projectId)).toEqual({
      ok: true,
      path: folder,
    });
    expect(git(folder, 'rev-parse', 'HEAD')).toBe(head);
    expect(events('project.workspace_ready')).toHaveLength(1);

    // The first assignment's worktree can branch from it.
    const employee = seedEmployee(db);
    const worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project: getProjectById(db, projectId)!,
      employee,
      companyHomePath: homeDir,
    });
    expect(existsSync(worktree.path)).toBe(true);
    expect(worktree.base_commit).toBe(head);
  });

  it('a folder the brief names as existing work is used, not replaced', async () => {
    const existing = path.join(tmpDir, 'my-old-site');
    mkdirSync(existing);
    writeFileSync(path.join(existing, 'index.html'), '<h1>Luigi</h1>');
    const projectId = chatProject();
    const slugFolder = getProjectById(db, projectId)!.path;
    approveBrief(projectId, ['The old menu PDF', existing]);

    const result = await ensureProjectWorkspace({ db, activityLog }, projectId);

    expect(result).toEqual({ ok: true, path: existing });
    expect(readFileSync(path.join(existing, 'index.html'), 'utf8')).toBe('<h1>Luigi</h1>');
    expect(git(existing, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    expect(existsSync(slugFolder)).toBe(false);
    expect(getProjectById(db, projectId)).toMatchObject({ path: existing, repo_initialised: true });
    expect(events('project.workspace_ready')[0]!.payload).toMatchObject({ source: 'existing' });
  });

  it('an existing repository on another branch keeps it, and it becomes the project’s base', async () => {
    const existing = path.join(tmpDir, 'their-repo');
    mkdirSync(existing);
    git(existing, 'init', '--initial-branch=trunk');
    writeFileSync(path.join(existing, 'README.md'), 'Luigi');
    git(existing, 'add', 'README.md');
    git(existing, '-c', 'user.name=U', '-c', 'user.email=u@example.com', 'commit', '-m', 'mine');
    const theirHead = git(existing, 'rev-parse', 'HEAD');
    const projectId = chatProject();
    approveBrief(projectId, [existing]);

    expect(await ensureProjectWorkspace({ db, activityLog }, projectId)).toEqual({
      ok: true,
      path: existing,
    });

    expect(git(existing, 'rev-parse', 'HEAD')).toBe(theirHead);
    expect(git(existing, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
    expect(getProjectById(db, projectId)).toMatchObject({ base_ref: 'trunk' });
  });

  it('a named folder that is not there blocks with a plain reason, and nothing is created', async () => {
    const missing = path.join(tmpDir, 'not-there');
    const projectId = chatProject();
    const slugFolder = getProjectById(db, projectId)!.path;
    approveBrief(projectId, [missing]);

    const result = await ensureProjectWorkspace({ db, activityLog }, projectId);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(missing);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(slugFolder)).toBe(false);
    expect(getProjectById(db, projectId)!.repo_initialised).toBe(false);
    expect(events('project.workspace_ready')).toEqual([]);
  });

  it('nothing is created before the brief is approved', async () => {
    const projectId = chatProject();
    const folder = getProjectById(db, projectId)!.path;

    const result = await ensureProjectWorkspace({ db, activityLog }, projectId);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/brief/);
    expect(existsSync(folder)).toBe(false);
    expect(events('project.workspace_ready')).toEqual([]);
  });
});
