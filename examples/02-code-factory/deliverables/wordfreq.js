#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

/**
 * Parse command line arguments
 * @returns {{file: string, n: number}}
 */
function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node wordfreq.js <file> [N]');
    process.exit(1);
  }

  const file = args[0];
  let n = 10; // default

  if (args.length > 1) {
    n = parseInt(args[1], 10);
    if (isNaN(n) || n <= 0) {
      console.error('Error: N must be a positive integer');
      process.exit(1);
    }
  }

  return { file, n };
}

/**
 * Read file synchronously
 * @param {string} filepath
 * @returns {string}
 */
function readFileSync(filepath) {
  try {
    return fs.readFileSync(filepath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`Error: File not found: ${filepath}`);
    } else {
      console.error(`Error reading file: ${err.message}`);
    }
    process.exit(1);
  }
}

/**
 * Tokenize text into words
 * - Strip punctuation
 * - Convert to lowercase
 * - Filter words < 3 characters
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  // Remove all non-alphanumeric characters except spaces, convert to lowercase
  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');

  // Split on whitespace and filter
  return cleaned
    .split(/\s+/)
    .filter(word => word.length >= 3);
}

/**
 * Count word occurrences
 * @param {string[]} words
 * @returns {Map<string, number>}
 */
function countWords(words) {
  const counts = new Map();

  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return counts;
}

/**
 * Sort and limit word counts
 * - Sort by count descending
 * - Then by word ascending (for ties)
 * - Limit to top N
 * @param {Map<string, number>} counts
 * @param {number} n
 * @returns {Array<[string, number]>}
 */
function sortAndLimit(counts, n) {
  const entries = Array.from(counts.entries());

  entries.sort((a, b) => {
    // First by count descending
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    // Then by word ascending
    return a[0].localeCompare(b[0]);
  });

  return entries.slice(0, n);
}

/**
 * Format output
 * - Format: 'word count' per line
 * - No trailing newline
 * @param {Array<[string, number]>} entries
 * @returns {string}
 */
function formatOutput(entries) {
  if (entries.length === 0) {
    return '';
  }

  return entries
    .map(([word, count]) => `${word} ${count}`)
    .join('\n');
}

/**
 * Main entry point
 */
function main() {
  const { file, n } = parseArgs();
  const content = readFileSync(file);
  const words = tokenize(content);
  const counts = countWords(words);
  const topWords = sortAndLimit(counts, n);
  const output = formatOutput(topWords);

  if (output) {
    process.stdout.write(output);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  readFileSync,
  tokenize,
  countWords,
  sortAndLimit,
  formatOutput,
  main
};
