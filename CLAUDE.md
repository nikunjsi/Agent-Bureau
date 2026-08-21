# Bureau — invariants

The full specification is `docs/BUILD-SPEC.md`. Read it (§1, §2, and the section
covering whatever you're touching) before writing code, and read `PROGRESS.md`
for what has actually landed vs. what the spec describes. This file is §21 of
that spec, copied verbatim — the rules that must hold regardless of which
milestone is in progress.

**Never violate:**

1. **The conversation is the product.** A user who only uses the chat must be able to complete a project.
2. **Nothing is built before the brief is approved.**
3. **Every state change is committed before the side effect, and emits exactly one activity event.**
4. **Employees never commit.** The Core is the sole committer. Enforcement is layered per §10.3.1 — ACL/restricted token first, pattern denies second, commit-time HEAD reconciliation always. If the restricted-token layer is not built, the _documentation_ is downgraded to match; the invariant is never claimed more strongly than the mechanism supports.
5. **Nothing outside the workspace is readable or writable**, at any autonomy level. Not overridable.
6. **Fail closed.** Unreachable policy check, hook timeout, ambiguous rule, expired checkpoint → the safe option.
7. **A checkpoint timeout never causes an irreversible action.**
8. **Every checkpoint option states its consequence.** Validation rejects those that do not.
9. **Never ask a question that memory, the brief, or the workspace already answers.**
10. **Every visual state on the floor maps to a real system state.**
11. **The renderer holds no authoritative state and has no Node access.**
12. **Money is integer micro-dollars** everywhere downstream of the config loader.
13. **No claim without a test** (`claims.yaml`).
14. **No asset with a non-commercial licence, ever.**
15. **Employees never claim to be human.**

**Things that look reasonable and are wrong:**

- Do **not** add a "disable activity log" option for performance. Fix the performance.
- Do **not** let a pack widen an immutable deny. Validation rejects it at load.
- Do **not** inject a message into an agent mid-generation. Wait for `idle`.
- Do **not** rely on `process.env.PATH` after installing a tool (§15.4).
- Do **not** parse semantics out of raw terminal bytes when a structured channel exists.
- Do **not** show raw engine output to the user by default. Translate.
- Do **not** ask the user one question at a time. Batch.
- Do **not** build the Floor before the Director works.
- Do **not** use fractional canvas scaling for pixel art.
- Do **not** ship native modules built against system Node.
- Do **not** let a `finished` event mean "task complete". Only `bureau_task_done` does.
- Do **not** give the hook a short deadline on the human. Long-poll; fail closed on transport failure only (§7.10).
- Do **not** overwrite `employees.autonomy` from a runtime probe. Compute an effective value.
- Do **not** load Phaser assets over `file://`. Use the `app://` scheme (§18.1.1).
- Do **not** show `$0.00` for an engine that does not report usage. Show "cost not reported".
- Do **not** auto-resolve checkpoints in the first ten minutes after a restart.

**Definition of done for any component:** implemented per its section · unit tests plus the property tests named for it · its security tests pass · typecheck strict and lint clean · docs updated if the interface changed · `PROGRESS.md` updated · an activity event exists for every state change it makes.
