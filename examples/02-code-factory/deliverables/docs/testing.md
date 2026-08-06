# Test Harness Explanation

## Overview
`test.js` is a self-contained script that:
1. Builds temporary fixture files with known sample texts.  
2. Executes `wordfreq.js` on each fixture with various `N` values.  
3. Compares the actual stdout to pre-computed expected output.  
4. Prints a summary; on complete success it prints:
   ```
   ALL TESTS PASS
   ```

## Fixture Generation
- The script creates multiple test files dynamically (lines 18-19, 176-177, 215-216, 233-234):
  1. **fixture.txt** – contains repeated words with mixed case and punctuation (lines 7-11: "The quick brown fox jumps..." fixture content).  
  2. **empty.txt** – zero-byte file (line 177).  
  3. **short.txt** – file with only short words < 3 characters (line 216).  
  4. **punct.txt** – mixed case and punctuation test (line 234).

Each fixture's content is hard-coded in `test.js`; you can inspect the source to see the exact strings.

## Test Cases
The harness runs 9 distinct test cases (lines 92-263):

1. **Test 1 (lines 98-120)**: Default call with no N argument → expects top 10 words.  
2. **Test 2 (lines 122-140)**: Explicit N=5 → expects top 5 words.  
3. **Test 3 (lines 142-158)**: N=3 to test tie-breaking (when "fox" and "quick" both have count 4, alphabetical order applies).  
4. **Test 4 (lines 160-173)**: N=100 (exceeds distinct word count) → should return all words sorted correctly.  
5. **Test 5 (lines 175-191)**: Empty file → expects empty output.  
6. **Test 6 (lines 193-204)**: Missing file (nonexistent.txt) → expects exit code 1 and error message.  
7. **Test 7 (lines 206-213)**: Invalid N argument ('invalid') → expects exit code 1.  
8. **Test 8 (lines 215-230)**: File with only short words → expects empty output (all words filtered).  
9. **Test 9 (lines 232-251)**: Punctuation and case handling → validates normalization.

For each run, the harness:
- Spawns `node wordfreq.js` as a child process (lines 40-60: `runWordfreq()` function using `spawn`).  
- Captures stdout and stderr (lines 48-54).  
- Validates exit code and output lines (lines 63-87: `validateTest()` function).

## Success Criteria
- Every line must match exactly (same word, same count, same order) – line-by-line comparison at lines 78-84.  
- No extra output (e.g., warnings) may appear on stdout; stderr is checked for error messages in failure cases.  
- The process exit code must be `0` for successful runs, `1` for error cases (checked at lines 112, 132, 150, 162, 179, 195, 207, 218, 240).

## Interpreting Output
- If the script prints `ALL TESTS PASS` (line 254), **all** assertions succeeded.  
- Any deviation (missing line, mismatched content, or wrong exit code) causes the script to print a detailed failure message (lines 73-84: `TEST FAILED: <name> - <reason>`) and exit with code 1 (lines 114, 118, 134, etc.).

## Verification Note
The test suite validates the complete behavior specification:
- Tokenization and punctuation handling (test 9)
- Case normalization (test 9)
- Word length filtering (test 8)
- Frequency counting and sorting (tests 1-4)
- Tie-breaking alphabetical order (test 3)
- Edge cases: empty files (test 5), missing files (test 6), invalid arguments (test 7)
- Output format consistency (all tests)
