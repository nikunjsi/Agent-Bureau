import { useState } from 'react';
import { useBureauStore } from '../store/bureauStore';

const STATUS_LABEL: Record<string, string> = {
  off: 'off',
  starting: 'starting',
  idle: 'idle',
  working: 'working',
  thinking: 'thinking',
  waiting: 'waiting',
  blocked: 'blocked',
  parked: 'parked',
  stopping: 'stopping',
  failed: 'failed',
};

export function EmployeeBar(): React.JSX.Element {
  const employees = useBureauStore((state) => state.employees);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleHire(): Promise<void> {
    const result = await window.bureau.company.hire({ roleKey: 'core:developer' });
    // §14.6: every error needs plain language + a next action — this
    // proves the envelope's error.message reaches the user as-is, not as
    // "Error: NOT_IMPLEMENTED". There's genuinely no next action yet
    // (hiring needs packs, not built until M7), so none is shown.
    setNotice(result.ok ? 'Hired.' : result.error.message);
  }

  return (
    <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-bureau-border bg-bureau-bg-elevated px-2 text-sm">
      {employees.length === 0 && !notice && (
        <span className="text-bureau-text-muted">No employees yet</span>
      )}
      {employees.map((employee) => (
        <span
          key={employee.id}
          className="flex items-center gap-1 rounded border border-bureau-border px-2 py-0.5"
        >
          <span aria-hidden="true">●</span>
          {employee.name}{' '}
          <span className="text-bureau-text-muted">
            {STATUS_LABEL[employee.status] ?? employee.status}
          </span>
        </span>
      ))}
      {notice && (
        <span role="status" className="text-bureau-text-muted">
          {notice}
        </span>
      )}
      <button
        type="button"
        onClick={() => void handleHire()}
        className="ml-auto rounded border border-bureau-border px-2 py-0.5 hover:bg-bureau-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
      >
        + Hire
      </button>
    </footer>
  );
}
