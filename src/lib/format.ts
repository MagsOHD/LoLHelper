import type { Rank, Role } from '../api/types';

export const ROLE_SHORT: Record<Role, string> = {
  TOP: 'TOP',
  JUNGLE: 'JGL',
  MID: 'MID',
  BOTTOM: 'ADC',
  SUPPORT: 'SUP',
};

export const ROLE_LABEL: Record<Role, string> = {
  TOP: 'Haut (Top)',
  JUNGLE: 'Jungle',
  MID: 'Milieu (Mid)',
  BOTTOM: 'Tireur (ADC)',
  SUPPORT: 'Support',
};

const TIERS: Record<string, string> = {
  IRON: 'Fer', BRONZE: 'Bronze', SILVER: 'Argent', GOLD: 'Or', PLATINUM: 'Platine', EMERALD: 'Émeraude',
  DIAMOND: 'Diamant', MASTER: 'Maître', GRANDMASTER: 'Grand Maître', CHALLENGER: 'Challenger',
};

export function formatRank(rank: Rank | null): string {
  if (!rank) return 'Non classé';
  const tier = TIERS[rank.tier] ?? rank.tier;
  const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rank.tier);
  return `${tier}${apex ? '' : ` ${rank.division}`} · ${rank.lp} LP`;
}

export function riotId(p: { game_name: string; tag_line: string }): string {
  return `${p.game_name}#${p.tag_line}`;
}

/** Split "Name#TAG" on the LAST '#'. Returns null when invalid. */
export function parseRiotId(input: string): { game_name: string; tag_line: string } | null {
  const s = input.trim();
  const i = s.lastIndexOf('#');
  if (i <= 0 || i === s.length - 1) return null;
  const game_name = s.slice(0, i).trim();
  const tag_line = s.slice(i + 1).trim();
  if (!game_name || !tag_line) return null;
  return { game_name, tag_line };
}

export function pct(v: number): string {
  return `${Math.round(v * 100)} %`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'jamais';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function initials(name: string): string {
  const parts = name.replace(/['’.]/g, '').split(/[\s-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Accent/case-insensitive normalisation for search. */
export function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export const PHASE_LABEL: Record<string, string> = { early: 'Début de partie', mid: 'Milieu de partie', late: 'Fin de partie' };
export const SOURCE_LABEL: Record<string, string> = { mastery: 'Maîtrise', recent: 'Récent', manual: 'Manuel', wanted: 'Envie' };
