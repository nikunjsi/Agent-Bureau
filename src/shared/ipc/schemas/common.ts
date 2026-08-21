import { z } from 'zod';
import { IdSchema } from '../../models/ids';

/** The one input shape genuinely shared by a lot of "act on one entity by
 * id" methods (`pause`, `cancel`, `accept`, ...). Methods with more
 * specific input define their own schema instead of forcing this to fit. */
export const IdInputSchema = z.object({ id: IdSchema });

/** A method with no meaningful input at all (`system.health`,
 * `setup.getState`). */
export const EmptyInputSchema = z.object({});

/** A mutation whose success is fully captured by the envelope's `ok:true`
 * — nothing more to say back. */
export const OkOutputSchema = z.object({ ok: z.literal(true) });

export function listOutputSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item) });
}

export function nullableGetOutputSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ item: item.nullable() });
}
