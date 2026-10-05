import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useChampionMap, useDeleteSaved, usePlayers, useSaved, useTeams, useThemeLabels } from '../api/hooks';
import type { Pick, SavedComposition } from '../api/types';
import { ROLES } from '../api/types';
import { ChampionAvatar } from '../components/ChampionAvatar';
import { GamePlanDrawer } from '../components/GamePlanView';
import { Chip, EmptyState, ErrorMessage, RoleBadge, SkeletonCards } from '../components/ui';
import { formatDate } from '../lib/format';

function sortPicks(picks: Pick[]): Pick[] {
  return [...picks].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
}

export function SavedPage() {
  const saved = useSaved();
  const players = usePlayers();
  const teams = useTeams();
  const champs = useChampionMap();
  const themeLabel = useThemeLabels();
  const del = useDeleteSaved();
  const navigate = useNavigate();
  const [plan, setPlan] = useState<SavedComposition | null>(null);

  const playerName = useMemo(() => new Map((players.data ?? []).map((p) => [p.id, p.game_name])), [players.data]);
  const teamName = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t.name])), [teams.data]);

  return (
    <div className="page">
      <header className="page__head">
        <h1>Compositions sauvegardées</h1>
        <p className="lead">Retrouve vos compos préférées, leur plan de jeu et prépare-les contre une équipe adverse.</p>
      </header>
      {saved.isPending && <SkeletonCards count={2} height={180} />}
      {saved.isError && <ErrorMessage error={saved.error} onRetry={() => saved.refetch()} />}
      {del.isError && <ErrorMessage error={del.error} />}
      {saved.data && saved.data.length === 0 && (
        <EmptyState title="Aucune composition sauvegardée" action={<Link to="/compositions" className="btn btn--primary">Générer des compositions</Link>}>
          Sauvegarde une compo depuis la page Compositions pour la retrouver ici.
        </EmptyState>
      )}
      {saved.data && saved.data.length > 0 && (
        <ul className="comp-grid">
          {saved.data.map((s) => (
            <li key={s.id} className="card comp">
              <header className="comp__head">
                <div className="comp__title">
                  <h3>{s.name}</h3>
                </div>
              </header>
              <div className="chips">
                {s.theme && <Chip tone="gold">{themeLabel(s.theme)}</Chip>}
                {s.team_id && teamName.get(s.team_id) && <Chip tone="blue">{teamName.get(s.team_id)}</Chip>}
                <span className="muted small">{formatDate(s.created_at)}</span>
              </div>
              <ul className="picks picks--compact">
                {sortPicks(s.picks).map((p) => (
                  <li key={`${p.role}-${p.champion_id}`} className="pick">
                    <RoleBadge role={p.role} />
                    <ChampionAvatar champion={champs.get(p.champion_id)} id={p.champion_id} size={32} />
                    <div className="pick__main">
                      <div className="pick__names">
                        <strong>{champs.get(p.champion_id)?.name ?? p.champion_id}</strong>
                        {p.player_id && playerName.get(p.player_id) && <span className="pick__player">{playerName.get(p.player_id)}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {s.notes && <p className="notes">{s.notes}</p>}
              <footer className="comp__actions">
                <button type="button" className="btn btn--primary btn--sm" onClick={() => setPlan(s)}>Plan de jeu</button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate(`/matchup?saved=${encodeURIComponent(s.id)}`, { state: { ally: s.picks, label: s.name } })}>
                  Contre une équipe…
                </button>
                <button
                  type="button"
                  className="btn btn--danger btn--sm"
                  disabled={del.isPending && del.variables === s.id}
                  onClick={() => window.confirm(`Supprimer « ${s.name} » ?`) && del.mutate(s.id)}
                >
                  Supprimer
                </button>
              </footer>
            </li>
          ))}
        </ul>
      )}
      <GamePlanDrawer picks={plan ? plan.picks : null} title={plan ? `Plan de jeu · ${plan.name}` : undefined} onClose={() => setPlan(null)} />
    </div>
  );
}
