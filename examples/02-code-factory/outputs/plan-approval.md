# Plan approval (gate) — completed

> Human gate — the plan must be approved before code is written (auto-approved in this scripted run).

[Source: Implementation plan (code_planning)]
[Output file: /home/erik/Documents/kondi/examples/02-code-factory/workspace/kondi-runs/example_code_factory_run_001_2026-08-06_0829/stage_1_stage_1/step_1_implementation_plan/output.md]

# Implementation Plan: `wordfreq.js` and `test.js`

## 1. Overall Objective

Create two standalone JavaScript files using only Node.js core modules:

**`wordfreq.js`** — A CLI utility that:
- Accepts a file path and optional count limit N (default 10) as command-line arguments
- Reads the specified UTF-8 text file
- Counts word occurrences (case-insensitive, punctuation stripped)
- Filters words to include only those with 3 or more characters
- Outputs the top N words sorted by:
  - Primary: descending frequency (most frequent first)
  - Secondary: ascending alphabetical order (for ties)
- Validates N and falls back to 10 if invalid (non-numeric, negative, or zero)

**`test.js`** — A self-contained test script that:
- Creates a temporary fixture file with known, multi-case content
- Invokes `wordfreq.js` via `child_process.spawn`
- Captures and validates the exact output (content and ordering)
- Cleans up the fixture file after testing
- Prints exactly `ALL TESTS PASS` on success (exit 0)
- Prints `TEST FAILED: <reason>` on any failure (exit 1)

**Constraint:** No external dependencies; Node.js core modules only (`fs`, `process`, `child_process`, `path`, etc.).

---

## 2. Phases & Deliverables

### 2.1 Requirements Analysis

**Functional Requirements:**
- Read command-line arguments: file path (required), N (optional, default 10)
- Read file contents synchronously (acceptable for scope; large files noted but not optimized)
- Tokenize text: convert to lowercase, strip punctuation, split into words
- Filter words: include only words with length ≥ 3 characters
- Count word frequencies using a case-insensitive map
- Sort results:
  - Primary key: count (descending)
  - Secondary key: word (alphabetically ascending, using `localeCompare`)
- Limit output to top N results
- Format output: one line per word-count pair, format `"word count"`, newline-separated
- Error handling: missing/unreadable file, invalid arguments

**Edge Cases to Handle:**
1. **Missing or unreadable file** → Write error message to `stderr`, exit with code 1
2. **Empty file or no qualifying words** → Output nothing (empty string, no newline)
3. **Words shorter than 3 characters** → Ignored during filtering
4. **Punctuation and symbols** → Stripped; apostrophes treated as separators (e.g., "don't" → "don" + "t", both ignored if < 3 chars)
5. **Case-insensitive counting** → "Hello", "hello", "HELLO" all count as "hello"
6. **Tie-breaking** → When counts are equal, sort alphabetically (ascending)
7. **N exceeds distinct word count** → Return all distinct words, sorted
8. **Invalid N** (non-numeric, negative, zero, missing) → Fall back to default 10; optionally warn to `stderr`
9. **Large files** → Whole-file synchronous reading is acceptable for this scope

**Accepted Node Core Modules:**
- `fs` (file system operations)
- `process` (argv, stdout, stderr, exit)
- `child_process` (spawn for testing)
- `path` (optional, for file path normalization)
- No external dependencies permitted

---

### 2.2 `wordfreq.js` Architecture

#### High-Level Data Flow

```
Command-line arguments
    ↓
parseArgs() → {filePath, limit}
    ↓
readFileSync(filePath) → raw text string
    ↓
tokenize(text) → array of lowercase words (≥3 chars)
    ↓
countWords(words) → Map<word, count>
    ↓
sortAndLimit(countMap, limit) → sorted [[word, count], ...] array
    ↓
formatOutput(pairs) → formatted string
    ↓
Write to process.stdout
```

#### Function Specifications

