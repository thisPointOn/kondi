#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Test fixture content
const FIXTURE_CONTENT = `The quick brown fox jumps over the lazy dog.
The dog was not really lazy, it was just resting.
The fox was very quick and brown.
Quick! Quick! said the fox.
I am a fox. You are a dog.`;

const FIXTURE_FILE = 'fixture.txt';

/**
 * Create test fixture
 */
function createFixture() {
  fs.writeFileSync(FIXTURE_FILE, FIXTURE_CONTENT, 'utf8');
}

/**
 * Clean up test fixture
 */
function cleanup() {
  try {
    if (fs.existsSync(FIXTURE_FILE)) {
      fs.unlinkSync(FIXTURE_FILE);
    }
  } catch (err) {
    console.error(`Warning: Could not clean up ${FIXTURE_FILE}: ${err.message}`);
  }
}

/**
 * Run wordfreq.js with given arguments
 * @param {string[]} args
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function runWordfreq(args) {
  return new Promise((resolve) => {
    const wordfreqPath = path.join(__dirname, 'wordfreq.js');
    const child = spawn('node', [wordfreqPath, ...args]);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Validate test result
 * @param {string} name
 * @param {string[]} expected
 * @param {string} actual
 * @returns {boolean}
 */
function validateTest(name, expected, actual) {
  const actualLines = actual ? actual.split('\n') : [];

  if (actualLines.length !== expected.length) {
    console.error(`TEST FAILED: ${name} - Expected ${expected.length} lines, got ${actualLines.length}`);
    return false;
  }

  for (let i = 0; i < expected.length; i++) {
    if (actualLines[i] !== expected[i]) {
      console.error(`TEST FAILED: ${name} - Line ${i + 1} mismatch`);
      console.error(`  Expected: "${expected[i]}"`);
      console.error(`  Got:      "${actualLines[i]}"`);
      return false;
    }
  }

  return true;
}

/**
 * Main test runner
 */
async function main() {
  try {
    // Create fixture
    createFixture();

    // Test 1: Default (top 10)
    const expected1 = [
      'the 5',
      'fox 4',
      'quick 4',
      'dog 3',
      'was 3',
      'brown 2',
      'lazy 2',
      'and 1',
      'are 1',
      'jumps 1'
    ];

    const result1 = await runWordfreq([FIXTURE_FILE]);
    if (result1.code !== 0) {
      console.error('TEST FAILED: Default test - Non-zero exit code');
      cleanup();
      process.exit(1);
    }
    if (!validateTest('Default (top 10)', expected1, result1.stdout)) {
      cleanup();
      process.exit(1);
    }

    // Test 2: Top 5
    const expected2 = [
      'the 5',
      'fox 4',
      'quick 4',
      'dog 3',
      'was 3'
    ];

    const result2 = await runWordfreq([FIXTURE_FILE, '5']);
    if (result2.code !== 0) {
      console.error('TEST FAILED: Top 5 test - Non-zero exit code');
      cleanup();
      process.exit(1);
    }
    if (!validateTest('Top 5', expected2, result2.stdout)) {
      cleanup();
      process.exit(1);
    }

    // Test 3: Top 3 (tests tie-breaking)
    const expected3 = [
      'the 5',
      'fox 4',
      'quick 4'
    ];

    const result3 = await runWordfreq([FIXTURE_FILE, '3']);
    if (result3.code !== 0) {
      console.error('TEST FAILED: Top 3 test - Non-zero exit code');
      cleanup();
      process.exit(1);
    }
    if (!validateTest('Top 3 (tie-breaking)', expected3, result3.stdout)) {
      cleanup();
      process.exit(1);
    }

    // Test 4: N exceeding distinct word count
    const result4 = await runWordfreq([FIXTURE_FILE, '100']);
    if (result4.code !== 0) {
      console.error('TEST FAILED: Large N test - Non-zero exit code');
      cleanup();
      process.exit(1);
    }
    // Should just return all words sorted
    const lines4 = result4.stdout.split('\n');
    if (lines4.length < 10 || lines4[0] !== 'the 5') {
      console.error('TEST FAILED: Large N test - Output mismatch');
      cleanup();
      process.exit(1);
    }

    // Test 5: Empty file
    const emptyFile = 'empty.txt';
    fs.writeFileSync(emptyFile, '', 'utf8');
    const result5 = await runWordfreq([emptyFile]);
    if (result5.code !== 0) {
      console.error('TEST FAILED: Empty file test - Non-zero exit code');
      fs.unlinkSync(emptyFile);
      cleanup();
      process.exit(1);
    }
    if (result5.stdout !== '') {
      console.error('TEST FAILED: Empty file test - Expected empty output');
      fs.unlinkSync(emptyFile);
      cleanup();
      process.exit(1);
    }
    fs.unlinkSync(emptyFile);

    // Test 6: Missing file (should exit with error)
    const result6 = await runWordfreq(['nonexistent.txt']);
    if (result6.code === 0) {
      console.error('TEST FAILED: Missing file test - Expected non-zero exit code');
      cleanup();
      process.exit(1);
    }
    if (!result6.stderr.includes('not found') && !result6.stderr.includes('ENOENT')) {
      console.error('TEST FAILED: Missing file test - Expected error message');
      cleanup();
      process.exit(1);
    }

    // Test 7: Invalid N (should exit with error)
    const result7 = await runWordfreq([FIXTURE_FILE, 'invalid']);
    if (result7.code === 0) {
      console.error('TEST FAILED: Invalid N test - Expected non-zero exit code');
      cleanup();
      process.exit(1);
    }

    // Test 8: File with only short words
    const shortFile = 'short.txt';
    fs.writeFileSync(shortFile, 'a ab I am to be or no', 'utf8');
    const result8 = await runWordfreq([shortFile]);
    if (result8.code !== 0) {
      console.error('TEST FAILED: Short words test - Non-zero exit code');
      fs.unlinkSync(shortFile);
      cleanup();
      process.exit(1);
    }
    if (result8.stdout !== '') {
      console.error('TEST FAILED: Short words test - Expected empty output');
      fs.unlinkSync(shortFile);
      cleanup();
      process.exit(1);
    }
    fs.unlinkSync(shortFile);

    // Test 9: Punctuation and case handling
    const punctFile = 'punct.txt';
    fs.writeFileSync(punctFile, 'Hello! HELLO? hello... Hello, world!!! World. world', 'utf8');
    const expected9 = [
      'hello 4',
      'world 3'
    ];
    const result9 = await runWordfreq([punctFile]);
    if (result9.code !== 0) {
      console.error('TEST FAILED: Punctuation test - Non-zero exit code');
      fs.unlinkSync(punctFile);
      cleanup();
      process.exit(1);
    }
    if (!validateTest('Punctuation and case', expected9, result9.stdout)) {
      fs.unlinkSync(punctFile);
      cleanup();
      process.exit(1);
    }
    fs.unlinkSync(punctFile);

    // All tests passed
    console.log('ALL TESTS PASS');
    cleanup();
    process.exit(0);

  } catch (err) {
    console.error(`TEST FAILED: Unexpected error - ${err.message}`);
    cleanup();
    process.exit(1);
  }
}

// Run tests
main();
