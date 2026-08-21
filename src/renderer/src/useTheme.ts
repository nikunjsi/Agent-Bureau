import { useEffect } from 'react';
import { useBureauStore } from './store/bureauStore';

/** Applies `general.theme` (§16.1: `system|light|dark`) to `<html
 * data-theme>` — `theme.css`'s three-state cascade (bare :root, the
 * prefers-color-scheme block, and the explicit-dark block) does the rest.
 * `'system'` removes the attribute entirely so the OS preference alone
 * decides, matching §14.8's "following the system by default." */
export function useTheme(): void {
  const theme = useBureauStore((state) => state.settings?.['general.theme'] ?? 'system');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.dataset.theme = theme;
    }
  }, [theme]);
}
