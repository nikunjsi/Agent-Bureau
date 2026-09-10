import { TitleBar } from './TitleBar';
import { FloorPane } from './FloorPane';
import { RightPanel } from './RightPanel';
import { EmployeeBar } from './EmployeeBar';
import { SettingsPanel } from './SettingsPanel';
import { useBureauStore } from '../store/bureauStore';
import { useTheme } from '../useTheme';

/** §14.1's window layout: title bar, floor + right panel side by side,
 * employee bar along the bottom. `useTheme()` and the stateDelta
 * subscription are wired for the whole window — the theme here, the IPC
 * bridge at module scope in main.tsx (see the comment there: it must be up
 * before `did-finish-load`, which is before this component's effects run). */
export function WindowShell(): React.JSX.Element {
  const hydrated = useBureauStore((state) => state.hydrated);
  // AUDIT #16: in the store rather than local state, so `ErrorNotice` can
  // act on an `open_settings` action from anywhere in the tree without the
  // setter being threaded through every component in between.
  const settingsOpen = useBureauStore((state) => state.settingsOpen);
  const setSettingsOpen = useBureauStore((state) => state.setSettingsOpen);
  useTheme();

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