| Function Name | Parameters | Return Value | Description |
|---------------|------------|--------------|-------------|
| `parseArgs` | `args: string[]` (typically `process.argv.slice(2)`) | `{filePath: string, limit: number}` | Extracts file path (required) and limit (optional, default 10). Validates limit; if non-numeric/negative/zero, defaults to 10. Optional: write warning to `stderr` if invalid limit provided. |
| `readFileSync` | `filePath: string` | `string` (UTF-8 text content) | Reads file synchronously using `fs.readFileSync(filePath, 'utf8')`. Throws error if file missing/unreadable (caught by `main`). |
| `tokenize` | `text: string` | `string[]` (array of words ≥3 chars) | Converts text to lowercase, replaces all non-word characters (anything matching `/\W/g`, includes apostrophes and punctuation) with spaces, splits on whitespace, filters out empty strings and words with length < 3. Returns clean array of qualifying words. |
| `countWords` | `words: string[]` | `Map<string, number>` | Iterates over words array, incrementing count in a Map for each word. Returns Map of word frequencies. |
| `sortAndLimit` | `countMap: Map<string, number>`, `limit: number` | `[string, number][]` (array of [word, count] tuples) | Converts Map entries to array, sorts by: (1) count descending, (2) word ascending (using `a[0].localeCompare(b[0])`). Slices to first `limit` entries. Returns sorted, limited array of tuples. |
| `formatOutput` | `pairs: [string, number][]` | `string` | Maps each `[word, count]` tuple to a string `"${word} ${count}"`, joins with `"\n"`. Returns formatted string with NO trailing newline. If pairs is empty, returns empty string. |
| `main` | None | `void` | Orchestrates the workflow: calls `parseArgs(process.argv.slice(2))`, wraps file operations in try-catch, calls other functions in sequence, writes result to `process.stdout.write()`, handles errors by writing to `process.stderr.write()` and calling `process.exit(1)`. On success, exits naturally (exit code 0). |

#### Error-Handling Strategy

- **Argument parsing errors:** If file path is missing → write usage message to `stderr`, exit 1. If limit is invalid → fall back to 10, optionally log warning to `stderr`, continue execution.
- **File reading errors:** Catch exceptions from `readFileSync` in `main()`. On error, write descriptive message to `stderr` (e.g., "Error: Cannot read file '<filePath>': <error.message>"), exit 1.
- **Empty/no results:** If final word list is empty, `formatOutput` returns empty string; `main` writes nothing to stdout. Exit 0 (not an error).
- **Exit codes:**
  - `0` = success (normal completion)
  - `1` = error (missing file, unreadable file, missing required argument)

---

### 2.3 `test.js` Architecture

#### Step-by-Step Algorithm

1. **Import core modules:** `fs`, `child_process` (specifically `spawn`), `path` (optional).
2. **Define fixture content** as a string constant (see below).
3. **Define expected output** as an array of strings (one per line).
4. **Create fixture file:** Use `fs.writeFileSync('fixture.txt', fixtureContent, 'utf8')` in the current working directory (or `path.join(__dirname, 'fixture.txt')` for portability).
5. **Spawn wordfreq.js:** Execute `child_process.spawn('node', ['wordfreq.js', 'fixture.txt'], {stdio: ['ignore', 'pipe', 'pipe']})`.
6. **Capture output:** Collect stdout and stderr data from the spawned process.
7. **Wait for exit:** Use `on('close', (code) => {...})` event.
8. **Validate results:**
   - If `code !== 0` → fail with reason "non-zero exit code"
   - If stderr has any content → fail with reason "stderr output: <stderr content>"
   - Normalize stdout: trim trailing whitespace (`stdout.trimEnd()`), split on newlines (`split(/\r?\n/)`), compare to expected array
   - If arrays differ in length or any element → fail with reason "wrong output"
9. **Report success:** If all checks pass, print exactly `ALL TESTS PASS` to console, exit 0.
10. **Report failure:** On any failure, print `TEST FAILED: <reason>` to console, exit 1.
11. **Cleanup (optional):** Call `fs.unlinkSync('fixture.txt')` after validation to remove the fixture file.

#### Exact Fixture Content

```javascript
const fixtureContent = `Hello, hello! HELLO? world... World; test-test test. foo bar baz baz qux.
a an the and or but nor for yet so.
`;
```

**Why this fixture:**
- **Multiple occurrences:** "hello" appears 3 times (mixed case), "world" 2 times, "test" 2 times, "baz" 2 times, "qux" 1 time
- **Punctuation:** Commas, periods, exclamation marks, question marks, ellipses, semicolons, hyphens (all stripped)
- **Mixed case:** "Hello", "hello", "HELLO" all count as "hello"
- **Short words:** "a", "an", "the", "and", "or", "but", "nor", "for", "yet", "so" (all ≤ 3 chars; "the", "and", "but", "nor", "for", "yet" have exactly 3 chars but are valid)
- **Tie frequency:** "world", "test", "baz" all have count 2 (must be sorted alphabetically: baz, test, world)
- **Hyphenated words:** "test-test" splits into two "test" occurrences

