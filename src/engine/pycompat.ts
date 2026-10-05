// Helpers reproducing Python semantics the engine relies on (rounding, truthiness, int(), sorting).

/**
 * Python `round(x, ndigits)`: correctly rounded on the exact binary value, ties to even.
 * (`Number.prototype.toFixed` is exact too but breaks ties upwards.)
 */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const a = Math.abs(x);
  if (a >= 1e21) return x;
  const s = pyFixedAbs(a, ndigits);
  const r = parseFloat(s);
  return neg ? -r : r;
}

/** Python `f"{x:.{n}f}"` (round half to even on the exact value). */
export function pyFixed(x: number, ndigits: number): string {
  if (!Number.isFinite(x)) return String(x);
  const neg = x < 0 || Object.is(x, -0);
  const s = pyFixedAbs(Math.abs(x), ndigits);
  return neg ? `-${s}` : s;
}

function pyFixedAbs(a: number, ndigits: number): string {
  const rounded = a.toFixed(ndigits);
  // exact decimal expansion (enough digits for every double >= 2**-48)
  const full = a.toFixed(100);
  const dot = full.indexOf('.');
  const keptEnd = ndigits > 0 ? dot + 1 + ndigits : dot;
  const rest = full.slice(dot + 1 + ndigits);
  if (rest[0] === '5' && /^50*$/.test(rest)) {
    const kept = full.slice(0, keptEnd);
    const last = kept.charCodeAt(kept.length - 1) - 48;
    if (last % 2 === 0) return kept; // tie: keep the even digit
  }
  return rounded;
}

/** Python `int(v)` for the values found in JSON data; null when Python would raise. */
export function pyInt(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^[+-]?\d+(_\d+)*$/.test(s)) return parseInt(s.replace(/_/g, ''), 10);
  }
  return null;
}

/** Python truthiness of a JSON value. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/** Python `str(v)` for simple JSON values. */
export function pyStr(v: unknown): string {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null || v === undefined) return 'None';
  return String(v);
}

export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Python `sum()` of numbers (plain left-to-right addition, as in CPython 3.11). */
export function pySum(values: Iterable<number>): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}
