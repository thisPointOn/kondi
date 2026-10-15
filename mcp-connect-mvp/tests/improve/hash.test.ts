import { describe, it, expect } from 'vitest';
import { hashString, hashValue, stableStringify, newRunId } from '../../src/improve/hash';

describe('improve/hash', () => {
  it('hashString is deterministic and 8 hex chars', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('hashValue ignores key order and undefined values', () => {
    expect(hashValue({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashValue({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(hashValue({ a: 1, b: undefined })).toBe(hashValue({ a: 1 }));
    expect(stableStringify({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it('newRunId is sortable by time and unique', () => {
    const a = newRunId(new Date('2026-10-15T09:30:12.123Z'));
    const b = newRunId(new Date('2026-10-15T09:30:13.000Z'));
    expect(a.startsWith('2026-10-15T09:30:12Z-')).toBe(true);
    expect(a < b).toBe(true);
    expect(newRunId()).not.toBe(newRunId());
  });
});
