import { useEffect, useState } from 'react';
import type { Checkpoint, CheckpointOption } from '../../../../shared/models/checkpoint';
import type { ConversationMessage } from '../../../../shared/models/conversationMessage';
import {
  parseChatPayload,
  type BriefPayloadSchema,
  type ErrorPayloadSchema,
  type PlanPayloadSchema,
  type QuestionPayloadSchema,
  type QuestionBatchPayloadSchema,
  type ReportPayloadSchema,
  type SummaryPayloadSchema,
  type TextPayloadSchema,
} from '../../../../shared/models/chatPayloads';
import type { Brief } from '../../../../shared/models/brief';
import type { Plan } from '../../../../shared/models/plan';
import type { z } from 'zod';
import { Markdown } from './Markdown';
import { formatCost, formatTimeRemaining } from './format';
import { ErrorNotice, type NoticeError } from '../ErrorNotice';

/**
 * §14.2's eight `kind` renderings, "most of the UI work".
 *
 * Everything in this file is **pure presentation**: it reads facts off a
 * message's payload (or, for `checkpoint`, off the live checkpoints slice)
 * and decides how they look. Deleting this file would not require a single
 * change in `src/main` — which is the property that matters, because this
 * view is expected to be reviewed as a user and rebuilt.
 */

export function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-label={label}
      className="rounded-md border border-bureau-border bg-bureau-bg-elevated p-3"
    >
      {children}
    </section>
  );
}

function CardTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className="mb-1 text-sm font-semibold text-bureau-text">{children}</h3>;
}