#### Expected Output (Default N=10)

After tokenization and counting, the expected word-count pairs (sorted by count desc, then alphabetically):

```javascript
const expectedOutputDefault = [
  "hello 3",
  "baz 2",
  "test 2",
  "world 2",
  "bar 1",
  "foo 1",
  "qux 1"
];
```

**Explanation:**
- "hello" → 3 (highest frequency)
- "baz", "test", "world" → 2 each (tied; sorted alphabetically: baz, test, world)
- "bar", "foo", "qux" → 1 each (sorted alphabetically: bar, foo, qux)
- Short words from line 2: "the", "and", "but", "nor", "for", "yet" all have exactly 3 characters, so they should be included. Let me recalculate:
  - "the" → 1, "and" → 1, "but" → 1, "nor" → 1, "for" → 1, "yet" → 1
  - These also have count 1, so full expected output with N=10 would include them alphabetically.

**Corrected Expected Output (Default N=10):**

```javascript
const expectedOutputDefault = [
  "hello 3",
  "baz 2",
  "test 2",
  "world 2",
  "and 1",
  "bar 1",
  "but 1",
  "foo 1",
  "for 1",
  "nor 1"
];
```

**Note:** Since N=10 and there are more than 10 distinct words, the output will be limited to exactly 10 lines. If we count all words ≥3 chars:
- Count 3: hello
- Count 2: baz, test, world (3 words)
- Count 1: and, bar, but, foo, for, nor, qux, the, yet (9 words)

Total = 13 distinct words, but only top 10 are shown. The 10th word alphabetically among count-1 words would be... let me sort: and, bar, but, foo, for, nor, qux, the, yet. Taking first 6 after the 4 words with higher counts gives us and, bar, but, foo, for, nor.

**Final Corrected Expected Output (Default N=10):**

```javascript
const expectedOutputDefault = [
  "hello 3",
  "baz 2",
  "test 2",
  "world 2",
  "and 1",
  "bar 1",
  "but 1",
  "foo 1",
  "for 1",
  "nor 1"
];
```

#### Optional: Test Custom N

To verify the N parameter works, the test can also spawn with explicit N=3:

```javascript
const expectedOutputCustomN3 = [
  "hello 3",
  "baz 2",
  "test 2"
];
```

This tests that the limit parameter correctly restricts output to exactly 3 lines, even when ties exist (only "baz" and "test" from the count-2 group are included, alphabetically first).

**Wait, with N=3 we should get "hello 3", then two of the count-2 words alphabetically: "baz 2", "test 2". But "world" also has count 2 and comes after "test" alphabetically, so it gets cut off. This is correct.**

#### Comparison Method

1. Capture stdout as string from spawn process (with encoding 'utf8')
2. Normalize: `const actual = stdout.trimEnd().split(/\r?\n/);`
3. Compare arrays element-by-element: `actual.length === expected.length` and `actual.every((line, i) => line === expected[i])`
4. If any mismatch → fail with reason "wrong output"

#### Exit Code and Console Message Specification

**On PASS:**
```javascript
console.log('ALL TESTS PASS');
process.exit(0);
```

**On FAIL:**
```javascript
console.log(`TEST FAILED: ${reason}`);
process.exit(1);
```

