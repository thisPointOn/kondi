# API Reference (Command-Line Interface)

## Synopsis
```
node wordfreq.js <input-file> [N]
```

### Arguments
| Position | Name      | Type   | Required | Description                                                                 |
|----------|-----------|--------|----------|-----------------------------------------------------------------------------|
| 1        | input-file| string | yes      | Path to the text file to process.                                           |
| 2        | N         | integer| no       | Number of top-frequency words to display. Default = 10. Must be a positive integer. |

### Environment
- No environment variables are consulted.

### Exit Codes
| Code | Meaning                                                               |
|------|-----------------------------------------------------------------------|
| 0    | Successful execution; output printed to stdout.                       |
| 1    | Unable to read the input file (fs error) OR invalid N argument. Message printed to stderr. |

### Defaults
- If `N` is omitted → `10` (source line 18).  
- Minimum word length after processing → `3` (source line 64: `.filter(word => word.length >= 3)`).  
- Case-folding → `toLowerCase()` (source line 59).  

### Stdout Format
Each line: `<word> <count>` (single word, space, integer count). No trailing spaces, no header/footer lines (source lines 119-120: `` `${word} ${count}` ``).

### Stderr
Used only for error messages (file-open failures at lines 42-44, or invalid N at line 23). No diagnostic output during normal operation.
