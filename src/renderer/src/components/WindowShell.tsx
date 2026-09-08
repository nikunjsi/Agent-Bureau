import { useEffect, useState } from 'react';
import { TitleBar } from './TitleBar';
import { FloorPane } from './FloorPane';
import { RightPanel } from './RightPanel';
import { EmployeeBar } from './EmployeeBar';
import { SettingsPanel } from './SettingsPanel';
import { useBureauStore } from '../store/bureauStore';
import { useTheme } from '../useTheme';
import { wireIpcBridge } from '../ipcBridge';

/** §14.1's window layout: title bar, floor + right panel side by side,
 * employee bar along the bottom. `useTheme()` and the stateDelta
 * subscription are wired here, once, for the whole window. */
export function WindowShell(): React.JSX.Element {
  const hydrated = useBureauStore((state) => state.hydrated);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useTheme();

  useEffect(() => wireIpcBridge(), []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bureau-bg text-bureau-text">
      <TitleBar onOpenSettings={() => setSettingsOpen(true)} />
      {hydrated ? (
        <div className="flex min-h-0 flex-1">
          <FloorPane />
          <RightPanel />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-bureau-text-muted">
          Starting Bureau…
        </div>
      )}
      <EmployeeBar />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
