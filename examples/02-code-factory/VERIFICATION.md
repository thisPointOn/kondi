# Verification — 02 · Code Factory

Run: all 7 steps completed. The working code, tests, and documentation exist
on disk (preserved in `deliverables/`); the test suite was re-executed BY HAND
after the run and prints `ALL TESTS PASS` (exit 0).

| Step | Verdict | Evidence |
|---|---|---|
| Implementation plan | **PASS** | CLI plan author produced a concrete plan: exact CLI contract, normalization rules, sort order, and the mandated literal `ALL TESTS PASS` success string (stated 4×), ending in the machine-readable STRUCTURED SPEC. |
| Plan approval (gate) | **PASS** | Gate paused for approval and passed the PLAN through untouched (pass-through verified in the artifact). |
| Implementation (coding) | **PASS** | Real files written by the claude CLI worker; the council's own test cycle caught and fixed a genuine `__dirname` path-resolution bug before handing off. |
| Test run (script) | **PASS** | Mechanical: `node test.js` → `ALL TESTS PASS` + `SCRIPT-VERIFIED`. Re-run by hand post-hoc with the same result. |
| Ship check (condition) | **PASS** | Exact-string check satisfied on the first attempt this run; the loop machinery was exercised for real in an earlier run (see below). |
| Docs & code review | **PASS** | `README.md`, `docs/` (api/usage/behavior/testing), and `review.md` written to disk as REAL FILES; review.md contains a per-requirement adherence table with line-number evidence. |
| Release notes | **PASS (minor)** | Accurate, grounded notes (features, usage, test status). Blemish: ~2× the requested <200-word budget. |

## Bugs this example surfaced during development (all fixed in the engine)
1. **`createCouncil()` dropped `outputType` on save** — every pipeline worker
   was silently forced into text mode; the review council emitted its docs as
   fenced text instead of files. (Field whitelist fixed.)
2. **Loop feedback didn't say WHY** — a run failed the exact-string gate, and
   the retry received only the evaluated input (which read as success:
   `✓ All tests passed!`), so it "fixed" the wrong things. Loop feedback now
   leads with the condition's mode/expression/verdict.
3. **Script steps ran one directory too high** — cwd is now the pipeline's
   working directory.
4. **The pre-run git snapshot once committed the PARENT repo's tree** (the
   workspace was nested inside this very repo). Snapshot now requires the
   workdir to be its own repo top-level.
5. A tool-less release-notes agent once claimed it wrote `RELEASE_NOTES.md`
   (no file existed) — text-output agents no longer get tool-exec framing.
