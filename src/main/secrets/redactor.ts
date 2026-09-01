/**
 * §11.4 — the single choke point every outbound path passes through
 * (terminal stream, transcripts, event payloads, IPC to the renderer,
 * commit messages, support bundles — six call sites, wired individually
 * in Item 11's own files because the DATA SHAPES differ, but all of them
 * routing through the matcher logic and secret registry defined here,
 * once). Deliberately free of any `electron` import — this module must be
 * safe to pull into any plain-Node test bundle, the same discipline
 * `toolClassify.ts`/`zeroCostMode.ts` already established for anything
 * that doesn't itself need a live Electron `app`.
 */

/** A secret VALUE known to Bureau — never `unregister()`d once known: an
 * old or rotated credential must stay redactable in old transcripts and
 * logs forever, not just for as long as it's still live. Exact-match
 * only — this is the redactor's OTHER matcher, alongside the
 * pattern-based one below; it exists specifically because a bare
 * `Record<string,string>` env can't tell a credential apart from an
 * innocuous value like a host URL (`seams.ts`'s own `SecretBroker`
 * comment), so real secret values have to be tracked explicitly. */
export class SecretRegistry {
  private readonly known = new Set<string>();

  /** Registers zero or more real secret values. Empty strings are never
   * tracked — an empty string "redacted" everywhere would corrupt every
   * other string in the app. */
  register(values: readonly string[]): void {
    for (const value of values) {
      if (value.length > 0) this.known.add(value);
    }
  }

  values(): readonly string[] {
    return [...this.known];
  }

  /** The longest currently-known secret value's length, 0 if none —
   * `RedactionStream`'s own overlap window needs this to size itself
   * correctly against whatever is actually registered right now. */
  longestValueLength(): number {
    let max = 0;
    for (const v of this.known) if (v.length > max) max = v.length;
    return max;
  }
}

/** The real, process-lifetime registry every real caller shares — the one
 * place a resolved credential becomes globally redactable the moment ANY
 * employee's broker call resolves it, not just that employee's own
 * output. Tests construct their own isolated `SecretRegistry` instead. */
export const globalSecretRegistry = new SecretRegistry();

interface PatternMatcher {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * §11.4's own list, verbatim: JWTs, `sk-`/`gsk_`/`dapi` prefixes, AWS key
 * IDs, PEM blocks, `Bearer` headers, connection strings. Each pattern is
 * high-confidence by design — false positives here just redact ordinary
 * text (annoying, never dangerous); false negatives are the real risk,
 * which is why the exact-value matcher above exists as the primary
 * defense and these patterns are the second, broader net.
 */
const PATTERN_MATCHERS: readonly PatternMatcher[] = [
  // A JWT is three base64url segments joined by dots; the header segment
  // is the base64 of `{"` + more, which always starts `eyJ` in practice.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'groq_key', pattern: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { name: 'databricks_token', pattern: /\bdapi[A-Za-z0-9]{20,}\b/g },
  // AWS access key IDs are a fixed 20 chars: a 4-char prefix + 16 more.
  { name: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'pem_block', pattern: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g },
  { name: 'bearer_header', pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g },
  // protocol://user:pass@host — postgres/mysql/mongodb/redis/amqp/etc,
  // any scheme, as long as real credentials are embedded in the authority.
  { name: 'connection_string', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s/]+/gi },
];

function label(name: string): string {
  return `«redacted:${name}»`;
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

/** Finds every match (exact secret values first, then patterns) in `text`,
 * sorted by start position, with overlaps resolved by "first match at
 * this position wins, longest wins ties" — the exact-value matcher runs
 * first specifically so a known secret value that also happens to look
 * like a generic pattern gets its own precise label, not a pattern's
 * more generic one. */
function findAllMatches(text: string, registry: SecretRegistry): Match[] {
  const matches: Match[] = [];

  for (const secret of registry.values()) {
    let fromIndex = 0;
    for (;;) {
      const idx = text.indexOf(secret, fromIndex);
      if (idx === -1) break;
      matches.push({ start: idx, end: idx + secret.length, label: label('secret') });
      fromIndex = idx + secret.length;
    }
  }

  for (const matcher of PATTERN_MATCHERS) {
    matcher.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.pattern.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, label: label(matcher.name) });
      if (m[0].length === 0) matcher.pattern.lastIndex += 1; // never loop forever on a zero-width match
    }
  }

  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  // Drop overlaps: keep the first (by the sort above — earliest start,
  // longest at a tie) and skip anything that starts before the kept
  // match's own end.
  const deduped: Match[] = [];
  let cursor = -1;
  for (const m of matches) {
    if (m.start < cursor) continue;
    deduped.push(m);
    cursor = m.end;
  }
  return deduped;
}

/** Applies every match in `matches` that lies entirely within
 * `[0, limit)` to `text`, returning the redacted result for that prefix
 * and where the caller's cursor ended up (== limit, always, since plain
 * text between/after matches up to `limit` is included verbatim). */
