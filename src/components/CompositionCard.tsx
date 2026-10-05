import type { ChampionInfo, CompositionSuggestion, Player } from '../api/types';
import { riotId } from '../lib/format';
import { ChampionAvatar } from './ChampionAvatar';
import { Bar, BulletList, RoleBadge } from './ui';

function ScoreRing({ score }: { score: number }) {
  const v = Math.max(0, Math.min(100, score));
  return (
    <div className="score" role="img" aria-label={`Score ${Math.round(v)} sur 100`} style={{ ['--p' as string]: `${v}` }}>
      <span className="score__num">{Math.round(v)}</span>
      <span className="score__max">/100</span>
    </div>
  );
}

export function CompositionCard({ suggestion, champions, players, rank, onPlan, onMatchup, onSave }: {
  suggestion: CompositionSuggestion;
  champions: Map<string, ChampionInfo>;
  players: Map<string, Player>;
  rank: number;
  onPlan: () => void;
  onMatchup: () => void;
  onSave: () => void;
}) {
  const b = suggestion.breakdown;
  const breakdown: [string, number | null | undefined][] = [
    ['Confort', b.comfort],
    ['Envie', b.desire],
    ['Thème', b.theme_fit],
    ['Équilibre', b.balance],
    ['Contre', b.counter],
  ];
  return (
    <article className="card comp" aria-labelledby={`comp-${rank}`}>
      <header className="comp__head">
        <div className="comp__title">
          <span className="comp__rank">#{rank}</span>
          <h3 id={`comp-${rank}`}>{suggestion.theme_label}</h3>
        </div>
        <ScoreRing score={suggestion.score} />
      </header>

      <dl className="breakdown">
        {breakdown.filter(([, v]) => v !== null && v !== undefined).map(([label, v]) => (
          <div key={label} className="breakdown__item">
            <dt>{label}</dt>
            <dd>
              <Bar value={(v as number) / 100} label={`${label} : ${Math.round(v as number)} sur 100`} size="sm" tone={label === 'Contre' ? 'red' : 'blue'} />
              <span className="breakdown__val">{Math.round(v as number)}</span>
            </dd>
          </div>
        ))}
      </dl>

      <ul className="picks">
        {suggestion.picks.map((p) => {
          const c = champions.get(p.champion_id);
          const pl = p.player_id ? players.get(p.player_id) : undefined;
          return (
            <li key={`${p.role}-${p.champion_id}`} className="pick">
              <RoleBadge role={p.role} />
              <ChampionAvatar champion={c} id={p.champion_id} size={40} />
              <div className="pick__main">
                <div className="pick__names">
                  <strong>{c?.name ?? p.champion_id}</strong>
                  {pl && <span className="pick__player" title={riotId(pl)}>{pl.game_name}</span>}
                </div>
                {p.reasons.length > 0 && <p className="pick__reasons">{p.reasons.join(' · ')}</p>}
              </div>
              <div className="pick__bars">
                <div className="mini"><span>Confort</span><Bar value={p.comfort} label={`Confort ${Math.round(p.comfort * 100)} %`} size="sm" tone="teal" /></div>
                <div className="mini"><span>Envie</span><Bar value={p.desire} label={`Envie ${Math.round(p.desire * 100)} %`} size="sm" tone="gold" /></div>
              </div>
            </li>
          );
        })}
      </ul>

      {(suggestion.strengths.length > 0 || suggestion.warnings.length > 0) && (
        <div className="comp__notes">
          {suggestion.strengths.length > 0 && <BulletList items={suggestion.strengths} tone="green" />}
          {suggestion.warnings.length > 0 && <BulletList items={suggestion.warnings} tone="amber" />}
        </div>
      )}

      <footer className="comp__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={onPlan}>Plan de jeu</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onMatchup}>Contre une équipe…</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onSave}>Sauvegarder</button>
      </footer>
    </article>
  );
}
