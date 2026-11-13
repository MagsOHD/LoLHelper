// Clash UI: upcoming tournaments (Team page and draft page) and "Notre équipe Clash" (draft page:
// our roster, declared positions, roles pre-filled in the empty ally slots).
import { useId } from 'react';
import { clashRole, nextPhase, tournamentLabel, tournamentState, type TournamentState } from '../../api/clash';
import type { OurClashState } from '../../api/clashHooks';
import type { ClashPosition, ClashTournament, Player } from '../../api/types';
import { ROLE_LABEL } from '../../lib/format';
import { ErrorMessage, RoleBadge, Skeleton, Spinner } from '../ui';

const STATE_LABEL: Record<TournamentState, string> = {
  soon: 'Inscriptions bientôt',
  registration: 'Inscriptions ouvertes',
  live: 'En cours',
};

const POSITION_LABEL: Record<ClashPosition, string> = {
  TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support', FILL: 'Remplaçant', UNSELECTED: 'Poste non choisi',
};

const dateFmt = (ms: number) => new Date(ms).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayFmt = (ms: number) => new Date(ms).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

function TournamentRow({ t, now }: { t: ClashTournament; now: number }) {
  const phase = nextPhase(t, now);
  const state = tournamentState(t, now);
  if (!phase || !state) return null;
  return (
    <li className="ctour">
      <div className="ctour__main">
        <strong className="ctour__name">{tournamentLabel(t)}</strong>
        <span className="small muted">
          <time dateTime={new Date(phase.start_time).toISOString()}>{dateFmt(phase.start_time)}</time>
          {state === 'soon' && <> · inscriptions dès le <time dateTime={new Date(phase.registration_time).toISOString()}>{dayFmt(phase.registration_time)}</time></>}
        </span>
      </div>
      <span className={`ctour__state ctour__state--${state}`}>{STATE_LABEL[state]}</span>
    </li>
  );
}

/** Small card: the next Clash tournaments of the server (cached 10 min). */
export function ClashTournamentsCard({ list, isPending, error, max = 3, compact = false }: {
  list: ClashTournament[];
  isPending: boolean;
  error: unknown;
  max?: number;
  compact?: boolean;
}) {
  const id = useId();
  const now = Date.now();
  if (!isPending && !error && !list.length && compact) return null;
  return (
    <section className={`card ctours ${compact ? 'ctours--compact' : ''}`} aria-labelledby={id}>
      <h2 id={id} className="card__title">Prochains tournois Clash</h2>
      {isPending ? (
        <Skeleton height={44} />
      ) : error ? (
        <p className="small muted">Calendrier Clash indisponible pour l’instant.</p>
      ) : !list.length ? (
        <p className="small muted">Aucun tournoi Clash annoncé sur ce serveur.</p>
      ) : (
        <ul className="ctours__list">
          {list.slice(0, max).map((t) => <TournamentRow key={t.id} t={t} now={now} />)}
        </ul>
      )}
    </section>
  );
}

/** "Notre équipe Clash" on the draft page. */
export function OurClashCard({ clash, players, tournaments, enabled }: {
  clash: OurClashState;
  players: Player[];
  tournaments: { list: ClashTournament[]; isPending: boolean; error: unknown };
  enabled: boolean;
}) {
  const id = useId();
  const byId = new Map(players.map((p) => [p.id, p]));
  const next = tournaments.list[0];
  const now = Date.now();
  const state = next ? tournamentState(next, now) : null;
  const phase = next ? nextPhase(next, now) : null;
  if (!enabled) return null;
  return (
    <section className="card oclash" aria-labelledby={id}>
      <div className="oclash__head">
        <h2 id={id} className="card__title">Notre équipe Clash</h2>
        {clash.state !== 'loading' && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={clash.run}>
            {clash.state === 'idle' ? 'Chercher' : 'Actualiser'}
          </button>
        )}
      </div>
      {next && phase && state && (
        <p className="small oclash__next">
          <span className={`ctour__state ctour__state--${state}`}>{STATE_LABEL[state]}</span>{' '}
          {tournamentLabel(next)} · <time dateTime={new Date(phase.start_time).toISOString()}>{dateFmt(phase.start_time)}</time>
        </p>
      )}
      <div aria-live="polite" className="oclash__body">
        {clash.state === 'idle' && (
          <p className="hint">Retrouve l’équipe Clash de vos amis et préremplis les rôles encore vides avec leurs postes déclarés.</p>
        )}
        {clash.state === 'loading' && <p className="small muted"><Spinner label="Recherche de l’équipe Clash" /> Recherche de l’équipe Clash…</p>}
        {clash.state === 'error' && <ErrorMessage error={clash.error} onRetry={clash.run} />}
        {clash.state === 'done' && !clash.team && (
          <p className="small muted">{clash.error ?? 'Aucun ami de cette draft n’est inscrit dans une équipe Clash.'}</p>
        )}
        {clash.state === 'done' && clash.team && (
          <>
            <p className="oclash__team">
              {clash.team.abbreviation && <span className="eclash__tag">{clash.team.abbreviation}</span>}
              <strong>{clash.team.name}</strong>
              {clash.team.tier > 0 && <span className="small muted"> · niveau {clash.team.tier}</span>}
            </p>
            <ul className="oclash__members">
              {clash.members.map((m) => {
                const role = clashRole(m.position);
                return (
                  <li key={m.player_id}>
                    <span className="oclash__who">{byId.get(m.player_id)?.game_name ?? 'Ami'}</span>
                    {role ? <RoleBadge role={role} compact /> : <span className="small muted">{POSITION_LABEL[m.position]}</span>}
                  </li>
                );
              })}
            </ul>
            {clash.prefilled.length > 0 ? (
              <p className="notice" role="status">
                Rôles préremplis d’après le Clash : {clash.prefilled.map((c) => `${byId.get(c.player_id)?.game_name ?? 'Ami'} → ${ROLE_LABEL[c.role]}`).join(', ')}.
                Les rôles déjà choisis n’ont pas été modifiés.
              </p>
            ) : (
              <p className="hint">Les rôles déjà choisis sont conservés : rien n’a été modifié.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
