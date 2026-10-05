// French typography fixes applied to every sentence the engine produces.

// Python `\b` is Unicode-aware: a boundary means "not preceded by a letter, digit or underscore".
const ELISION = /(?<![\p{L}\p{N}_])([DdLl]e|[Ll]a|[Qq]ue|[Jj]usque) (?=[AEIOUYÉÈÊÂÎÔ])/gu;

/** 'de Amumu' -> "d'Amumu", 'que Ahri' -> "qu'Ahri" (only before capitalized vowel words). */
export function elide(text: string): string {
  return text.replace(ELISION, (_m, word: string) => `${word.slice(0, -1)}'`);
}

/** Apply `elide` to every string of a value (arrays and plain objects, recursively). */
export function elideAll<T>(value: T): T {
  if (typeof value === 'string') return elide(value) as T;
  if (Array.isArray(value)) return value.map((v) => elideAll(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = elideAll(v);
    return out as T;
  }
  return value;
}
