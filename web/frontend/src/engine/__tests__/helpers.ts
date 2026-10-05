// Shared helpers for the engine tests.
import { expect } from 'vitest';

const files = import.meta.glob('../__golden__/*.json', { eager: true, import: 'default' });

/** Golden data produced by the former Python reference engine; the TS engine must keep matching it. */
export function golden<T>(name: string): T {
  const data = files[`../__golden__/${name}.json`];
  if (data === undefined) throw new Error(`missing golden file ${name}`);
  return data as T;
}

/** Deep equality; numbers compared with an absolute tolerance, everything else exactly. */
export function diff(actual: unknown, expected: unknown, path = '$', tol = 1e-6): string | null {
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(actual - expected) <= tol ? null : `${path}: ${actual} != ${expected}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: not an array (${JSON.stringify(actual)})`;
    if (actual.length !== expected.length) {
      return `${path}: length ${actual.length} != ${expected.length}\n  actual=${JSON.stringify(actual)}\n  expected=${JSON.stringify(expected)}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const d = diff(actual[i], expected[i], `${path}[${i}]`, tol);
      if (d) return d;
    }
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return `${path}: not an object`;
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const ka = Object.keys(a).sort();
    const ke = Object.keys(e).sort();
    if (ka.join(',') !== ke.join(',')) return `${path}: keys [${ka}] != [${ke}]`;
    for (const k of ke) {
      const d = diff(a[k], e[k], `${path}.${k}`, tol);
      if (d) return d;
    }
    return null;
  }
  return Object.is(actual, expected) || actual === expected
    ? null
    : `${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`;
}

export function expectMatches(actual: unknown, expected: unknown): void {
  expect(diff(JSON.parse(JSON.stringify(actual)), expected)).toBeNull();
}
