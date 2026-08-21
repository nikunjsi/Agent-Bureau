import { z } from 'zod';

/** `counters(name, value)` — §5.1.2. Not given its own column table in
 * §5.1, only the inline mention; this is the natural, minimal shape it
 * describes. */
export const CounterSchema = z.object({
  name: z.string().min(1),
  value: z.number().int(),
});
export type Counter = z.infer<typeof CounterSchema>;
