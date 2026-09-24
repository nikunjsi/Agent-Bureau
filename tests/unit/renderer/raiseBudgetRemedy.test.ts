import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useBureauStore } from '../../../src/renderer/src/store/bureauStore';
import { afterCheckpointAnswer, followRemedy } from '../../../src/renderer/src/components/remedies';
import { SettingsGroups } from '../../../src/renderer/src/components/SettingsPanel';

/**
 * §8.0's "raise budget" button, and the exhausted-budget checkpoint's
 * `raise_budget` answer, both lead to the real budget control (M11 row
 * S1-19). Before this, the chat's remedy button logged "no destination yet"
 * and the answer only recorded itself — two inert paths the moment a
 * Director can actually run out.
 */
const SRC = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', 'src');

describe('raise_budget takes the user to the budget control', () => {
  beforeEach(() => {
    useBureauStore.setState({ settingsOpen: false, settingsFocusGroup: null, settings: null });
  });

  const noTab = () => {};
  const noPath = () => {};

  it('the chat remedy opens Settings at Budgets', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    followRemedy(
      { kind: 'raise_budget', targetId: null },
      { setActiveTab: noTab, openPath: noPath },
    );
    expect(useBureauStore.getState().settingsOpen).toBe(true);
    expect(useBureauStore.getState().settingsFocusGroup).toBe('Budgets');
    expect(warn, 'the remedy still has nowhere to go').not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('answering the exhausted-budget checkpoint with raise_budget opens it too; another answer does not', () => {
    afterCheckpointAnswer('cut_scope');
    expect(useBureauStore.getState().settingsOpen).toBe(false);
    afterCheckpointAnswer('raise_budget');
    expect(useBureauStore.getState().settingsOpen).toBe(true);
    expect(useBureauStore.getState().settingsFocusGroup).toBe('Budgets');
  });

  it('the panel brings the Budgets group, with its limits, into focus', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsGroups, {
        settings: { 'budgets.dailyUsd': 1_000_000 },
        focusGroup: 'Budgets',
      }),
    );
    const budgets = /<section[^>]*id="settings-group-Budgets"[^>]*>[\s\S]*?<\/section>/.exec(
      html,
    )?.[0];
    expect(budgets).toBeDefined();
    expect(budgets).toContain('data-focused="true"');
    expect(budgets).toContain('budgets.dailyUsd');
    expect(html.match(/data-focused="true"/g)).toHaveLength(1);
  });

  it('closing the panel forgets where it was sent', () => {
    useBureauStore.getState().openSettings('Budgets');
    useBureauStore.getState().setSettingsOpen(false);
    expect(useBureauStore.getState().settingsFocusGroup).toBeNull();
  });

  it('the production callers: the chat routes remedies here, and every answer passes through', () => {
    const chatView = readFileSync(path.join(SRC, 'components', 'chat', 'ChatView.tsx'), 'utf8');
    expect(chatView).toMatch(/followRemedy\(remedy,/);
    expect(chatView).not.toMatch(/no destination yet/);
    const answering = readFileSync(
      path.join(SRC, 'components', 'checkpoints', 'useCheckpointAnswering.ts'),
      'utf8',
    );
    expect(answering).toMatch(/afterCheckpointAnswer\(input\.optionId\)/);
  });
});
