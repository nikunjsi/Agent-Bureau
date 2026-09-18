import {
  useBureauStore,
  PERMANENT_TABS,
  selectChatUnreadCount,
  type RightPanelTab,
} from '../store/bureauStore';
import { ChatView } from './chat/ChatView';
import { MemoryView } from './memory/MemoryView';
import { CheckpointsTab } from './checkpoints/CheckpointsTab';

const TAB_LABELS: Record<RightPanelTab, string> = {
  chat: 'Chat',
  board: 'Board',
  checkpoints: 'Checkpoints',
  inspector: 'Inspector',
  memory: 'Memory',
};

function EmptyState({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="font-medium text-bureau-text">{title}</p>
      <p className="max-w-sm text-sm text-bureau-text-muted">{body}</p>
    </div>
  );
}

function BoardTab(): React.JSX.Element {
  const tasks = useBureauStore((state) => state.tasks);
  if (tasks.length === 0) {
    return (
      <EmptyState
        title="No tasks yet"
        body="Tasks appear here once a project has an approved plan."
      />
    );
  }
  return (
    <ul aria-label="Tasks" className="flex flex-col gap-1 p-2">
      {tasks.map((task) => (
        <li key={task.id} className="rounded border border-bureau-border p-2 text-sm">
          <span className="font-mono text-xs text-bureau-text-muted">{task.display_key}</span>{' '}
          {task.title}
        </li>
      ))}
    </ul>
  );
}

function InspectorTab(): React.JSX.Element {
  const employees = useBureauStore((state) => state.employees);
  if (employees.length === 0) {
    return (
      <EmptyState
        title="No one to inspect yet"
        body="Hire an employee to see their activity, terminal, and files here."
      />
    );
  }
  return (
    <div aria-label="Employee inspector">
      {/* per-employee detail arrives with M3's supervisor */}
    </div>
  );
}

export function RightPanel(): React.JSX.Element {
  const activeTab = useBureauStore((state) => state.activeTab);
  const setActiveTab = useBureauStore((state) => state.setActiveTab);
  // §9.4's surface 2 — "a badge on the Checkpoints view". The same
  // `checkpoints` slice the chat card reads, so the badge and the card
  // cannot disagree about how many are waiting.
  const pendingCheckpoints = useBureauStore((state) => state.checkpoints.length);
  /**
   * §28 M9 item 7's unread badge.
   *
   * `isUnreadForUser` is the **shared** predicate — the same one
   * `chat.markRead` uses to decide whether a row is the user's to mark
   * (standing rule 6). The fact is `read_at`, which only the Core writes;
   * this counts rows the Core already sent.
   *
   * **Paginated since pre-M11 P-4.** Loaded messages are counted with the
   * predicate; unread messages older than anything loaded are counted by the
   * Core in the same rule's SQL spelling. See `selectChatUnreadCount`.
   */
  const unreadMessages = useBureauStore(selectChatUnreadCount);

  const badgeFor = (tab: RightPanelTab): { count: number; label: string } | null => {
    if (tab === 'checkpoints' && pendingCheckpoints > 0) {
      return { count: pendingCheckpoints, label: `${pendingCheckpoints} waiting for you` };
    }
    if (tab === 'chat' && unreadMessages > 0) {
      return {
        count: unreadMessages,
        label: `${unreadMessages} unread message${unreadMessages === 1 ? '' : 's'}`,
      };
    }
    return null;
  };

  /**
   * §14.5's pattern, applied to Memory: the four permanent tabs, plus the
   * open one if it is not among them. So Memory appears in the bar exactly
   * while it is being used and leaves when another tab is chosen — it is
   * never a fifth thing to scan past on every launch.
   *
   * The opener is the title bar's brain button. §14.5 describes a second
   * one — the floor's wall clock (§13.6) — and that waits for M12 to draw a
   * clock; `setActiveTab('memory')` already works from anywhere, so it needs
   * no re-plumbing when it lands.
   */
  const visibleTabs: RightPanelTab[] = PERMANENT_TABS.includes(activeTab)
    ? [...PERMANENT_TABS]
    : [...PERMANENT_TABS, activeTab];

  return (
    <section aria-label="Main panel" className="flex min-w-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Views"
        className="flex border-b border-bureau-border bg-bureau-bg-elevated"
      >
        {visibleTabs.map((id) => {
          const badge = badgeFor(id);
          const tab = { id, label: TAB_LABELS[id] };
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent ${
                activeTab === tab.id
                  ? 'border-b-2 border-bureau-accent font-medium text-bureau-text'
                  : 'text-bureau-text-muted hover:text-bureau-text'
              }`}
            >
              {tab.label}
              {badge !== null && (
                <span
                  // The count is in the accessible name too, not conveyed
                  // by the pill alone (§14.7).
                  aria-label={badge.label}
                  className="ml-1.5 rounded-full bg-bureau-accent px-1.5 py-0.5 text-xs text-bureau-accent-text"
                >
                  {badge.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="flex-1 overflow-auto">
        {activeTab === 'chat' && <ChatView />}
        {activeTab === 'board' && <BoardTab />}
        {activeTab === 'checkpoints' && <CheckpointsTab />}
        {activeTab === 'inspector' && <InspectorTab />}
        {activeTab === 'memory' && <MemoryView />}
      </div>
    </section>
  );
}