function applyMatches(text: string, matches: readonly Match[], limit: number): string {
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    if (m.end > limit) break;
    out += text.slice(cursor, m.start);
    out += m.label;
    cursor = m.end;
  }
  out += text.slice(cursor, limit);
  return out;
}

/** One-shot redaction for anything that isn't a live byte stream — event
 * payloads, commit messages, the state-delta snapshot, support bundle
 * content. No overlap buffering needed: the whole string is already
 * available at once, so there's no chunk boundary to protect against. */
export function redactText(text: string, registry: SecretRegistry = globalSecretRegistry): string {
  if (text.length === 0) return text;
  const matches = findAllMatches(text, registry);
  return applyMatches(text, matches, text.length);
}

/** Deep-redacts every string value in a JSON-serializable value (object,
 * array, or scalar) — used for the two structured-payload choke points
 * (activity-log payloads, the state-delta snapshot) where the secret
 * could be anywhere in a nested shape, not just a single top-level
 * string. */
export function redactDeep<T>(value: T, registry: SecretRegistry = globalSecretRegistry): T {
  if (typeof value === 'string') return redactText(value, registry) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, registry)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, registry);
    }
    return out as T;
  }
  return value;
}

/** A ceiling on pattern length used to size the streaming overlap window
 * — generous enough for a real multi-line PEM block (a 4096-bit RSA
 * private key's PEM body comfortably fits inside this), small enough
 * that the held-back tail stays a bounded, reasonable size regardless of
 * how large the known-secret-value set grows. */
const PATTERN_MAX_LEN = 4096;

/**
 * The real overlap-buffer mechanism for the one genuinely-chunked path
 * (raw PTY/terminal bytes). Reuses the *lesson* `PtyOutputBuffer` (M3)
 * established — match against the accumulated buffer, never a lone
 * chunk in isolation — but is a different mechanism: `PtyOutputBuffer`
 * answers a yes/no "does the buffer match a pattern" question and
 * re-scans its whole (capped) buffer every time; this class must
 * INCREMENTALLY EMIT safe output while still catching a match that
 * straddles a chunk boundary, which needs its own accounting.
 *
 * Safety argument (the standard streaming-scanner one): on every
 * `feed()`, every match in the FULL currently-buffered raw text is
 * found first — including ones that straddle the eventual safe/held-back
 * boundary — and only matches (and plain text) that end at or before
 * `pending.length − (maxMatchLen − 1)` are finalized and emitted. Any
 * match not yet finalized must therefore START at or after that same
 * boundary (if it started any earlier, given its length is at most
 * `maxMatchLen`, it would already have ENDED at or before the boundary,
 * and would already be finalized). So nothing containing a real secret
 * is ever emitted un-redacted, and `pending` never exceeds
 * `chunk.length + maxMatchLen − 1` regardless of total stream length —
 * bounded memory for an arbitrarily large stream (chaos row 8).
 *
 * `maxMatchLen` is recomputed on every `feed()` from the registry's
 * CURRENT longest known value (a secret can be registered mid-stream,
 * e.g. the broker resolves credentials right before the first turn
 * starts) and the fixed pattern ceiling above.
 */
export class RedactionStream {
  private pending = '';

  constructor(private readonly registry: SecretRegistry = globalSecretRegistry) {}

  private maxMatchLen(): number {
    return Math.max(PATTERN_MAX_LEN, this.registry.longestValueLength());
  }

  /** Feeds one chunk of raw text, returning whatever is now safe to emit
   * (possibly empty, if everything buffered so far is still within the
   * held-back window). */
  feed(chunk: string): string {
    this.pending += chunk;
    const safeBoundary = Math.max(0, this.pending.length - (this.maxMatchLen() - 1));
    if (safeBoundary === 0) return '';
    const matches = findAllMatches(this.pending, this.registry);
    const out = applyMatches(this.pending, matches, safeBoundary);
    this.pending = this.pending.slice(safeBoundary);
    return out;
  }

  /**
   * Finalizes and returns everything currently held back — safe to call
   * at true end of stream (`finished`), but ALSO at any other point
   * genuinely safe to treat as "nothing pending can still be extended"
   * (§7.4's own `idle` — "at a prompt, safe to inject" is equally "safe
   * to stop holding back," the same instant): a value split across more
   * than one real chunk boundary is the scenario this class defends
   * against; a value that would somehow span an `idle` boundary into a
   * FUTURE, unrelated turn is not a real scenario worth holding output
   * hostage for. Callers needing a periodic release without an `idle`
   * signal (a stall mid-turn) call this from their own timer — this
   * class has no timer of its own, deliberately: it stays a pure,
   * synchronous buffer: no timers, easy to test byte-for-byte.
   */
  flush(): string {
    if (this.pending.length === 0) return '';
    const matches = findAllMatches(this.pending, this.registry);
    const out = applyMatches(this.pending, matches, this.pending.length);
    this.pending = '';
    return out;
  }

  /** Test/inspection only — how much raw text is currently held back. */
  get pendingLength(): number {
    return this.pending.length;
  }
}
