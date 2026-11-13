import { useId } from 'react';
import type { MetaTier } from '../../api/types';
import { META_TIERS } from '../../api/types';
import {
  describeAdviceTier,
  formatWindow,
  tierLabel,
  TIER_ENOUGH_GAMES,
  type AdviceTierChoice,
  type MetaTierProgress,
  type MetaWindow,
} from '../../api/metaRank';
import { fmtInt } from './format';

/** "12 oct., 14:05" (short, the year is implied). */
function shortDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function TierOption({ p, name, checked, advice, onSelect }: {
  p: MetaTierProgress;
  name: string;
  checked: boolean;
  advice: boolean;
  onSelect: (t: MetaTier) => void;
}) {
  const target = p.target || p.games || 1;
  const ratio = Math.max(0, Math.min(1, p.games / target));
  const few = p.games < TIER_ENOUGH_GAMES;
  const date = shortDate(p.newest);
  return (
    <label className={`rtier__opt${checked ? ' is-on' : ''}${few ? ' is-few' : ''}`}>
      <input type="radio" name={name} value={p.tier} checked={checked} onChange={() => onSelect(p.tier)} className="rtier__radio" />
      <span className="rtier__top">
        <span className="rtier__name">{tierLabel(p.tier)}</span>
        {advice && <span className="rtier__badge" title="Niveau utilisé par la génération et la draft">conseils</span>}
      </span>
      <span className="rtier__bar" aria-hidden="true"><span style={{ width: `${Math.round(ratio * 100)}%` }} /></span>
      <span className="rtier__count">
        {fmtInt(p.games)}{p.target ? ` / ${fmtInt(p.target)}` : ''}<span className="sr-only"> parties</span>
      </span>
      <span className="rtier__date">
        {date ? <><span className="sr-only">Dernière partie : </span>{date}</> : 'aucune partie'}
      </span>
    </label>
  );
}

/**
 * Rank levels of the meta: which one is shown (radio cards with the collector's progress per tier),
 * which one guides the advice (automatic or chosen), and the automatic collection hours.
 */
export function RankTierPanel({ tiers, hours, view, onView, choice, override, onOverride }: {
  tiers: MetaTierProgress[];
  hours: MetaWindow | null;
  /** Tier shown below (stats requested with &tier=). */
  view: MetaTier | null;
  onView: (t: MetaTier) => void;
  /** Tier used by the advice for every friend (null while loading). */
  choice: AdviceTierChoice | null;
  override: MetaTier | null;
  onOverride: (t: MetaTier | null) => void;
}) {
  const id = useId();
  const adviceTier = choice?.tier ?? null;
  const target = tiers.find((t) => t.target)?.target ?? 0;
  return (
    <section className="card rtier" aria-labelledby={`${id}-title`}>
      <div className="rtier__head">
        <h2 id={`${id}-title`} className="rtier__title">Niveaux</h2>
        {hours && (
          <p className={`rtier__window${hours.open ? ' is-open' : ''}`}>
            <span aria-hidden="true" className="rtier__dot" />
            {formatWindow(hours)}
            <span className="rtier__window-state"> · {hours.open ? 'en cours de plage' : 'hors plage en ce moment'}</span>
          </p>
        )}
      </div>
      <fieldset className="fieldset">
        <legend className="field__label">
          Niveau affiché{target ? <span className="rtier__legend-hint"> — les {fmtInt(target)} dernières parties du patch par niveau</span> : null}
        </legend>
        <div className="rtier__grid">
          {tiers.map((p) => (
            <TierOption key={p.tier} p={p} name={`${id}-view`} checked={view === p.tier} advice={adviceTier === p.tier} onSelect={onView} />
          ))}
        </div>
      </fieldset>
      <div className="rtier__advice">
        <div className="field rtier__advice-field">
          <label className="field__label" htmlFor={`${id}-advice`}>Niveau utilisé pour les conseils</label>
          <select
            id={`${id}-advice`}
            className="input"
            value={override ?? ''}
            onChange={(e) => onOverride((e.target.value || null) as MetaTier | null)}
            aria-describedby={`${id}-advice-hint`}
          >
            <option value="">Automatique{choice ? ` (${tierLabel(choice.auto)})` : ''}</option>
            {META_TIERS.map((t) => <option key={t} value={t}>{tierLabel(t)}</option>)}
          </select>
        </div>
        <p className="hint rtier__advice-hint" id={`${id}-advice-hint`}>
          {choice ? `${describeAdviceTier(choice)} ` : ''}
          En automatique, la génération prend le rang solo médian des joueurs sélectionnés et la draft celui des amis de la draft
          (non classés ignorés). Un niveau avec moins de {TIER_ENOUGH_GAMES} parties cède la place au niveau voisin le plus fourni.
          Choix gardé sur cet appareil.
        </p>
      </div>
    </section>
  );
}
