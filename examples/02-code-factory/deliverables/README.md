# Word Frequency Utility

## Purpose
A command-line tool that reads a text file, counts word frequencies, and outputs the top N most frequent words.

## Prerequisites
- Node.js ≥ 12.0.0 (tested with the version used in the verification run)

## Installation
No installation steps are required; the utility consists of the single file `wordfreq.js`.

## Usage
```
node wordfreq.js <input-file> [N]
```
- `<input-file>`: Path to a UTF-8 text file to analyse.  
- `[N]`: Optional integer specifying how many top-frequency words to display. If omitted, the default is **10**.

### Examples
```
# Show the top 10 words in essay.txt
node wordfreq.js essay.txt

# Show the top 5 words in essay.txt
node wordfreq.js essay.txt 5
```

## Behavior (derived from source)
- **Tokenisation**: Converts text to lowercase, then replaces all non-alphanumeric characters (except spaces) with spaces, and splits on whitespace.  
- **Normalization**: All characters are converted to lower-case (case-insensitive counting).  
- **Filtering**: Discards tokens whose length is less than 3 characters.  
- **Counting**: Tallies occurrences of each remaining token.  
- **Sorting**: Primary sort by descending frequency; secondary sort by ascending alphabetical order of the token.  
- **Output**: Prints each selected word and its count, one per line, separated by a single space (`word count`).  

## Running the Test Suite
Execute the bundled test script:
```
node test.js
```
Expected output:
```
ALL TESTS PASS
```
If any line differs, the implementation does not match the verified behavior.

## Further Documentation
Detailed reference material is available in the `docs/` directory:
- `usage.md` – expanded usage guide with varied examples  
- `api.md` – command-line interface reference, arguments, defaults, exit codes  
- `behavior.md` – precise definition of tokenisation, normalization, counting, and sorting rules  
- `testing.md` – step-by-step explanation of how `test.js` validates `wordfreq.js`
