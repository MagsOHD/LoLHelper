// Enemy information shown during the draft and once the game started: scouting by Riot ID, known
// enemy profiles, likely picks per open role, pick order advice, per-enemy insights and attention
// points. Identities only come from the scouting list, the client (Clash/custom) or the started game.
import { useId, useState, type FormEvent } from 'react';
import { useChampionMap } from '../../api/hooks';
import { overallProgress, type ProfileStatus } from '../../api/enemyProfile';
import { MAX_SCOUTED } from '../../api/draft';
import type {
  ChampionInfo,
  EnemyPlayerInsight,
  EnemyPlayerProfile,
  EnemyProfileSource,
  EnemyRolePrediction,
  PhaseAttention,
  Role,
} from '../../api/types';
import { ROLES } from '../../api/types';
import { formatRank, ROLE_LABEL } from '../../lib/format';
import { ChampionAvatar } from '../ChampionAvatar';
import { BulletList, Chip, RoleBadge, Spinner } from '../ui';

type ChampMap = Map<string, ChampionInfo>;

const SOURCE_LABEL: Record<EnemyProfileSource, string> = { scouting: 'Repéré', client: 'Client', game: 'Partie' };
const SOURCE_TITLE: Record<EnemyProfileSource, string> = {
  scouting: 'Ajouté par Riot ID (repérage)',
  client: 'Révélé par le client (Clash, tournoi ou partie personnalisée)',
  game: 'Connu depuis le début de la partie',
};

const fr1 = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
const pctTxt = (n: number) => `${Math.round(n * 100)} %`;
const kPoints = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function mainRoles(p: EnemyPlayerProfile): Role[] {
  const total = p.recent.games || 0;
  return ROLES.filter((r) => (p.recent.roles[r] ?? 0) > 0)
    .sort((a, b) => (p.recent.roles[b] ?? 0) - (p.recent.roles[a] ?? 0))
    .filter((r, i) => i === 0 || (total > 0 && (p.recent.roles[r] ?? 0) / total >= 0.25))
    .slice(0, 2);
}

/** Top champions: recent games first, then masteries. */
function topChampions(p: EnemyPlayerProfile, n = 4): { id: string; detail: string }[] {
  const out: { id: string; detail: string }[] = [];
  for (const c of p.recent.champions) {
    if (out.length >= n) break;
    out.push({ id: c.champion_id, detail: `${c.games} partie${c.games > 1 ? 's' : ''} récente${c.games > 1 ? 's' : ''}, ${c.wins} victoire${c.wins > 1 ? 's' : ''}` });
  }
  for (const m of p.masteries) {
    if (out.length >= n) break;
    if (!out.some((x) => x.id === m.champion_id)) out.push({ id: m.champion_id, detail: `maîtrise ${m.level}, ${kPoints(m.points)} points` });
  }
  return out;
}

/** "Riot ID", else "Leur jungler (Lee Sin)"-like label; never anything the sources did not give. */
export function enemyLabel(p: { riot_id?: string | null; champion_id?: string | null; role?: Role | null }, champs: ChampMap): string {
  if (p.riot_id) return p.riot_id;
  const champ = p.champion_id ? champs.get(p.champion_id)?.name ?? p.champion_id : null;
  if (champ) return `Joueur de ${champ}`;
  if (p.role) return `Adversaire ${ROLE_LABEL[p.role].toLowerCase()}`;
  return 'Adversaire';
}

function StatLine({ p }: { p: EnemyPlayerProfile }) {
  const s = p.style;
  if (!s) return <p className="small muted">Pas de partie récente sur la Faille.</p>;
  return (
    <dl className="estats" aria-label={`Moyennes sur ${s.games} parties récentes`}>
      <div><dt>KDA</dt><dd>{fr1(s.kills)}/{fr1(s.deaths)}/{fr1(s.assists)}</dd></div>
      <div><dt>CS/min</dt><dd>{fr1(s.cs_per_min)}</dd></div>
      <div><dt>Vision/min</dt><dd>{fr1(s.vision_per_min)}</dd></div>
      <div><dt>Part. kills</dt><dd>{pctTxt(s.kill_participation)}</dd></div>
      <div><dt>1er sang</dt><dd>{pctTxt(s.first_blood_rate)}</dd></div>
      <div><dt>Victoires</dt><dd>{s.wins}/{s.games}</dd></div>
    </dl>
  );
}

