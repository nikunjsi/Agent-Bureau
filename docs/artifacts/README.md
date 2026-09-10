# Artifacts

Standalone HTML pages produced alongside the build — status reports, guides and
diagrams. Each one opens in a browser with no build step and no server. They are
snapshots, not living documents: the date on each page is when it was true.

| File | What it is | Audience | As of |
|---|---|---|---|
| [`bureau-blueprint.html`](bureau-blueprint.html) | **The system, as diagrams.** Architecture, the data model, every join between subsystems colour-coded by whether it is proven, broken or unbuilt, the permission flow, and the rules. Almost no prose. | Anyone who wants the shape of the thing in one look | 7 Sep 2026 |
| [`building-bureau.html`](building-bureau.html) | **The walkthrough.** All sixteen milestones one by one in plain language — what each builds, why it is in that order, and what proved it. Ends with a 29-term glossary. | Someone new to the project | 29 Aug 2026 |
| [`bureau-at-work.html`](bureau-at-work.html) | **The capability overview.** What Bureau does and what you would use it for, with worked examples. No development detail. Honest about what is built versus designed. | A business reader | 29 Aug 2026 |

## Not in this folder

**Bureau at M5** — the first status report, written 28 Aug 2026. It is a
point-in-time snapshot from when M5 was mid-flight and only five milestones were
closed, so it is now substantially out of date. It was cleaned from the working
directory and only survives as a published artifact. Kept as a link rather than
a file because its value is historical:
<https://claude.ai/code/artifact/09d909eb-f8f8-4fc5-b92a-1ee5bbd8d047>

## Notes

- These are **generated snapshots**, not sources of truth. When they disagree
  with `docs/BUILD-SPEC.md`, `PROGRESS.md` or `PROJECT-CHECKLIST.md`, those win.
- Each page carries its own theme and fonts. Fonts load from Google Fonts, so
  they fall back to system faces offline — the pages still read correctly.
- **Do not regenerate these every milestone.** See
  [`REGENERATION.md`](REGENERATION.md) — sessions append what changed to a
  pending list, and all three pages are rebuilt at two points only: after M11
  and after M15.