Where `reason` is one of:
- `"non-zero exit code"` (if spawn process exits with code !== 0)
- `"stderr output: "` (if stderr has any data)
- `"wrong output"` (if stdout doesn't match expected)

---

### 2.4 Integration & Validation Plan

#### How to Run the Test

From the command line in the directory containing both `wordfreq.js` and `test.js`:

```bash
node test.js
```

#### Success Criteria

A successful test run must:
1. Print exactly `ALL TESTS PASS` to stdout
2. Exit with code 0
3. Produce no other output (no warnings, no errors)

#### Failure Criteria

A test failure occurs if:
- The spawned `wordfreq.js` process exits with a non-zero code
- Any content is written to stderr by `wordfreq.js`
- The stdout output does not exactly match the expected array (after normalization)
- The test prints `TEST FAILED: <reason>` and exits with code 1

#### Optional Cleanup

After validation (in the `on('close', ...)` handler, after all checks), remove the fixture file:

```javascript
try {
  fs.unlinkSync('fixture.txt');
} catch (err) {
  // Ignore cleanup errors (file may already be deleted)
}
```

This ensures the working directory is not cluttered with test artifacts.

---

### 2.5 Documentation & Review Checklist

#### Reviewer Checklist

Before implementation, verify the plan covers:

- [ ] All 7 required functions for `wordfreq.js` are defined with signatures, parameters, and return types
- [ ] Behavior of each function is described in sufficient detail (pseudo-code or bullet steps)
- [ ] Error handling is specified for file reading, argument parsing, and edge cases
- [ ] Tokenization rules are explicit (lowercase, strip punctuation, length ≥ 3)
- [ ] Sorting rules are explicit (count descending, then alphabetical ascending)
- [ ] Edge cases are enumerated (missing file, empty file, short words, ties, invalid N, etc.)
- [ ] Test fixture content is specified exactly (as a string literal)
- [ ] Expected output for the fixture is specified exactly (as an array of strings)
- [ ] Test validation steps are clear (spawn, capture, compare, report)
- [ ] Pass/fail console messages are exactly specified
- [ ] Optional custom N test is described (if included)
- [ ] Cleanup step is mentioned (optional but recommended)
- [ ] The `## STRUCTURED SPEC` JSON block is present and correctly formatted

#### Open Questions

Before coding begins, resolve:

1. **Newline handling:** Should the final output have a trailing newline? **Answer:** No trailing newline (per `formatOutput` spec: join with `\n` but do not append a final `\n`).
2. **Apostrophe handling:** Confirm apostrophes are treated as separators (non-word characters). **Answer:** Yes, `\W` regex includes apostrophes; "don't" → "don" + "t".
3. **stderr warnings for invalid N:** Should the program warn on invalid N, or silently fall back? **Answer:** Optional; plan allows for optional warning to `stderr`, but fallback to 10 is required behavior.
4. **Fixture file location:** Should it be in `__dirname` or current working directory? **Answer:** Current working directory is simpler; `path.join(__dirname, 'fixture.txt')` is more robust but optional.
5. **Handling of very large N:** If N=1000 but only 50 distinct words exist, output all 50. **Answer:** Confirmed; `sortAndLimit` slices to `Math.min(limit, countMap.size)`.

All questions above are now resolved in the plan.

---

## STRUCTURED SPEC

```json
{
  "project": {
    "name": "wordfreq-utility",
    "version": "1.0.0",
    "description": "CLI word frequency counter using only Node core modules",
    "entryPoint": "wordfreq.js",
    "testScript": "test.js"
  },
  "files": [
    {
      "name": "wordfreq.js",
      "type": "module",
      "functions": [
        {
          "name": "parseArgs",
          "params": ["args: string[]"],
          "returns": "{filePath: string, limit: number}",
          "description": "Extracts file path (required) and limit (optional, default 10). Validates limit; if non-numeric/negative/zero, defaults to 10. Optional stderr warning if invalid limit provided."
        },
        {
          "name": "readFileSync",
          "params": ["filePath: string"],
          "returns": "string",
          "description": "Reads file synchronously using fs.readFileSync(filePath, 'utf8'). Throws error if file missing/unreadable (caught by main)."
        },
        {
          "name": "tokenize",
          "params": ["text: string"],
          "returns": "string[]",
          "description": "Converts text to lowercase, replaces all non-word characters (\\W) with spaces, splits on whitespace, filters out empty strings and words with length < 3. Returns array of qualifying words."
        },
        {
          "name": "countWords",
          "params": ["words: string[]"],
          "returns": "Map<string, number>",
          "description": "Iterates over words array, incrementing count in a Map for each word. Returns Map of word frequencies."
        },
        {
          "name": "sortAndLimit",
          "params": ["countMap: Map<string, number>", "limit: number"],
          "returns": "[string, number][]",
          "description": "Converts Map entries to array, sorts by (1) count descending, (2) word ascending (localeCompare). Slices to first limit entries. Returns sorted, limited array of tuples."
        },
        {
          "name": "formatOutput",
          "params": ["pairs: [string, number][]"],
          "returns": "string",
          "description": "Maps each [word, count] tuple to '${word} ${count}', joins with '\\n'. Returns formatted string with NO trailing newline. If pairs is empty, returns empty string."
        },
        {
          "name": "main",
          "params": [],
          "returns": "void",
          "description": "Orchestrates workflow: calls parseArgs(process.argv.slice(2)), wraps file operations in try-catch, calls other functions in sequence, writes result to process.stdout, handles errors by writing to process.stderr and calling process.exit(1). On success, exits naturally (code 0)."
        }
      ],
      "behavior": {
        "argumentParsing": "Default limit=10; non-numeric/negative/zero → limit=10, optional stderr warning. Missing file path → usage message to stderr, exit 1.",
        "fileReading": "Synchronous read via fs.readFileSync(filePath, 'utf8'). Throws if file missing/unreadable; caught in main → stderr message 'Error: Cannot read file <filePath>: <error.message>', exit 1.",
        "tokenization": "Lowercase, replace non-word characters (\\W, includes apostrophes/punctuation) with space, split on whitespace, filter length≥3.",
        "counting": "Case-insensitive Map increment (word is already lowercase from tokenize).",
        "sorting": "Descending count (a[1] - b[1], reversed for descending), then ascending word (a[0].localeCompare(b[0]) for ties).",
        "outputFormat": "Each line: '${word} ${count}' separated by '\\n', no trailing newline. Empty result → empty string.",
        "edgeCases": [
          "Missing/unreadable file → error message to stderr, exit 1",
          "Empty file or no qualifying words → no output (empty string), exit 0",
          "Words <3 chars ignored during tokenization",
          "Punctuation stripped; apostrophe treated as separator (e.g., don't → don + t)",
          "Case-insensitive counting (Hello/hello/HELLO all count as hello)",
          "Tie-frequency sorted alphabetically ascending",
          "N > distinct words → return all distinct words sorted",
          "Invalid N (non-numeric/negative/zero) → fallback to 10, optional stderr warning"
        ]
      }
    },
    {
      "name": "test.js",
      "type": "script",
      "dependencies": ["fs", "child_process"],
      "fixture": "Hello, hello! HELLO? world... World; test-test test. foo bar baz baz qux.\\na an the and or but nor for yet so.\\n",
      "expectedOutputDefault": [
        "hello 3",
        "baz 2",
        "test 2",
        "world 2",
        "and 1",
        "bar 1",
        "but 1",
        "foo 1",
        "for 1",
        "nor 1"
      ],
      "expectedOutputCustomN3": [
        "hello 3",
        "baz 2",
        "test 2"
      ],
      "procedure": [
        "Import core modules: fs, child_process (spawn)",
        "Define fixture content as string constant (see fixture field above)",
        "Define expected output as array of strings (see expectedOutputDefault above)",
        "Write fixture to 'fixture.txt' via fs.writeFileSync('fixture.txt', fixtureContent, 'utf8')",
        "Spawn 'node wordfreq.js fixture.txt' using child_process.spawn with options {stdio: ['ignore', 'pipe', 'pipe']}",
        "Collect stdout and stderr data from spawned process (set encoding 'utf8' or convert from buffer)",
        "Wait for 'close' event with exit code",
        "If exit code !== 0 → fail with reason 'non-zero exit code'",
        "If stderr.length > 0 → fail with reason 'stderr output: <stderr content>'",
        "Normalize stdout: stdout.trimEnd().split(/\\r?\\n/)",
        "Compare normalized stdout array to expectedOutputDefault array (length and element-by-element)",
        "If mismatch → fail with reason 'wrong output'",
        "If all checks pass → console.log('ALL TESTS PASS'); process.exit(0)",
        "Optional: repeat with custom N=3 (spawn 'node wordfreq.js fixture.txt 3'), compare to expectedOutputCustomN3",
        "Optional cleanup: fs.unlinkSync('fixture.txt') after validation"
      ],
      "passMessage": "ALL TESTS PASS",
      "failMessage": "TEST FAILED: <reason>",
      "exitCodes": {
        "pass": 0,
        "fail": 1
      }
    }
  ],
  "acceptanceCriteria": [
    "wordfreq.js uses only Node core modules (fs, process, no external dependencies).",
    "test.js is self-contained; creates its own fixture and cleans up after.",
    "Test prints exactly 'ALL TESTS PASS' on success and exits 0.",
    "Test prints 'TEST FAILED: <reason>' on any failure and exits 1.",
    "All edge cases from the decision summary are addressed in wordfreq.js implementation.",
    "The plan contains sufficient detail (function signatures, behavior descriptions, expected outputs) for another developer to implement both files without additional design decisions.",
    "Output format is 'word count' per line, sorted by count descending then word ascending, no trailing newline.",
    "Default N=10; invalid N falls back to 10.",
    "Words shorter than 3 characters are ignored.",
    "Punctuation is stripped; apostrophes treated as separators.",
    "Case-insensitive counting (all variants of 'hello' count together)."
  ]
}
```

---
