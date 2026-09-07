/**
 * A bounded, deterministic text-similarity score for duplicate detection.
 *
 * ## Why not just threshold FTS5's own rank
 *
 * `memory_fts`-style queries expose `rank`, which is bm25 — a **negative,
 * unbounded** score whose magnitude depends on the corpus (document count,
 * average length, term frequencies across the whole table). "Is -8.2 a
 * duplicate?" has no stable answer: the same pair of checkpoints scores
 * differently on a project with 3 answered checkpoints and one with 300,
 * and a threshold tuned on a fixture is meaningless against real data.
 *
 * So the division of labour is: **FTS narrows, Dice decides.** The FTS
 * index does what it is genuinely good at — finding the handful of
 * candidate rows worth looking at, using an index rather than a scan — and
 * this function makes the actual call on a 0..1 scale that means the same
 * thing on every corpus and can be unit-tested against hand-written pairs.
 */

/**
 * Lowercased word tokens. Deliberately the same character class
 * `toFtsQuery` splits on (`[^\p{L}\p{N}_]+`), so the tokens compared here
 * are the tokens the FTS query was built from — not a second, subtly
 * different notion of "word" that could make the narrowing and the
 * decision disagree.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Sørensen–Dice over token SETS: `2|A ∩ B| / (|A| + |B|)`.
 *
 * Set-based rather than bigram-based on purpose. The texts compared are a
 * checkpoint title plus its context — natural language where word choice
 * carries the meaning and word order does not ("Postgres or SQLite?" vs
 * "SQLite or Postgres?" is the same question). Character bigrams would
 * score those differently and would also reward incidental spelling
 * overlap between unrelated words.
 *
 * Two empty inputs score 0, not 1: a checkpoint with no searchable tokens
 * is not "identical to" another one, and `title`/`context` are both
 * `.min(1)` anyway, so this is a guard rather than a real case.
 */
export function diceSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  return (2 * intersection) / (setA.size + setB.size);
}
