import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { insertCompany } from '../../../src/main/db/repositories/companies';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { appendChatMessage } from '../../../src/main/chat/appendMessage';
import { ChatStreamRegistry } from '../../../src/main/chat/chatStream';
import { seedEmployee, seedRole } from '../../helpers/dbFixtures';

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
export interface SeededChat {
  conversationId: string;
  /** An ordinary message written by `appendChatMessage`, i.e. `complete`. */
  completeMessageId: string;
  /** A real stream that was interrupted, left `aborted` by `ChatStream.abort`. */
  abortedMessageId: string;
}

export async function seedChat(userDataDir: string): Promise<SeededChat> {
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
): SeededChat {
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

  const firstMessageId = appendChatMessage(deps, {
    ...base,
    author: 'user',
    kind: 'text',
    body: 'I want a **small site** that lists my `recipes`.',
  }).id;

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
            { title: 'Set up the project', assignee: 'Quinn' },
            { title: 'Build the list page', assignee: 'Quinn' },
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
        'Quinn could not start work because the Claude Code engine is not signed in on this machine.',
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
        reversible: true,
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

  /**
   * A real interrupted reply, so §14.7's \"status never by colour alone\"
   * can be checked against a state that is not `complete`.
   *
   * Written through the production `ChatStream` — `begin()` inserts the row
   * as `streaming` before any text and `abort()` finalises it — so this is
   * the row a real interruption leaves behind. A hand-written
   * `status: 'aborted'` would be the shape `killPoints.test.ts` was
   * corrected away from in session 1.
   *
   * **A `streaming` row is deliberately NOT seeded here**, and the reason
   * is the product being right rather than a gap: §5.1 requires
   * `reconcile()` to mark any row still `streaming` from before the app
   * started as `aborted`, and it does — so a seeded one cannot survive the
   * app booting on it, and expecting it to would be asserting against a
   * rule this project wrote on purpose. The live-streaming case is
   * `chatAborted.spec.ts`, which produces one with a real separate process
   * against an already-running app.
   *
   * The `complete` one is the first message above — `appendChatMessage`
   * writes `status: 'complete'` — so the assertion covers an ordinary
   * message rather than a specially made one.
   */
  const streams = new ChatStreamRegistry(deps);
  const interrupted = streams.begin({ conversationId: conversation.id, author: 'director' });
  interrupted.append('I was part way through explaining the plan when');
  // `abort()` flushes and clears its own timer, so nothing is left pending.
  const abortedMessage = interrupted.abort('stopped_by_user');

  return {
    conversationId: conversation.id,
    completeMessageId: firstMessageId,
    abortedMessageId: abortedMessage!.id,
  };
}

/**
 * A stopped employee, so the Resume banner has something to render.
 *
 * `status: 'parked'` is exactly what `Supervisor.pause()` leaves behind, and
 * `resume_at` stays null exactly as a manual pause leaves it — the state
 * that, before M9 session 2, had no reachable undo anywhere in the product.
 * This is a seeded **input to a presentation check**: hiring and pausing
 * both have real production paths, proven in
 * `tests/integration/chat/slashCommandsLive.test.ts` against a live
 * Supervisor. What no integration test can see is whether the banner that
 * offers the way back actually appears on screen — which is the whole
 * failure this row exists to guard.
 */
export async function seedParkedEmployee(userDataDir: string): Promise<{ name: string }> {
  const paths = getDbPaths(userDataDir, REAL_MIGRATIONS_DIR);
  const db = openConnection(paths.dbPath);
  const activityLog = ActivityLog.open(paths.activityLogPath, db);
  try {
    const role = seedRole(db);
    const employee = seedEmployee(db, {
      name: 'Quinn',
      role_key: role.full_key,
      status: 'parked',
    });
    return { name: employee.name };
  } finally {
    activityLog.close();
    db.close();
  }
}

/**
 * P-4 / chaos #12: one conversation holding `count` ordinary text messages,
 * written by the production repository in a single transaction so seeding
 * time is not what the spec measures. Returns the conversation id and the
 * body of the newest message, which is what a user opening the window sees.
 */
export async function seedLongChat(
  userDataDir: string,
  count: number,
): Promise<{ conversationId: string; newestBody: string; oldestBody: string }> {
  const { insertConversationMessage } =
    await import('../../../src/main/db/repositories/conversationMessages');
  const paths = getDbPaths(userDataDir, REAL_MIGRATIONS_DIR);
  const db = openConnection(paths.dbPath);
  await runMigrations({
    db,
    dbPath: paths.dbPath,
    migrationsDir: REAL_MIGRATIONS_DIR,
    backupsDir: paths.backupsDir,
  });
  const company = insertCompany(db, { name: 'Bureau Test Co', home_path: userDataDir });
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
  const bodyFor = (i: number): string =>
    `Message ${i}. The report page now **loads in under a second**, and the export writes a \`csv\` with every column the brief asked for.`;
  const base = Date.parse('2026-09-01T00:00:00.000Z');
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const row = insertConversationMessage(db, {
        conversation_id: conversation.id,
        project_id: null,
        author: i % 2 === 0 ? 'user' : 'director',
        kind: 'text',
        body: bodyFor(i),
        payload: null,
        checkpoint_id: null,
        status: 'complete',
      });
      // Distinct, ordered timestamps: a bulk insert inside one millisecond
      // would otherwise leave the order to chance.
      db.prepare('UPDATE conversation_messages SET created_at = ? WHERE id = ?').run(
        new Date(base + i * 1000).toISOString(),
        row.id,
      );
    }
  })();
  db.close();
  return {
    conversationId: conversation.id,
    newestBody: bodyFor(count - 1),
    oldestBody: bodyFor(0),
  };
}
