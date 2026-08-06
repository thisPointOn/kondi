# Usage Guide

## Basic Invocation
```
node wordfreq.js <file> [N]
```

## Default Behavior
When `N` is omitted, the utility prints the ten most frequent words.

## Specifying N
Provide a positive integer to change the number of results:
- `node wordfreq.js file.txt 5` → top 5 words  
- `node wordfreq.js file.txt 1` → just the most frequent word  

## Input Requirements
- The file must be readable and UTF-8 encoded.  
- Non-text bytes are treated as part of tokens and will be converted to spaces by the non-alphanumeric character removal; undefined behavior for non-UTF-8 is not specified in the source.

## Output Format
Each line: `<word> <count>` (single space separator).  
Lines are ordered per the sorting rules described in `behavior.md`.

## Error Conditions
- If the file cannot be opened, the process exits with code 1 and prints an error to stderr (source lines 40-46: file read error handling via try/catch).  
- If `N` is not a valid positive integer, the utility exits with error code 1 and prints "Error: N must be a positive integer" (source lines 22-25).  

## Examples
See `README.md` for quick examples; additional varied cases:
- Text with mixed case and punctuation: `"Hello, world! Hello..."` → `hello 2` `world 1`  
- Words shorter than 3 letters (`a`, `an`, `it`) are omitted.  
- Hyphenated words like `"well-known"` become `"wellknown"` after punctuation removal (the hyphen is treated as non-alphanumeric and replaced with space, then split).
