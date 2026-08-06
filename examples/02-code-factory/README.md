# 02 · Code Factory

**Goal:** ship a small working utility with tests — plan, human gate, real
implementation by a CLI agent, mechanical test verification, retry loop, and
release notes. Nothing is taken on the model's word: the script step actually
runs the tests.

**Input:** a text spec for `wordfreq.js` (word-frequency CLI) + `test.js`
(self-contained test that prints `ALL TESTS PASS`).

| # | Step | Type | What it does | Expected output |
|---|---|---|---|---|
| 1 | Implementation plan | code_planning | Planning council decomposes the spec | File list, function breakdown, edge cases, test strategy |
| 2 | Plan approval | gate | Human checkpoint before code gets written (auto-approved in the scripted run) | Approval |
| 3 | Implementation | coding | Coding council — the worker is the real `claude` CLI writing files in the working dir; `node test.js` as the council's test command | `wordfreq.js` + `test.js` on disk, tests passing |
| 4 | Test run | script | Executes `node test.js` — mechanical, no model judgment | `ALL TESTS PASS` + `SCRIPT-VERIFIED` |
| 5 | Ship check | condition | Requires `ALL TESTS PASS`; otherwise loops back to Implementation once (feedback carried), then fails the run | continue |
| 6 | Release notes | agent | Writes concise release notes from the verified state | <200-word notes: purpose, usage, test status |
