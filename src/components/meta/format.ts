// French number formatting for the Meta page.
export const fmtInt = (n: number): string => Math.round(n).toLocaleString('fr-FR');

/** 0.5234 -> "52,3 %" (one decimal; "0 %" for exact zero). */
export function fmtPct(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0 %';
  return `${(v * 100).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}
