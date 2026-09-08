/**
 * §9.7's "resolve address" step, as a pure function.
 *
 * Three producers write `to_addr` today and they do not agree on spelling,
 * because two of them cannot:
 *
 *   - `answerCheckpoint` writes `employee:<id>` — a system-authored
 *     address, so it uses the explicit form.
 *   - `bureau_send_message` writes **whatever the agent named**. §7.9 makes
 *     `to` deliberately agent-suppliable ("that is the point of the tool"),
 *     so a bare id is a real, expected value and not a malformed one.
 *   - `bureau_ask_director` writes the literal `director`.
 *
 * Parsing is therefore permissive about spelling and strict about meaning:
 * an address is one of five things, and anything else is `unparseable`
 * rather than guessed at. `unparseable` is a real outcome with a real
 * consequence (§9.7's dead letter, and a blocker checkpoint if it was a
 * question) — never a silent drop.
 */

export type MessageAddress =
  | { readonly kind: 'employee'; readonly employeeId: string }
  | { readonly kind: 'role'; readonly roleKey: string }
  | { readonly kind: 'director' }
  | { readonly kind: 'user' }
  | { readonly kind: 'unparseable'; readonly raw: string };

export function parseMessageAddress(toAddr: string): MessageAddress {
  const raw = toAddr.trim();
  if (raw.length === 0) return { kind: 'unparseable', raw: toAddr };

  const lower = raw.toLowerCase();
  if (lower === 'director') return { kind: 'director' };
  if (lower === 'user') return { kind: 'user' };

  if (lower.startsWith('role:')) {
    const roleKey = raw.slice('role:'.length).trim();
    return roleKey.length === 0 ? { kind: 'unparseable', raw: toAddr } : { kind: 'role', roleKey };
  }

  if (lower.startsWith('employee:')) {
    const employeeId = raw.slice('employee:'.length).trim();
    return employeeId.length === 0
      ? { kind: 'unparseable', raw: toAddr }
      : { kind: 'employee', employeeId };
  }

  // A bare token. `bureau_send_message` passes the agent's own `to`
  // straight through, so this is the ordinary case for an agent-to-agent
  // message, not a fallback. Whether the id names a real employee is
  // `deliverabilityOf`'s question, not this one's — parsing decides shape,
  // resolution decides existence, and keeping those apart is what makes a
  // nonexistent employee a dead letter rather than an unparseable address.
  if (raw.includes(':')) return { kind: 'unparseable', raw: toAddr };
  return { kind: 'employee', employeeId: raw };
}

/** For event payloads and checkpoint prose — never parsed back. */
export function describeAddress(address: MessageAddress): string {
  switch (address.kind) {
    case 'employee':
      return `employee ${address.employeeId}`;
    case 'role':
      return `the ${address.roleKey} role`;
    case 'director':
      return 'the Director';
    case 'user':
      return 'you';
    case 'unparseable':
      return `an unrecognised address (${address.raw})`;
  }
}
