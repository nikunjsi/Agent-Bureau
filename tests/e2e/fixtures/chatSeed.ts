import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { insertCompany } from '../../../src/main/db/repositories/companies';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { appendChatMessage } from '../../../src/main/chat/appendMessage';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * Seeds a real Bureau database for the e2e chat specs — with the
 * **production writer**, not hand-built rows.
 *
 * This is the honest answer to "demonstrate the renderers against real
 * data from the real Core" while the Director (which will be what calls
 * `appendChatMessage` in the shipped app) is still M11. Every row below is
 * inserted by the same function M11 will call, validated by the same
 * payload schemas the cards parse, through the same repository — so what
 * the app reads back is a real row, and what the test asserts is the real
 * rendering of it. What is missing is only the *producer*, and no fixture
 * can invent that without inventing the Director.
 *
 * It deliberately does NOT reach into the app's IPC or renderer: the app
 * boots on this directory exactly as it would on a user's, runs its own
 * real `reconcile()`, and serves the rows through the real
 * `chat.listMessages`.
 */
export async function seedChat(userDataDir: string): Promise<{ conversationId: string }> {
  const paths = getDbPaths(userDataDir, REAL_MIGRATIONS_DIR);
  const db = openConnection(paths.dbPath);
  await runMigrations({
    db,
    dbPath: paths.dbPath,
    migrationsDir: REAL_MIGRATIONS_DIR,
    backupsDir: paths.backupsDir,
  });
  const activityLog = ActivityLog.open(paths.activityLogPath, db);
  const result = seedInto(db, activityLog, userDataDir);
  activityLog.close();
  db.close();
  return result;
}

function seedInto(
  db: ReturnType<typeof openConnection>,
  activityLog: ActivityLog,
  homePath: string,
): { conversationId: string } {
  const company = insertCompany(db, { name: 'Bureau Test Co', home_path: homePath });
  const conversation = insertConversation(db, {
    company_id: company.id,
    project_id: null,
    title: 'Director',
    director_session_id: null,
    summary: null,
    director_state: null,
    director_state_data: null,
    status: 'active',
  });
  const deps = { db, activityLog };
  const base = { conversationId: conversation.id };

  appendChatMessage(deps, {
    ...base,
    author: 'user',
    kind: 'text',
    body: 'I want a **small site** that lists my `recipes`.',
  });

  appendChatMessage(deps, {
    ...base,
    author: 'director',
    kind: 'question',
    body: 'Who is this for?',
    payload: {
      options: [
        { id: 'just-me', label: 'Just me' },
        { id: 'public', label: 'Anyone on the web' },
      ],
    },
  });

  appendChatMessage(deps, {
    ...base,
    author: 'director',
    kind: 'brief',
    body: '',
    payload: {
      title: 'Recipe site',
      goal: 'A page listing recipes, readable on a phone.',
      scope: ['A list page', 'A page per recipe'],
      outOfScope: ['Accounts and sign-in'],
      deliverables: ['A static site you can host anywhere'],
      assumptions: ['Recipes are written by you, not submitted by visitors'],
    },
  });

  appendChatMessage(deps, {
    ...base,
    author: 'director',
    kind: 'plan',
    body: '',
    payload: {
      phases: [
        {
          name: 'Build the pages',
          goal: 'The list and the detail page',
          tasks: [
            { title: 'Set up the project', assignee: 'Ravi' },
            { title: 'Build the list page', assignee: 'Ravi' },
          ],
        },
      ],
      estimatedCostMicros: 2_140_000,
      hiresNeeded: [],
    },
  });

  appendChatMessage(deps, {
    ...base,
    author: 'director',
    kind: 'report',
    body: '',
    payload: {
      whatHappened: 'The list page is up and shows every recipe.',
      whatChanged: ['index.html', 'styles.css'],
      whatIsNext: 'The detail page.',
      // §11.5.1: null, not 0 — this engine does not report usage, and the
      // rendering of that fact is what this fixture exists to pin.
      costMicros: null,
    },
  });

  appendChatMessage(deps, {
    ...base,
    author: 'director',
    kind: 'summary',
    body: 'Phase one is done.',
    payload: { phaseName: 'Build the pages', deliverable: null },
  });

  appendChatMessage(deps, {
    ...base,
    author: 'system',
    kind: 'error',
    body: '',
    payload: {
      code: 'engine_unreachable',
      explanation:
        'Ravi could not start work because the Claude Code engine is not signed in on this machine.',
      remedy: { kind: 'reconnect_engine', targetId: null },
      // The raw text a naive implementation would have shown instead of
      // the sentence above. Its presence is the point: the card must not
      // lead with it.
      technical:
        'Error: spawn claude ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)',
    },
  });

  // The checkpoint card renders from the checkpoints slice, not the
  // message payload — so this seeds a REAL pending checkpoint and points a
  // message at it, which is exactly the shape §9.4 describes.
  const checkpoint = insertCheckpoint(db, activityLog, {
    type: 'decision',
    urgency: 'soon',
    title: 'Where should the recipes live?',
    context:
      'The site needs somewhere to keep the recipe text. This decides how easy it is to change them later.',
    options: [
      {
        id: 'files',
        label: 'Plain files in the project',
        detail: 'Nothing to run, and you edit them like any document.',
        consequence: 'Editing a recipe means editing a file and republishing the site.',
        recommended: true,
      },
      {
        id: 'database',
        label: 'A small database',
        consequence:
          'Recipes can be edited in a form later, but there is a server to run and pay for.',
      },
    ],
    default_action: 'files',
  });
  appendChatMessage(deps, {
    ...base,
    author: 'director',
    kind: 'checkpoint',
    body: 'A decision is waiting for you.',
    checkpointId: checkpoint.id,
  });

  return { conversationId: conversation.id };
}
