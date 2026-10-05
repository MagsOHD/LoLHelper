// Small per-browser conveniences only. Every access is guarded: storage may be unavailable.
export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`lolhelper:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) window.localStorage.removeItem(`lolhelper:${key}`);
    else window.localStorage.setItem(`lolhelper:${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
