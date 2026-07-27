import { describe, it, expect } from 'vitest';
import { dropPointOverRect } from './agent-sidebar';

// Conformance tests for F-157aa77d — drop-position hit test tolerant of
// physical/logical pixels. Spec-only: asserts the AC behavior, not internals.
const rect = { left: 100, right: 300, top: 50, bottom: 400 };

describe('dropPointOverRect (F-157aa77d)', () => {
  it('returns true when logical position is already inside rect (raw coords inside)', () => {
    expect(dropPointOverRect({ x: 200, y: 100 }, rect, 1)).toBe(true);
  });

  it('returns true when physical position lands inside after dividing by dpr (Retina)', () => {
    // 400/2=200, 200/2=100 inside rect; raw 400 is outside but /dpr lands in
    expect(dropPointOverRect({ x: 400, y: 200 }, rect, 2)).toBe(true);
  });

  it('returns false when outside under both interpretations', () => {
    // 5000 and 2500 both outside
    expect(dropPointOverRect({ x: 5000, y: 5000 }, rect, 2)).toBe(false);
  });

  it('returns false when pos is undefined', () => {
    expect(dropPointOverRect(undefined, rect, 2)).toBe(false);
  });

  it('returns true on inclusive boundary (left/top edge)', () => {
    expect(dropPointOverRect({ x: 100, y: 50 }, rect, 1)).toBe(true);
  });

  it('treats non-positive dpr as 1: raw coords inside still match, no division blow-up', () => {
    expect(dropPointOverRect({ x: 200, y: 100 }, rect, 0)).toBe(true);
    // treated as dpr=1, raw 400 outside, no /0 → false (not NaN/true)
    expect(dropPointOverRect({ x: 400, y: 200 }, rect, 0)).toBe(false);
  });
});