/** Compact profile: level, rank, main roles, top champions, style (tags from the engine when known). */
export function EnemyProfileCard({ profile, insight, onRemove }: {
  profile: EnemyPlayerProfile;
  insight?: EnemyPlayerInsight;
  onRemove?: () => void;
}) {
  const champs = useChampionMap();
  const label = enemyLabel({ ...profile, champion_id: insight?.champion_id ?? profile.champion_id }, champs);
  const champ = insight?.champion_id ?? profile.champion_id ?? null;
  const roles = mainRoles(profile);
  const tops = topChampions(profile);
  const headingId = useId();
  return (
    <article className="eprofile" aria-labelledby={headingId}>
      <header className="eprofile__head">
        <div className="eprofile__id">
          <h4 id={headingId} className="eprofile__name">{label}</h4>
          <span className="small muted">
            {profile.summoner_level ? `Niv. ${profile.summoner_level} · ` : ''}{formatRank(profile.rank ?? null)}
          </span>
        </div>
        <span className={`esource esource--${profile.source}`} title={SOURCE_TITLE[profile.source]}>{SOURCE_LABEL[profile.source]}</span>
        {onRemove && (
          <button type="button" className="icon-btn" onClick={onRemove} aria-label={`Retirer ${label} du repérage`}>×</button>
        )}
      </header>
      <div className="eprofile__row">
        {roles.length > 0 ? roles.map((r) => <RoleBadge key={r} role={r} compact />) : <Chip tone="muted">Rôle inconnu</Chip>}
        {champ && (
          <span className="eprofile__now">
            <span className="sr-only">Joue actuellement</span>
            <ChampionAvatar champion={champs.get(champ)} id={champ} size={22} showName />
          </span>
        )}
      </div>
      {tops.length > 0 && (
        <ul className="eprofile__champs" aria-label="Champions favoris">
          {tops.map((t) => (
            <li key={t.id} title={`${champs.get(t.id)?.name ?? t.id} : ${t.detail}`}>
              <ChampionAvatar champion={champs.get(t.id)} id={t.id} size={28} />
              <span className="sr-only">{t.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {insight && insight.style_tags.length > 0 && (
        <div className="chips" aria-label="Style de jeu">{insight.style_tags.map((t) => <Chip key={t} tone="amber">{t}</Chip>)}</div>
      )}
      <StatLine p={profile} />
    </article>
  );
}

function StatusRow({ s, onRetry, onRemove }: { s: ProfileStatus; onRetry: () => void; onRemove: () => void }) {
  const label = s.riot_id ?? 'Adversaire';
  const total = Math.max(s.total, s.calls, 1);
  return (
    <li className={`estatus estatus--${s.state}`}>
      <div className="estatus__main">
        <strong className="estatus__name">{label}</strong>
        {s.state === 'loading' ? (
          <span className="small muted"><Spinner label={`Chargement du profil de ${label}`} /> Appels Riot {s.calls}/{total}</span>
        ) : (
          <span className="small estatus__err">{s.error}</span>
        )}
      </div>
      {s.state === 'loading' ? (
        <div className="estatus__bar" role="progressbar" aria-label={`Profil de ${label}`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={s.calls}>
          <span style={{ width: `${Math.round((s.calls / total) * 100)}%` }} />
        </div>
      ) : (
        <div className="estatus__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>Réessayer</button>
          <button type="button" className="icon-btn" onClick={onRemove} aria-label={`Retirer ${label}`}>×</button>
        </div>
      )}
    </li>
  );
}

/** Global "Appels Riot" progress of the profile builds in flight (never blocks the draft). */
export function RiotProgress({ statuses }: { statuses: ProfileStatus[] }) {
  const p = overallProgress(statuses);
  if (!p.loading) return null;
  return (
    <span className="rprogress" title="Les profils se chargent en arrière-plan : la draft reste utilisable.">
      <Spinner label="Profils adverses en chargement" />
      <span>Profils adverses : {p.calls}/{p.total} appels Riot</span>
    </span>
  );
}

/** "Repérage des adversaires": up to 5 Riot IDs, fetched in the background and shared with the team. */
export function ScoutingPanel({ profiles, statuses, insights, platforms, defaultPlatform, enabled, onScout, onRemove, onRetry }: {
  profiles: EnemyPlayerProfile[];
  statuses: ProfileStatus[];
  insights: EnemyPlayerInsight[];
  platforms: string[];
  defaultPlatform: string;
  enabled: boolean;
  onScout: (riotId: string, platform: string) => string | null;
  onRemove: (puuidOrKey: string) => void;
  onRetry: (key: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [platform, setPlatform] = useState(defaultPlatform);
  const [error, setError] = useState<string | null>(null);
  const pending = statuses.filter((s) => s.source === 'scouting');
  const count = profiles.length + pending.filter((s) => s.state === 'loading').length;
  const full = count >= MAX_SCOUTED;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = onScout(text, platform);
    setError(err);
    if (!err) setText('');
  };
  const byPuuid = new Map(insights.map((i) => [i.puuid, i]));
  const plats = platforms.includes(platform) ? platforms : [platform, ...platforms];
  return (
    <section className="card scouting" aria-labelledby={`${id}-title`}>
      <div className="scouting__head">
        <h2 id={`${id}-title`} className="card__title">Repérage des adversaires</h2>
        <span className="muted small">{count}/{MAX_SCOUTED}</span>
      </div>
      <p className="hint">
        Clash, tournoi ou adversaires connus : entrez leurs Riot ID pour adapter les conseils. Les profils sont partagés avec l’équipe.
        En ranked, les adversaires restent anonymes : rien n’est cherché sur eux.
      </p>
      {enabled ? (
        <form className="scouting__form" onSubmit={submit} noValidate>
          <div className="field field--grow">
            <label className="field__label" htmlFor={`${id}-riot`}>Riot ID</label>
            <input
              id={`${id}-riot`}
              className="input"
              value={text}
              onChange={(e) => { setText(e.target.value); setError(null); }}
              placeholder="Nom#TAG"
              autoComplete="off"
              spellCheck={false}
              disabled={full}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-err` : undefined}
            />
          </div>
          <div className="field scouting__plat">
            <label className="field__label" htmlFor={`${id}-plat`}>Serveur</label>
            <select id={`${id}-plat`} className="input" value={platform} onChange={(e) => setPlatform(e.target.value)} disabled={full}>
              {plats.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
          </div>
          <button type="submit" className="btn btn--primary scouting__btn" disabled={full || !text.trim()}>Repérer</button>
        </form>
      ) : (
        <p className="notice">Clé API Riot non configurée sur le site : le repérage est indisponible.</p>
      )}
      <div aria-live="polite">
        {error && <p id={`${id}-err`} className="small estatus__err" role="alert">{error}</p>}
      </div>
      {(pending.length > 0 || profiles.length > 0) && (
        <ul className="scouting__list">
          {pending.map((s) => (
            <StatusRow key={s.key} s={s} onRetry={() => onRetry(s.key)} onRemove={() => onRemove(s.key)} />
          ))}
          {profiles.map((p) => (
            <li key={p.puuid}>
              <EnemyProfileCard profile={p} insight={byPuuid.get(p.puuid)} onRemove={() => onRemove(p.puuid)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Who should pick when (French sentences from the engine). */
export function PickOrderCard({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <section className="card pickorder" aria-labelledby="pick-order-title">
      <h3 id="pick-order-title" className="card__title">Ordre de pick</h3>
      <ol className="pickorder__list">
        {items.map((t, i) => <li key={i}>{t}</li>)}
      </ol>
    </section>
  );
}

/** Likely enemy champions per role not shown yet. */
export function PredictionsCard({ predictions, profiles }: { predictions: EnemyRolePrediction[]; profiles: EnemyPlayerProfile[] }) {
  const champs = useChampionMap();
  const list = predictions.filter((p) => p.candidates.length > 0);
  if (!list.length) return null;
  const who = new Map(profiles.map((p) => [p.puuid, p]));
  return (
    <section className="card card--enemy preds" aria-labelledby="preds-title">
      <h3 id="preds-title" className="card__title">Picks probables en face</h3>
      <ul className="preds__list">
        {list.map((pred) => {
          const player = pred.candidates.map((c) => (c.player_puuid ? who.get(c.player_puuid) : undefined)).find(Boolean);
          return (
            <li key={pred.role} className="pred">
              <div className="pred__head">
                <RoleBadge role={pred.role} />
                {player && <span className="pred__player small">★ {enemyLabel({ ...player, champion_id: null }, champs)}</span>}
              </div>
              <ul className="pred__cands" aria-label={`Champions probables, ${ROLE_LABEL[pred.role]}`}>
                {pred.candidates.slice(0, 5).map((c) => {
                  const name = champs.get(c.champion_id)?.name ?? c.champion_id;
                  return (
                    <li key={c.champion_id} className={`pred__cand ${c.player_puuid ? 'pred__cand--player' : ''}`} title={c.why}>
                      <ChampionAvatar champion={champs.get(c.champion_id)} id={c.champion_id} size={26} />
                      <span className="pred__name" aria-hidden="true">{name}</span>
                      <span className="pred__pct">{pctTxt(c.likelihood)}</span>
                    </li>
                  );
                })}
              </ul>
              <details className="pred__why">
                <summary>Pourquoi ?</summary>
                <ul className="bullets">
                  {pred.candidates.slice(0, 5).map((c) => (
                    <li key={c.champion_id}><strong>{champs.get(c.champion_id)?.name ?? c.champion_id}</strong> : {c.why}</li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One known enemy player: style, threats, what to do, likely picks. */
function InsightItem({ insight, profile, champs }: { insight: EnemyPlayerInsight; profile?: EnemyPlayerProfile; champs: ChampMap }) {
  const label = enemyLabel(insight, champs);
  const champ = insight.champion_id ?? null;
  return (
    <li className="einsight">
      <div className="einsight__head">
        {champ ? <ChampionAvatar champion={champs.get(champ)} id={champ} size={36} /> : <span className="einsight__unknown" aria-hidden="true">?</span>}
        <div className="einsight__id">
          <strong className="einsight__name">{label}</strong>
          <span className="small muted">
            {[insight.level ? `Niv. ${insight.level}` : null, formatRank(insight.rank ?? null), champ ? champs.get(champ)?.name ?? champ : null].filter(Boolean).join(' · ')}
          </span>
        </div>
        {insight.role && <RoleBadge role={insight.role} compact />}
        {profile && <span className={`esource esource--${profile.source}`} title={SOURCE_TITLE[profile.source]}>{SOURCE_LABEL[profile.source]}</span>}
      </div>
      {insight.style_tags.length > 0 && (
        <div className="chips" aria-label="Style de jeu">{insight.style_tags.map((t) => <Chip key={t} tone="amber">{t}</Chip>)}</div>
      )}
      {insight.threats.length > 0 && (
        <div>
          <h5 className="sub">Menaces</h5>
          <BulletList items={insight.threats} tone="red" />
        </div>
      )}
      {insight.attention_points.length > 0 && (
        <div>
          <h5 className="sub">À faire</h5>
          <BulletList items={insight.attention_points} tone="amber" />
        </div>
      )}
      {!champ && insight.likely_picks.length > 0 && (
        <div className="einsight__likely">
          <span className="small muted">Picks probables :</span>
          <ul className="eprofile__champs">
            {insight.likely_picks.slice(0, 5).map((c) => (
              <li key={c}><ChampionAvatar champion={champs.get(c)} id={c} size={26} /></li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function EnemyPlayersCard({ insights, profiles, title = 'Joueurs adverses connus' }: {
  insights: EnemyPlayerInsight[];
  profiles: EnemyPlayerProfile[];
  title?: string;
}) {
  const champs = useChampionMap();
  const id = useId();
  if (!insights.length) return null;
  const byPuuid = new Map(profiles.map((p) => [p.puuid, p]));
  return (
    <section className="card card--enemy" aria-labelledby={id}>
      <h3 id={id} className="card__title">{title}</h3>
      <ul className="einsights">
        {insights.map((i) => <InsightItem key={i.puuid} insight={i} profile={byPuuid.get(i.puuid)} champs={champs} />)}
      </ul>
    </section>
  );
}

const ATTENTION_PHASES: { phase: PhaseAttention['phase']; label: string }[] = [
  { phase: 'draft', label: 'Draft' },
  { phase: 'early', label: 'Début de partie' },
  { phase: 'mid', label: 'Milieu de partie' },
  { phase: 'late', label: 'Fin de partie' },
];

/** Phase-by-phase points of attention (buildMatchupPlan with enemy profiles). */
export function AttentionCard({ attention }: { attention: PhaseAttention[] }) {
  if (!attention.length) return null;
  return (
    <section className="card attention" aria-labelledby="attention-title">
      <h3 id="attention-title" className="card__title">Points d’attention</h3>
      <ol className="timeline">
        {ATTENTION_PHASES.filter((p) => attention.some((a) => a.phase === p.phase)).map((p) => (
          <li key={p.phase} className={`timeline__item timeline__item--${p.phase}`}>
            <h4>{p.label}</h4>
            <BulletList items={attention.filter((a) => a.phase === p.phase).map((a) => a.text)} tone="amber" />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Profiles without engine insights yet (fallback while the engine does not return them). */
export function EnemyProfilesList({ profiles, insights }: { profiles: EnemyPlayerProfile[]; insights: EnemyPlayerInsight[] }) {
  if (!profiles.length) return null;
  const byPuuid = new Map(insights.map((i) => [i.puuid, i]));
  return (
    <ul className="scouting__list scouting__list--grid">
      {profiles.map((p) => <li key={p.puuid}><EnemyProfileCard profile={p} insight={byPuuid.get(p.puuid)} /></li>)}
    </ul>
  );
}
