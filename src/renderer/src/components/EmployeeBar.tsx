import { useState } from 'react';
import { useBureauStore } from '../store/bureauStore';
import { ErrorNotice, type NoticeError } from './ErrorNotice';

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
  const [error, setError] = useState<NoticeError | null>(null);

  async function handleHire(): Promise<void> {
    // AUDIT M0–M2 #16. The comment that used to sit here said this
    // "proves the envelope's error.message reaches the user as-is" and
    // called that the point of §14.6. It is the opposite of §14.6's point:
    // a message reaching the user *as-is* is exactly the failure mode
    // ("'Error: ENOENT' reaching the user is a bug"), and a success string
    // and an error sharing one `notice` state guaranteed the error's
    // `action` had nowhere to go. Two states, and the error goes to
    // `ErrorNotice`, which renders whatever next action the Core sent.
    const result = await window.bureau.company.hire({ roleKey: 'core:developer' });
    if (result.ok) {
      setError(null);
      setNotice('Hired.');
      return;
    }
    setNotice(null);
    setError(result.error);
  }

  return (
    <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-bureau-border bg-bureau-bg-elevated px-2 text-sm">
      {employees.length === 0 && notice === null && error === null && (
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
      {notice !== null && (
        <span role="status" className="text-bureau-text-muted">
          {notice}
        </span>
      )}
      {error !== null && <ErrorNotice error={error} onRetry={() => void handleHire()} />}
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
