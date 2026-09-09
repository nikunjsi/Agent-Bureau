import { useEffect, useState } from 'react';
import type { Checkpoint, CheckpointOption } from '../../../../shared/models/checkpoint';
import type { ConversationMessage } from '../../../../shared/models/conversationMessage';
import {
  parseChatPayload,
  type BriefPayloadSchema,
  type ErrorPayloadSchema,
  type PlanPayloadSchema,
  type QuestionPayloadSchema,
  type ReportPayloadSchema,
  type SummaryPayloadSchema,
} from '../../../../shared/models/chatPayloads';
import type { z } from 'zod';
import { Markdown } from './Markdown';
import { formatCost, formatTimeRemaining } from './format';

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

export function TextBubble({ body }: { body: string }): React.JSX.Element {
  return <Markdown source={body} />;
}

export function QuestionBubble({ message }: { message: ConversationMessage }): React.JSX.Element {
  const parsed = parseChatPayload('question', message.payload);
  if (!parsed.success) return <UnrenderableCard kind="question" />;
  const payload = parsed.data as z.infer<typeof QuestionPayloadSchema>;
  return (
    <div>
      <Markdown source={message.body} />
      {/* §14.2: "chips are keyboard-navigable". Real buttons in DOM order,
          so Tab reaches every one of them and Enter/Space activates —
          rather than clickable divs with a keydown handler bolted on.
          Answering is M9 session 2 (it needs `chat.send`), so they are
          disabled and say why rather than looking live and doing nothing. */}
      <ul className="mt-2 flex flex-wrap gap-2" aria-label="Suggested answers">
        {payload.options.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              disabled
              title="Answering from chat arrives with the composer"
              className="rounded-full border border-bureau-border px-3 py-1 text-sm text-bureau-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent disabled:cursor-not-allowed"
            >
              {option.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BriefCard({ message }: { message: ConversationMessage }): React.JSX.Element {
  const parsed = parseChatPayload('brief', message.payload);
  if (!parsed.success) return <UnrenderableCard kind="brief" />;
  const brief = parsed.data as z.infer<typeof BriefPayloadSchema>;
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
      <p className="mt-2 text-xs text-bureau-text-muted">
        Approving, editing and discussing a brief arrive with the composer.
      </p>
    </Card>
  );
}

export function PlanCard({ message }: { message: ConversationMessage }): React.JSX.Element {
  const parsed = parseChatPayload('plan', message.payload);
  if (!parsed.success) return <UnrenderableCard kind="plan" />;
  const plan = parsed.data as z.infer<typeof PlanPayloadSchema>;
  const taskCount = plan.phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
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
      <p className="mt-2 text-xs text-bureau-text-muted">
        Approving, editing and discussing a plan arrive with the composer.
      </p>
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
  error: string | null;
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

      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-bureau-error">
          {error}
        </p>
      )}
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