function FieldList({ label, items }: { label: string; items: string[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-medium uppercase tracking-wide text-bureau-text-muted">{label}</p>
      <ul className="mt-0.5 list-disc pl-5 text-sm">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** A payload that will not parse is a row this view cannot render. It says
 * so, in place, rather than crashing the whole conversation around it —
 * §14.6's rule applied to the renderer's own failure. */
function UnrenderableCard({ kind }: { kind: string }): React.JSX.Element {
  return (
    <Card label={`Unreadable ${kind} card`}>
      <p className="text-sm text-bureau-text-muted">
        This {kind} could not be displayed — its contents were not in the expected form. Nothing has
        been lost; the conversation continues below.
      </p>
    </Card>
  );
}

/**
 * `text`, plus the two facts its payload can carry (see chatPayloads.ts):
 * attached paths, and — for a message the router delivered from an
 * employee — who sent it.
 *
 * Both are rendered here rather than being written into `body` by the
 * Core, which is the point: how an attachment or a sender reads is this
 * file's decision, and a rebuilt view is free to decide differently.
 */
export function TextBubble({ message }: { message: ConversationMessage }): React.JSX.Element {
  const parsed = parseChatPayload('text', message.payload);
  const payload = parsed.success ? (parsed.data as z.infer<typeof TextPayloadSchema>) : null;
  return (
    <div>
      {payload?.delivered != null && (
        <p className="mb-1 flex flex-wrap items-baseline gap-1.5 text-xs text-bureau-text-muted">
          <span aria-hidden="true">✉</span>
          <span>
            From <span className="text-bureau-text">{payload.delivered.fromAddr}</span>
          </span>
          {payload.delivered.subject !== '' && <span>· {payload.delivered.subject}</span>}
        </p>
      )}
      <Markdown source={message.body} />
      {payload != null && payload.attachments.length > 0 && (
        <ul aria-label="Attached files" className="mt-2 flex flex-wrap gap-1.5">
          {payload.attachments.map((path) => (
            <li
              key={path}
              className="flex items-center gap-1.5 rounded border border-bureau-border bg-bureau-bg-elevated px-2 py-0.5 text-xs"
            >
              <span aria-hidden="true">📎</span>
              <button
                type="button"
                onClick={() => void window.bureau.system.openPath({ path })}
                title={path}
                className="max-w-xs truncate underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QuestionBubble({
  message,
  onAnswer,
}: {
  message: ConversationMessage;
  /** Sends the chosen option's label as an ordinary message. */
  onAnswer: (text: string) => void;
}): React.JSX.Element {
  const parsed = parseChatPayload('question', message.payload);
  if (!parsed.success) return <UnrenderableCard kind="question" />;
  const payload = parsed.data as z.infer<typeof QuestionPayloadSchema>;
  if ('questions' in payload) {
    return <QuestionBatch body={message.body} questions={payload.questions} onAnswer={onAnswer} />;
  }
  return (
    <div>
      <Markdown source={message.body} />
      {/* §14.2: "chips are keyboard-navigable". Real buttons in DOM order,
          so Tab reaches every one of them and Enter/Space activates —
          rather than clickable divs with a keydown handler bolted on.
          Live as of session 2: a chip sends its own label through
          `chat.send`, which is what answering a question IS. There is no
          separate "answer" method, and inventing one would put a second
          door onto the conversation. The free-text box §14.2 requires
          alongside them is the composer itself. */}
      <ul className="mt-2 flex flex-wrap gap-2" aria-label="Suggested answers">
        {payload.options.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              onClick={() => onAnswer(option.label)}
              className="rounded-full border border-bureau-border px-3 py-1 text-sm hover:bg-bureau-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
            >
              {option.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * M11 S2-2a, decision E-6: intake's batch of 2–4 questions in one card —
 * each with its chips, the recommended one marked and its reason shown,
 * and one "You decide" for the whole batch (§8.1: the Director then
 * decides, states the consequence, and moves on). A chip is still an
 * ordinary message through `chat.send`, as M9's are; it names the question
 * it answers, because a batch has more than one.
 */
function QuestionBatch({
  body,
  questions,
  onAnswer,
}: {
  body: string;
  questions: ReadonlyArray<z.infer<typeof QuestionBatchPayloadSchema>['questions'][number]>;
  onAnswer: (text: string) => void;
}): React.JSX.Element {
  return (
    <div>
      <Markdown source={body} />
      <ol className="mt-2 flex flex-col gap-3" aria-label="Questions">
        {questions.map((question) => (
          <li key={question.id}>
            <p className="text-sm font-medium text-bureau-text">{question.text}</p>
            <ul className="mt-1.5 flex flex-wrap gap-2" aria-label={`Answers to: ${question.text}`}>
              {question.options.map((option) => {
                const recommended = option.id === question.recommendation.optionId;
                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      onClick={() => onAnswer(`${question.text} ${option.label}`)}
                      className={
                        'rounded-full border px-3 py-1 text-sm hover:bg-bureau-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent ' +
                        (recommended ? 'border-bureau-accent' : 'border-bureau-border')
                      }
                    >
                      {option.label}
                      {recommended && (
                        <span className="ml-1.5 text-xs text-bureau-text-muted">Recommended</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 text-xs text-bureau-text-muted">{question.recommendation.why}</p>
          </li>
        ))}
      </ol>
      <div className="mt-3">
        <button
          type="button"
          onClick={() => onAnswer('You decide.')}
          className="rounded-full border border-bureau-border px-3 py-1 text-sm text-bureau-text-muted hover:bg-bureau-bg-inset hover:text-bureau-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        >
          You decide
        </button>
      </div>
    </div>
  );
}

/**
 * §14.2's `Approve` / `Edit` / `Discuss`, shared by the brief and plan
 * cards along with the rule that makes them honest.
 *
 * **State comes from the live row, content from the payload.** The card's
 * body is what the Director said when it posted the message; whether that
 * version is still the current one, already approved, or superseded by an
 * edit is a fact only the `briefs`/`plans` row knows, and it changes after
 * the message is written. This is the same discipline the checkpoint card
 * uses — render from the live state, never from a snapshot in the payload
 * — and it is what stops an Approve button offering to approve a version
 * the user has already replaced.
 */
function DocumentActions({
  status,
  isCurrentVersion,
  approving,
  error,
  onApprove,
  onEdit,
  onDiscuss,
  editLabel,
}: {
  status: Brief['status'] | null;
  isCurrentVersion: boolean;
  approving: boolean;
  error: NoticeError | null;
  onApprove: () => void;
  onEdit: () => void;
  onDiscuss: () => void;
  editLabel: string;
}): React.JSX.Element {
  const settled =
    status === 'approved'
      ? // Icon plus words: the state must survive a monochrome screen
        // (§14.7).
        { icon: '✓', text: 'Approved.' }
      : status === 'superseded' || !isCurrentVersion
        ? { icon: '⟳', text: 'Replaced by a newer version, further down.' }
        : null;

  return (
    <div className="mt-3">
      {settled !== null ? (
        <p className="flex items-center gap-1.5 text-sm text-bureau-text-muted">
          <span aria-hidden="true">{settled.icon}</span>
          {settled.text}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={approving}
            onClick={onApprove}
            className="rounded bg-bureau-accent px-3 py-1 text-sm text-bureau-accent-text disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded border border-bureau-border px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            {editLabel}
          </button>
          <button
            type="button"
            onClick={onDiscuss}
            className="rounded border border-bureau-border px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            Discuss
          </button>
        </div>
      )}
      {error !== null && <ErrorNotice error={error} className="mt-2" />}
    </div>
  );
}

/**
 * The live `briefs`/`plans` row for a message's project, re-read whenever
 * the card has reason to think it changed. `null` while loading and when
 * the project has no such row (which is the ordinary case for a card
 * posted before anything was persisted).
 *
 * `refresh` is what an Approve or a save calls: the Core is the authority
 * on the new status, and asking it beats assuming the write did what was
 * asked (invariant #11 — no optimistic state).
 */
function useLiveDocument<T extends Brief | Plan>(
  projectId: string | null,
  fetch: (projectId: string) => Promise<{ ok: true; data: { item: T | null } } | { ok: false }>,
): { doc: T | null; loading: boolean; refresh: () => void } {
  const [doc, setDoc] = useState<T | null>(null);
  const [loading, setLoading] = useState(projectId !== null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (projectId === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetch(projectId).then((result) => {
      if (cancelled) return;
      setDoc(result.ok ? result.data.item : null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // `fetch` is a stable module-level call in both call sites.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, epoch]);

  return { doc, loading, refresh: () => setEpoch((n) => n + 1) };
}

export interface DocumentCardProps {
  message: ConversationMessage;
  /** Opens the composer with this text. `Discuss` and a plan's `Edit`
   * both go here — §8.2's "Discuss (goes back to conversation)". */
  onDiscuss: (draft: string) => void;
  /** Opens the markdown editor. Briefs only: `plans` has no markdown
   * column and §17.1 has no `plan.saveEdit`. */
  onEditBrief: (brief: Brief) => void;
}

export function BriefCard({
  message,
  onDiscuss,
  onEditBrief,
}: DocumentCardProps): React.JSX.Element {
  const parsed = parseChatPayload('brief', message.payload);
  const { doc, refresh } = useLiveDocument<Brief>(message.project_id, (projectId) =>
    window.bureau.brief.get({ projectId }),
  );
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<NoticeError | null>(null);

  if (!parsed.success) return <UnrenderableCard kind="brief" />;
  const brief = parsed.data as z.infer<typeof BriefPayloadSchema>;

  // `brief.get` returns the HIGHEST version for the project. A card whose
  // payload names a different id is looking at an older one.
  const isCurrentVersion = doc === null || brief.briefId === null || doc.id === brief.briefId;
  const targetId = brief.briefId ?? doc?.id ?? null;

  const approve = async (): Promise<void> => {
    if (targetId === null) return;
    setApproving(true);
    setError(null);
    const result = await window.bureau.brief.approve({ id: targetId });
    setApproving(false);
    if (!result.ok) setError(result.error);
    // Either way: re-read. A refusal is usually "there is a newer
    // version", which the card should then show.
    refresh();
  };

  return (
    <Card label={`Brief: ${brief.title}`}>
      <CardTitle>{brief.title}</CardTitle>
      <p className="text-sm">{brief.goal}</p>
      <FieldList label="Scope" items={brief.scope} />
      <FieldList label="Not in scope" items={brief.outOfScope} />
      <FieldList label="Deliverables" items={brief.deliverables} />
      {brief.assumptions.length > 0 && (
        <div className="mt-2 rounded border border-bureau-warn/40 bg-bureau-warn/10 p-2">
          {/* §14.2: "assumptions highlighted". The Core says which
              statements are assumptions; the amber is this view's idea.
              Never colour alone (§14.7) — the label carries the meaning. */}
          <p className="text-xs font-medium uppercase tracking-wide text-bureau-warn">
            Assumptions — correct these if any are wrong
          </p>
          <ul className="mt-0.5 list-disc pl-5 text-sm">
            {brief.assumptions.map((assumption, index) => (
              <li key={index}>{assumption}</li>
            ))}
          </ul>
        </div>
      )}
      <DocumentActions
        status={doc?.status ?? null}
        isCurrentVersion={isCurrentVersion}
        approving={approving || targetId === null}
        error={error}
        onApprove={() => void approve()}
        editLabel="Edit"
        onEdit={() => {
          if (doc !== null) onEditBrief(doc);
        }}
        onDiscuss={() =>
          // §8.2: Discuss "goes back to conversation". The card's identity
          // rides in the message text as a quote, because that is what a
          // person writing about a document does — and because the
          // Director reads `body`.
          onDiscuss(`> About the brief “${brief.title}”\n\n`)
        }
      />
    </Card>
  );
}

export function PlanCard({ message, onDiscuss }: DocumentCardProps): React.JSX.Element {
  const parsed = parseChatPayload('plan', message.payload);
  const { doc, refresh } = useLiveDocument<Plan>(message.project_id, (projectId) =>
    window.bureau.plan.get({ projectId }),
  );
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<NoticeError | null>(null);

  if (!parsed.success) return <UnrenderableCard kind="plan" />;
  const plan = parsed.data as z.infer<typeof PlanPayloadSchema>;
  const taskCount = plan.phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  const isCurrentVersion = doc === null || plan.planId === null || doc.id === plan.planId;
  const targetId = plan.planId ?? doc?.id ?? null;

  const approve = async (): Promise<void> => {
    if (targetId === null) return;
    setApproving(true);
    setError(null);
    const result = await window.bureau.plan.approve({ id: targetId });
    setApproving(false);
    if (!result.ok) setError(result.error);
    refresh();
  };
  return (
    <Card label="Plan">
      <CardTitle>
        Plan — {plan.phases.length} phase{plan.phases.length === 1 ? '' : 's'}, {taskCount} task
        {taskCount === 1 ? '' : 's'}
      </CardTitle>
      {/* Collapsible per §14.2, via <details> — a native disclosure that is
          keyboard-operable and screen-reader-announced without any state of
          our own. Which phases are open is a rendering choice; the payload
          has no opinion about it. */}
      <ul>
        {plan.phases.map((phase, index) => (
          <li key={index}>
            <details className="border-t border-bureau-border py-1 first:border-t-0">
              <summary className="cursor-pointer text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent">
                {phase.name} — {phase.tasks.length} task{phase.tasks.length === 1 ? '' : 's'}
              </summary>
              {phase.goal !== '' && (
                <p className="mt-1 text-sm text-bureau-text-muted">{phase.goal}</p>
              )}
              <ul className="mt-1 list-disc pl-5 text-sm">
                {phase.tasks.map((task, taskIndex) => (
                  <li key={taskIndex}>
                    {task.title}
                    {task.assignee !== null && (
                      <span className="text-bureau-text-muted"> — {task.assignee}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="inline text-bureau-text-muted">Estimated cost: </dt>
          <dd className="inline">{formatCost(plan.estimatedCostMicros)}</dd>
        </div>
        {plan.hiresNeeded.length > 0 && (
          <div>
            <dt className="inline text-bureau-text-muted">Hires needed: </dt>
            <dd className="inline">{plan.hiresNeeded.join(', ')}</dd>
          </div>
        )}
      </dl>
      <DocumentActions
        status={doc?.status ?? null}
        isCurrentVersion={isCurrentVersion}
        approving={approving || targetId === null}
        error={error}
        onApprove={() => void approve()}
        // Not a text editor. A plan is phases, tasks and dependencies —
        // `plans` has no `markdown` column and §17.1 has no
        // `plan.saveEdit` — so "Edit" for a plan means telling the
        // Director what to change, which is a message.
        editLabel="Ask for changes"
        onEdit={() => onDiscuss('> Changes I want to the plan:\n\n')}
        onDiscuss={() => onDiscuss('> About the plan\n\n')}
      />
    </Card>
  );
}

export function ReportCard({ message }: { message: ConversationMessage }): React.JSX.Element {
  const parsed = parseChatPayload('report', message.payload);
  if (!parsed.success) return <UnrenderableCard kind="report" />;
  const report = parsed.data as z.infer<typeof ReportPayloadSchema>;
  return (
    <Card label="Report">
      <CardTitle>What happened</CardTitle>
      <p className="text-sm">{report.whatHappened}</p>
      <FieldList label="What changed" items={report.whatChanged} />
      {report.whatIsNext !== '' && (
        <div className="mt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-bureau-text-muted">
            What is next
          </p>
          <p className="text-sm">{report.whatIsNext}</p>
        </div>
      )}
      <p className="mt-2 text-sm">
        <span className="text-bureau-text-muted">Cost so far: </span>
        {/* §11.5.1: `null` renders the sentence, never $0.00. */}
        {formatCost(report.costMicros)}
      </p>
    </Card>
  );
}

export function SummaryCard({ message }: { message: ConversationMessage }): React.JSX.Element {
  const parsed = parseChatPayload('summary', message.payload);
  if (!parsed.success) return <UnrenderableCard kind="summary" />;
  const summary = parsed.data as z.infer<typeof SummaryPayloadSchema>;
  return (
    <Card label={`Phase complete: ${summary.phaseName}`}>
      <CardTitle>{summary.phaseName} — complete</CardTitle>
      {message.body !== '' && <Markdown source={message.body} />}
      {summary.deliverable !== null && (
        <button
          type="button"
          onClick={() => {
            void window.bureau.system.openPath({ path: summary.deliverable!.path });
          }}
          className="mt-2 rounded border border-bureau-border px-2 py-1 text-sm hover:bg-bureau-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        >
          Open {summary.deliverable.title}
        </button>
      )}
    </Card>
  );
}

/**
 * §14.6, and CLAUDE.md's *"do not show raw engine output to the user by
 * default. Translate."*
 *
 * The plain-language explanation is what is shown. The raw text is kept
 * behind a disclosure, because a user who wants it should not have to open
 * a log file — but it is never the default rendering and never the whole
 * bubble. The action button comes from the Core's `remedy`, which names
 * what needs to happen in the domain; where that leads is decided here.
 */
export function ErrorBubble({
  message,
  onRemedy,
}: {
  message: ConversationMessage;
  onRemedy: (remedy: z.infer<typeof ErrorPayloadSchema>['remedy']) => void;
}): React.JSX.Element {
  const parsed = parseChatPayload('error', message.payload);
  if (!parsed.success) return <UnrenderableCard kind="error" />;
  const error = parsed.data as z.infer<typeof ErrorPayloadSchema>;
  return (
    <section
      aria-label="Error"
      className="rounded-md border border-bureau-error/50 bg-bureau-error/10 p-3"
    >
      {/* Icon + label, never colour alone (§14.7). */}
      <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-bureau-error">
        <span aria-hidden="true">⚠</span> Something went wrong
      </p>
      <p className="text-sm">{error.explanation}</p>
      {error.remedy !== null && (
        <button
          type="button"
          onClick={() => onRemedy(error.remedy)}
          className="mt-2 rounded bg-bureau-accent px-3 py-1 text-sm text-bureau-accent-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        >
          {remedyLabel(error.remedy.kind)}
        </button>
      )}
      {error.technical !== null && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-bureau-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent">
            Show technical detail
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-bureau-bg-inset p-2 text-xs">
            {error.technical}
          </pre>
        </details>
      )}
    </section>
  );
}

/** The Core says what needs to happen; the words are this view's. */
function remedyLabel(kind: NonNullable<z.infer<typeof ErrorPayloadSchema>['remedy']>['kind']) {
  switch (kind) {
    case 'answer_checkpoint':
      return 'Go to the decision';
    case 'reconnect_engine':
      return 'Open engine settings';
    case 'raise_budget':
      return 'Open budget settings';
    case 'open_path':
      return 'Open the folder';
    default:
      return 'Try again';
  }
}

export interface CheckpointCardProps {
  checkpoint: Checkpoint;
  /** `null` while nothing is in flight; the option id being submitted
   * otherwise. Owned by the view above so two cards cannot both submit. */
  submitting: boolean;
  error: NoticeError | null;
  onAnswer: (input: { optionId?: string; freeText?: string }) => void;
  onAnswerPermission: (allow: boolean) => void;
}

/**
 * §9.2's anatomy, rendered. This is §9.4's **surface 1**.
 *
 * Every rule §9.2 makes about what a checkpoint MUST contain is a rendering
 * requirement here, not just a validation one:
 *
 *  - **Every option states its consequence** (invariant #8). The
 *    consequence is not a tooltip or a detail view — it is on the option,
 *    always, because an option chosen without its consequence read is the
 *    thing the rule exists to prevent.
 *  - **At most one recommendation, with its reason shown.** The badge is
 *    meaningless without the `detail` that explains it.
 *  - **Free text is always accepted alongside the options**, because users
 *    often have a third answer.
 *  - **The timer says what happens when it runs out** — naming the default
 *    action, so an unanswered checkpoint is never a surprise (§9.5,
 *    invariant #7).
 *
 * The checkpoint comes from the store's `checkpoints` slice — the same rows
 * `checkpoints.listPending` returns, through the same function. Nothing
 * here re-derives "is this still pending".
 */
export function CheckpointCard({
  checkpoint,
  submitting,
  error,
  onAnswer,
  onAnswerPermission,
}: CheckpointCardProps): React.JSX.Element {
  const [freeText, setFreeText] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (checkpoint.expires_at === null) return;
    // A clock, not a poll: it re-reads the local time to re-render a
    // countdown. No state is fetched, and the deadline it counts to came
    // from the Core.
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [checkpoint.expires_at]);

  const options: CheckpointOption[] = checkpoint.options ?? [];
  const remaining = formatTimeRemaining(checkpoint.expires_at, nowMs);
  const defaultOption = options.find((option) => option.id === checkpoint.default_action) ?? null;
  const isPermission = checkpoint.type === 'permission';

  return (
    <Card label={`Decision: ${checkpoint.title}`}>
      <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs uppercase tracking-wide text-bureau-text-muted">
        <span aria-hidden="true">◆</span>
        <span>
          {checkpoint.type} · {checkpoint.urgency}
        </span>
      </p>
      <CardTitle>{checkpoint.title}</CardTitle>
      <p className="text-sm">{checkpoint.context}</p>

      {isPermission && checkpoint.args_preview !== null && (
        <pre className="mt-2 overflow-x-auto rounded bg-bureau-bg-inset p-2 text-xs">
          {checkpoint.args_preview}
        </pre>
      )}
      {!isPermission && checkpoint.preview !== null && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-bureau-bg-inset p-2 text-xs">
          {typeof checkpoint.preview === 'string'
            ? checkpoint.preview
            : JSON.stringify(checkpoint.preview, null, 2)}
        </pre>
      )}

      {isPermission ? (
        // §9.1's compact render. Two options, not three: "allow this
        // command for this employee" needs a store for user-granted rules
        // that does not exist (docs/NEXT-VERSION.md §I.1), and inventing
        // one in the UI would put a policy decision outside the policy
        // layer.
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => onAnswerPermission(true)}
            className="rounded bg-bureau-accent px-3 py-1 text-sm text-bureau-accent-text disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            Allow once
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onAnswerPermission(false)}
            className="rounded border border-bureau-border px-3 py-1 text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            Deny
          </button>
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2" aria-label="Options">
          {options.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                disabled={submitting}
                onClick={() =>
                  // The free-text box is sent WITH the option, not instead
                  // of it (§9.2: free text is always accepted alongside the
                  // options) — a user who picks B and explains why should
                  // not lose the explanation.
                  onAnswer(
                    freeText === '' ? { optionId: option.id } : { optionId: option.id, freeText },
                  )
                }
                className="w-full rounded border border-bureau-border p-2 text-left hover:bg-bureau-bg-inset disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {option.label}
                  {option.recommended === true && (
                    <span className="rounded-full border border-bureau-success px-1.5 py-0.5 text-[0.7rem] uppercase text-bureau-success">
                      Recommended
                    </span>
                  )}
                </span>
                {option.detail !== undefined && (
                  <span className="mt-0.5 block text-xs text-bureau-text-muted">
                    {option.detail}
                  </span>
                )}
                {/* Invariant #8. Never hidden, never truncated. */}
                <span className="mt-1 block text-xs">
                  <span className="text-bureau-text-muted">If you choose this: </span>
                  {option.consequence}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!isPermission && (
        <div className="mt-3">
          <label htmlFor={`freetext-${checkpoint.id}`} className="text-xs text-bureau-text-muted">
            {/* §9.2: "Free text is always accepted alongside the options —
                users often have a third answer." */}
            Something else? Say so here — it is sent with whichever option you pick, or on its own.
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id={`freetext-${checkpoint.id}`}
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              className="min-w-0 flex-1 rounded border border-bureau-border bg-bureau-bg px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
            />
            <button
              type="button"
              disabled={submitting || freeText.trim() === ''}
              onClick={() => onAnswer({ freeText })}
              className="rounded border border-bureau-border px-3 py-1 text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
            >
              Send
            </button>
          </div>
        </div>
      )}

      <p className="mt-2 text-xs text-bureau-text-muted">
        {remaining === null
          ? 'This waits for you — it has no deadline.'
          : defaultOption === null
            ? `${remaining}.`
            : `${remaining}. If you do not answer, Bureau will choose “${defaultOption.label}” — ${defaultOption.consequence}`}
      </p>

      {error !== null && <ErrorNotice error={error} className="mt-2" />}
    </Card>
  );
}

/**
 * A `checkpoint` message whose checkpoint is no longer pending. Not an
 * error: it was answered, or it expired and resolved to its default. The
 * message stays in the transcript because the conversation happened.
 *
 * It says it has been handled **first**, and only then shows what the
 * message originally said. Leading with the original text — "a decision is
 * waiting for you" — would leave the transcript claiming something is
 * outstanding when it is not, which is the same class of lie as an
 * interrupted reply that reads as finished.
 */
export function AnsweredCheckpointNote({ body }: { body: string }): React.JSX.Element {
  return (
    <Card label="Decision, already handled">
      <p className="flex items-center gap-1.5 text-sm text-bureau-text-muted">
        <span aria-hidden="true">✓</span> This decision has already been handled.
      </p>
      {body !== '' && <p className="mt-1 text-xs text-bureau-text-muted">{body}</p>}
    </Card>
  );
}
