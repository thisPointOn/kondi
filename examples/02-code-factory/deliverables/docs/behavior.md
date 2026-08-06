# Detailed Behavior Specification

## Tokenisation
1. Read the entire file as a UTF-8 string (source line 38: `fs.readFileSync(filepath, 'utf8')`).  
2. Convert to lowercase and replace all non-alphanumeric characters (except spaces) with spaces (source line 59: `text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')`).  
3. Split the cleaned string on whitespace (source line 63: `.split(/\s+/)`).  
4. Internal punctuation (e.g., apostrophes in `can't`) is removed during the global replacement; all non-alphanumeric characters are replaced with spaces.

## Normalization
- Convert all text to lower case using `String.prototype.toLowerCase()` (source line 59).  
- No Unicode normalization (e.g., NFKC) is performed.

## Length Filter
- After splitting, discard tokens whose length `< 3` (source line 64: `.filter(word => word.length >= 3)`).  
- Tokens of length 0, 1, or 2 are ignored entirely.

## Counting
- Increment a Map entry for each remaining token (source lines 75-77: `counts.set(word, (counts.get(word) || 0) + 1)`).  
- The Map key is the normalized token; the value is the occurrence count (integer ≥ 1).

## Sorting (Selection of Top N)
1. Convert the Map to an array of `[token, count]` pairs (source line 92: `Array.from(counts.entries())`).  
2. Sort primarily by **descending** count (source line 97: `b[1] - a[1]`).  
3. For equal counts, sort secondarily by **ascending** lexical order of the token (source line 100: `a[0].localeCompare(b[0])`).  
4. Slice the first `N` elements (source line 103: `entries.slice(0, n)`).  
5. If the array has fewer than `N` elements, the slice yields all available elements.

## Output
- For each pair in the sliced array, write `token + " " + count` to stdout (source line 119: `` `${word} ${count}` ``).  
- Each word-count pair is on its own line (source line 120: `.join('\n')`).  
- If the result is empty (no qualifying words), no output is produced (source lines 114-116 and 134-136).

## Observed Edge Cases (from test output)
- Empty input file → no tokens → no output (test.js lines 176-190).  
- File containing only punctuation or short words → filtered out → no output (test.js lines 215-230).  
- Words with internal apostrophes (e.g., `it's`) have the apostrophe removed (converted to space) during the global replacement, so `it's` becomes `it s` (two tokens, both length 2, both filtered out).  
- Hyphenated words (e.g., `well-known`) have the hyphen replaced with space, becoming two separate tokens `well` and `known`.

All of the above behaviors are directly traceable to lines in `wordfreq.js` (see source for the regular expression at line 59, loops at lines 75-77, and sort function at lines 94-101).
