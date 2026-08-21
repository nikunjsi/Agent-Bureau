import { useEffect, useState } from 'react';
import type { HealthResult } from '../../shared/ipc/health';

type HealthState =
  | { status: 'loading' }
  | { status: 'ok'; result: HealthResult }
  | { status: 'error'; message: string };

export function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthState>({ status: 'loading' });

  useEffect(() => {
    window.bureau.system
      .health()
      .then((result) => setHealth({ status: 'ok', result }))
      .catch((error: unknown) =>
        setHealth({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }, []);

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        color: '#e5e5e5',
        background: '#111',
      }}
    >
      <h1>Bureau</h1>
      <p>Milestone M0 — skeleton.</p>
      {health.status === 'loading' && <p>Checking system health…</p>}
      {health.status === 'error' && (
        <p style={{ color: '#f87171' }}>Health check failed: {health.message}</p>
      )}
      {health.status === 'ok' && (
        <ul>
          <li>Bureau {health.result.version}</li>
          <li>Electron {health.result.electron}</li>
          <li>Chrome {health.result.chrome}</li>
          <li>Node {health.result.node}</li>
          <li>Platform {health.result.platform}</li>
        </ul>
      )}
    </main>
  );
}
