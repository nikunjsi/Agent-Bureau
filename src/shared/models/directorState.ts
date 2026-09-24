import { z } from 'zod';

/**
 * Appendix A.3's states — what the Director is doing in one conversation,
 * persisted in `conversations.director_state` (M11 row S1-14). A null column
 * is `IDLE`: a conversation nothing has moved yet.
 */
export const DIRECTOR_STATES = [
  'IDLE',
  'RESPONDING',
  'INTAKE',
  'DRAFTING_BRIEF',
  'AWAITING_BRIEF_APPROVAL',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'SUPERVISING',
  'PHASE_REVIEW',
  'ESCALATING',
  'REPLANNING',
  'DELIVERING',
] as const;

export const DirectorStateSchema = z.enum(DIRECTOR_STATES);
export type DirectorState = z.infer<typeof DirectorStateSchema>;
