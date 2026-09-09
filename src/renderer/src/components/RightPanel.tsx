import { useBureauStore, type RightPanelTab } from '../store/bureauStore';
import { ChatView } from './chat/ChatView';

const TABS: { id: RightPanelTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'board', label: 'Board' },
  { id: 'checkpoints', label: 'Checkpoints' },
  { id: 'inspector', label: 'Inspector' },
];

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

function CheckpointsTab(): React.JSX.Element {
  const checkpoints = useBureauStore((state) => state.checkpoints);
  if (checkpoints.length === 0) {
    return (
      <EmptyState
        title="Nothing needs your attention"
        body="Pending decisions will show up here as they come in."
      />
    );
  }
  return (
    <ul aria-label="Pending checkpoints" className="flex flex-col gap-1 p-2">
      {checkpoints.map((checkpoint) => (
        <li key={checkpoint.id} className="rounded border border-bureau-border p-2 text-sm">
          <p className="font-medium">{checkpoint.title}</p>
          <p className="text-bureau-text-muted">{checkpoint.context}</p>
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

  return (
    <section aria-label="Main panel" className="flex min-w-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Views"
        className="flex border-b border-bureau-border bg-bureau-bg-elevated"
      >
        {TABS.map((tab) => (
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
            {tab.id === 'checkpoints' && pendingCheckpoints > 0 && (
              <span
                // The count is in the accessible name too, not conveyed by
                // the pill alone (§14.7).
                aria-label={`${pendingCheckpoints} waiting for you`}
                className="ml-1.5 rounded-full bg-bureau-accent px-1.5 py-0.5 text-xs text-bureau-accent-text"
              >
                {pendingCheckpoints}
              </span>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex-1 overflow-auto">
        {activeTab === 'chat' && <ChatView />}
        {activeTab === 'board' && <BoardTab />}
        {activeTab === 'checkpoints' && <CheckpointsTab />}
        {activeTab === 'inspector' && <InspectorTab />}
      </div>
    </section>
  );
}
