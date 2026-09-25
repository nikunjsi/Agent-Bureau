import type { ConversationListItem } from '../../../../shared/ipc/schemas/chat';

/**
 * §K.2, M11 S2-1c: the conversation switcher. **A list, not tabs** (Nikunj's
 * decision of 2026-09-25): the company conversation, then one entry per
 * project, each with the project's stage and a marker when the user is
 * being waited on or has unread messages there.
 *
 * Presentation only. Every marker is the Core's (`chat.listConversations`):
 * this component decides how "waiting" and "3 unread" look, never whether
 * they are true (invariant #11). With one conversation there is nothing to
 * switch between, so it renders nothing.
 */
export function ConversationSwitcher({
  items,
  activeId,
  onSelect,
}: {
  items: readonly ConversationListItem[];
  activeId: string | null;
  onSelect: (conversationId: string) => void;
}): React.JSX.Element | null {
  if (items.length < 2) return null;
  return (
    <nav
      aria-label="Conversations"
      className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-bureau-border bg-bureau-bg p-2"
    >
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect(item.id)}
                className={
                  'flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors ' +
                  (active
                    ? 'bg-bureau-bg-elevated text-bureau-text shadow-sm'
                    : 'text-bureau-text-muted hover:bg-bureau-bg-elevated hover:text-bureau-text')
                }
              >
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {entryName(item)}
                  </span>
                  <Marker item={item} />
                </span>
                <span className="text-xs text-bureau-text-muted">{entryCaption(item)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** What the entry is called: its project, or the company conversation. */
export function entryName(item: ConversationListItem): string {
  return item.project === null ? 'Company' : item.project.name;
}

const STAGE_WORDS: Readonly<Record<NonNullable<ConversationListItem['project']>['stage'], string>> =
  {
    intake: 'Understanding the request',
    brief: 'Brief',
    planning: 'Planning',
    executing: 'In progress',
    review: 'In review',
    delivered: 'Delivered',
    paused: 'Paused',
    abandoned: 'Stopped',
  };

/** The line under the name: the project's stage, in plain words. */
export function entryCaption(item: ConversationListItem): string {
  return item.project === null
    ? 'Anything not about one project'
    : `${item.project.displayKey} · ${STAGE_WORDS[item.project.stage]}`;
}

/** Waiting on the user outranks unread: it is the one that needs them. */
function Marker({ item }: { item: ConversationListItem }): React.JSX.Element | null {
  if (item.waiting) {
    return (
      <span className="shrink-0 rounded-full bg-bureau-warn/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bureau-warn">
        Waiting on you
      </span>
    );
  }
  if (item.unreadCount > 0) {
    return (
      <span
        className="shrink-0 rounded-full bg-bureau-accent px-1.5 py-0.5 text-[10px] font-semibold text-bureau-accent-text"
        aria-label={`${item.unreadCount} unread`}
      >
        {item.unreadCount}
      </span>
    );
  }
  return null;
}

/**
 * Which conversation to show. The one the user picked, while it exists;
 * otherwise the one where something was said most recently (so creating a
 * project, which adds an empty company conversation, does not move the user
 * away from the conversation they were having); otherwise the company one.
 */
export function chooseConversation(
  items: readonly ConversationListItem[],
  selectedId: string | null,
): ConversationListItem | null {
  if (selectedId !== null) {
    const picked = items.find((item) => item.id === selectedId);
    if (picked !== undefined) return picked;
  }
  let latest: ConversationListItem | null = null;
  for (const item of items) {
    if (item.lastMessageAt === null) continue;
    if (latest === null || item.lastMessageAt > (latest.lastMessageAt ?? '')) latest = item;
  }
  return latest ?? items.find((item) => item.project === null) ?? items[0] ?? null;
}
