import { describe, expect, it } from 'vitest';
import {
  computeExpiresAt,
  type CheckpointTimeoutSettings,
} from '../../../src/main/checkpoints/expiry';

/**
 * §9.5's timeouts. The whole point of this function existing separately is
 * that it is the ONLY place a checkpoint deadline is derived, so these
 * tests are also the complete statement of what deadlines Bureau can
 * produce.
 */

const NOW = Date.parse('2026-09-07T12:00:00.000Z');

const settings: CheckpointTimeoutSettings = {
  blockingTimeoutMinutes: 60,
  soonTimeoutHours: 4,
  maxHoldMinutes: 30,
};

describe('computeExpiresAt (§9.5)', () => {
  describe('CLAUDE.md invariant #7 — no safe default, no expiry', () => {
    // This is the structural half of "a timeout never results in an
    // irreversible action". It is not enforced by the sweep remembering to
    // check; the row simply has no expires_at, so the sweep's own query
    // cannot select it.
    it.each(['blocking', 'soon', 'whenever'] as const)(
      'returns null for a %s checkpoint with no default_action',
      (urgency) => {
        expect(
          computeExpiresAt({ type: 'decision', urgency, default_action: null }, settings, NOW),
        ).toBeNull();
      },
    );

    it('returns null even for a permission checkpoint with no default_action', () => {
      // Unreachable in production — `createPermissionCheckpoint` hardcodes
      // `deny` — but the rule is checked BEFORE the type branch, so the
      // guarantee does not depend on that constructor staying correct.
      expect(
        computeExpiresAt(
          { type: 'permission', urgency: 'blocking', default_action: null },
          settings,
          NOW,
        ),
      ).toBeNull();
    });
  });

  describe('by urgency, when a safe default exists', () => {
    it('blocking → now + checkpoints.blockingTimeoutMinutes', () => {
      const result = computeExpiresAt(
        { type: 'decision', urgency: 'blocking', default_action: 'safe' },
        settings,
        NOW,
      );
      expect(result).toBe(new Date(NOW + 60 * 60_000).toISOString());
    });

    it('soon → now + checkpoints.soonTimeoutHours', () => {
      const result = computeExpiresAt(
        { type: 'decision', urgency: 'soon', default_action: 'safe' },
        settings,
        NOW,
      );
      expect(result).toBe(new Date(NOW + 4 * 3_600_000).toISOString());
    });

    it('whenever → no expiry, even with a safe default', () => {
      // §9.5: "`whenever` → no expiry." The default still exists and is
      // still what an explicit answer-by-default would apply; nothing is
      // ever applied to it on a clock.
      expect(
        computeExpiresAt(
          { type: 'decision', urgency: 'whenever', default_action: 'safe' },
          settings,
          NOW,
        ),
      ).toBeNull();
    });
  });

  describe('permission uses the hold clock, not the checkpoint clock', () => {
    // §7.10 already reconciles three durations by hand and says why they
    // are kept explicitly separate. A permission checkpoint whose card
    // promised the user 60 minutes while the hold denied at 30 would be a
    // fourth number silently disagreeing with the first.
    it('permission → now + permissions.maxHoldMinutes, NOT blockingTimeoutMinutes', () => {
      const result = computeExpiresAt(
        { type: 'permission', urgency: 'blocking', default_action: 'deny' },
        settings,
        NOW,
      );
      expect(result).toBe(new Date(NOW + 30 * 60_000).toISOString());
      // Explicitly not the blocking timeout, which is the value it would
      // pick up if the type branch were ever removed.
      expect(result).not.toBe(new Date(NOW + 60 * 60_000).toISOString());
    });

    it('tracks maxHoldMinutes when it is changed, so the row and the hold cannot drift', () => {
      const result = computeExpiresAt(
        { type: 'permission', urgency: 'blocking', default_action: 'deny' },
        { ...settings, maxHoldMinutes: 3 },
        NOW,
      );
      expect(result).toBe(new Date(NOW + 3 * 60_000).toISOString());
    });
  });
});
