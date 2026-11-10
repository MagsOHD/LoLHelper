import { useChampionMap, useThemeLabels } from '../../api/hooks';
import type { BanAdvice, DraftAllySlot, EnemyDraftAnalysis, Player, PlayerPickAdvice } from '../../api/types';
import { Avatar, ChampionAvatar } from '../ChampionAvatar';
import { DamageProfile } from '../GamePlanView';
import { BulletList, Chip, Pips, RoleBadge } from '../ui';

function ScorePill({ score }: { score: number }) {
  const v = Math.round(Math.max(0, Math.min(100, score)));
  const tone = v >= 75 ? 'high' : v >= 55 ? 'mid' : 'low';
  return (
    <span className={`score-pill score-pill--${tone}`} role="img" aria-label={`Score ${v} sur 100`}>
      {v}
    </span>
  );
}

export function PickAdviceCard({ advice, player, slot, onChoose }: {
  advice: PlayerPickAdvice;
  player: Player | undefined;
  slot: DraftAllySlot | undefined;
  onChoose: (championId: string) => void;
}) {
  const champs = useChampionMap();
  const name = player?.game_name ?? 'Joueur';
  const locked = advice.locked_champion_id ?? (slot?.locked ? slot.champion_id : null);
  const hovered = !slot?.locked ? slot?.champion_id ?? null : null;
  const headingId = `advice-${advice.player_id}`;
  return (
    <article className={`card advice ${locked ? 'advice--done' : ''}`} aria-labelledby={headingId}>
      <header className="advice__head">
        <Avatar src={player?.profile_icon_url} name={name} size={34} round />
        <h3 id={headingId} className="advice__name">{name}</h3>
        {advice.role ? <RoleBadge role={advice.role} /> : <Chip tone="muted">Rôle à définir</Chip>}
      </header>
      {locked ? (
        <p className="advice__locked">
          <ChampionAvatar champion={champs.get(locked)} id={locked} size={28} showName />
          <Chip tone="green">Verrouillé</Chip>
        </p>
      ) : advice.picks.length === 0 ? (
        <p className="muted small">Pas de recommandation pour l’instant.</p>
      ) : (
        <ol className="recs">
          {advice.picks.map((p, i) => {
            const c = champs.get(p.champion_id);
            const isHover = hovered === p.champion_id;
            return (
              <li key={p.champion_id} className={`rec ${i === 0 ? 'rec--best' : ''} ${isHover ? 'rec--hover' : ''}`}>
                <ChampionAvatar champion={c} id={p.champion_id} size={42} />
                <div className="rec__main">
                  <div className="rec__title">
                    <strong>{c?.name ?? p.champion_id}</strong>
                    <ScorePill score={p.score} />
                  </div>
                  {p.reasons.length > 0 && (
                    <ul className="rec__reasons">
                      {p.reasons.slice(0, 3).map((r, j) => <li key={j}>{r}</li>)}
                    </ul>
                  )}
                </div>
                <button
                  type="button"
                  className={`btn btn--sm ${isHover ? 'btn--ghost' : i === 0 ? 'btn--primary' : 'btn--ghost'} rec__btn`}
                  onClick={() => onChoose(p.champion_id)}
                  aria-pressed={isHover}
                  aria-label={isHover ? `${c?.name ?? p.champion_id} déjà en survol pour ${name}` : `Choisir ${c?.name ?? p.champion_id} pour ${name}`}
                >
                  {isHover ? 'En survol' : 'Choisir'}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}

export function BanAdviceCard({ bans, canBan, onBan }: { bans: BanAdvice[]; canBan: boolean; onBan: (championId: string) => void }) {
  const champs = useChampionMap();
  return (
    <section className="card" aria-labelledby="ban-advice">
      <h3 id="ban-advice" className="card__title">Bans conseillés</h3>
      {bans.length === 0 ? <p className="muted small">Aucun ban particulier à conseiller.</p> : (
        <ul className="ban-advice">
          {bans.map((b) => {
            const name = champs.get(b.champion_id)?.name ?? b.champion_id;
            return (
              <li key={b.champion_id} className="ban-advice__item">
                <ChampionAvatar champion={champs.get(b.champion_id)} id={b.champion_id} size={36} />
                <div className="ban-advice__main">
                  <strong>{name}</strong>
                  <p className="small muted">{b.why}</p>
                </div>
                {canBan && (
                  <button type="button" className="btn btn--danger btn--sm" onClick={() => onBan(b.champion_id)} aria-label={`Bannir ${name}`}>
                    Bannir
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function EnemyAnalysisCard({ analysis }: { analysis: EnemyDraftAnalysis | null }) {
  const champs = useChampionMap();
  const themeLabel = useThemeLabels();
  return (
    <section className="card card--enemy" aria-labelledby="enemy-analysis">
      <h3 id="enemy-analysis" className="card__title">Lecture de l’équipe adverse</h3>
      {!analysis ? (
        <p className="muted small">Ajoute un champion adverse pour voir leurs forces, faiblesses et menaces.</p>
      ) : (
        <div className="stack">
          <p className="plan__identity">{analysis.identity}</p>
          {analysis.themes.length > 0 && (
            <div className="chips" aria-label="Thèmes adverses">{analysis.themes.map((t) => <Chip key={t} tone="red">{themeLabel(t)}</Chip>)}</div>
          )}
          <div className="enemy-sw">
            <div>
              <h4 className="sub">Forces</h4>
              <BulletList items={analysis.strengths} tone="green" />
            </div>
            <div>
              <h4 className="sub">Faiblesses</h4>
              <BulletList items={analysis.weaknesses} tone="amber" />
            </div>
          </div>
          {analysis.win_conditions.length > 0 && (
            <div>
              <h4 className="sub">Leurs conditions de victoire</h4>
              <BulletList items={analysis.win_conditions} />
            </div>
          )}
          {analysis.threats.length > 0 && (
            <div>
              <h4 className="sub">Menaces</h4>
              <ul className="threats">
                {[...analysis.threats].sort((a, b) => b.danger - a.danger).map((t) => (
                  <li key={t.champion_id} className="threat">
                    <div className="threat__head">
                      <ChampionAvatar champion={champs.get(t.champion_id)} id={t.champion_id} size={32} showName />
                      <Pips value={t.danger} label="Danger" />
                    </div>
                    <p><strong>Pourquoi :</strong> {t.why}</p>
                    <p><strong>Comment gérer :</strong> {t.how_to_handle}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Object.values(analysis.damage_profile).some((v) => (v ?? 0) > 0) && (
            <div>
              <h4 className="sub">Profil de dégâts</h4>
              <DamageProfile profile={analysis.damage_profile as Record<string, number>} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
