import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  useChampionMap, useCreatePlayer, useDeletePlayer, useDeleteTeam, useMeta, usePlayers, useSaveTeam, useSyncPlayer, useTeams,
} from '../api/hooks';
import type { Player, Team } from '../api/types';
import { Avatar, ChampionAvatar } from '../components/ChampionAvatar';
import { Modal } from '../components/Modal';
import { Chip, EmptyState, ErrorMessage, RoleBadge, SectionTitle, SkeletonCards, Spinner } from '../components/ui';
import { formatRank, parseRiotId, riotId } from '../lib/format';

function AddFriendForm() {
  const meta = useMeta();
  const create = useCreatePlayer();
  const [value, setValue] = useState('');
  const [platform, setPlatform] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    if (meta.data && !platform) setPlatform(meta.data.platform);
  }, [meta.data, platform]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseRiotId(value);
    if (!parsed) {
      setLocalError('Format attendu : Nom#TAG (par exemple Faker#KR1).');
      return;
    }
    setLocalError(null);
    create.mutate(
      { ...parsed, platform: platform || undefined },
      { onSuccess: () => setValue('') },
    );
  };

  const platforms = meta.data?.platforms ?? [];
  return (
    <form className="card add-friend" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="card__title">Ajouter un ami</h2>
      <div className="add-friend__row">
        <div className="field field--grow">
          <label htmlFor={`${id}-riot`} className="field__label">Riot ID</label>
          <input
            id={`${id}-riot`}
            className="input"
            placeholder="Nom#TAG"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!localError}
            aria-describedby={`${id}-hint`}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-platform`} className="field__label">Serveur</label>
          <select id={`${id}-platform`} className="input" value={platform} onChange={(e) => setPlatform(e.target.value)} disabled={!platforms.length}>
            {platforms.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
          </select>
        </div>
        <button type="submit" className="btn btn--primary add-friend__btn" disabled={create.isPending || !value.trim()}>
          {create.isPending ? <><Spinner label="Ajout en cours" /> Ajout…</> : 'Ajouter'}
        </button>
      </div>
      <p id={`${id}-hint`} className="hint">Le Riot ID se trouve dans le client, sous ton nom : « Nom#TAG ».</p>
      {localError && <ErrorMessage error={localError} />}
      {create.isError && <ErrorMessage error={create.error} />}
    </form>
  );
}

function PlayerCard({ player }: { player: Player }) {
  const champs = useChampionMap();
  const sync = useSyncPlayer();
  const del = useDeletePlayer();
  const meta = useMeta();
  const canSync = Boolean(player.puuid || meta.data?.riot_configured);
  const top = player.pool.slice(0, 3);
  const onDelete = () => {
    if (window.confirm(`Supprimer ${riotId(player)} ? Il sera aussi retiré des équipes.`)) del.mutate(player.id);
  };
  return (
    <li className="card player-card">
      <div className="player-card__head">
        <Avatar src={player.profile_icon_url} name={player.game_name} size={52} round />
        <div className="player-card__id">
          <Link to={`/players/${player.id}`} className="player-card__name">
            {player.game_name}<span className="tag">#{player.tag_line}</span>
          </Link>
          <div className="player-card__meta">
            {player.summoner_level !== null && <span>Niv. {player.summoner_level}</span>}
            <span>{formatRank(player.rank)}</span>
            {!player.puuid && <Chip tone="muted">Manuel</Chip>}
          </div>
        </div>
      </div>
      <div className="player-card__roles" aria-label="Rôles préférés">
        {player.preferences.roles.length
          ? player.preferences.roles.map((r) => <RoleBadge key={r} role={r} />)
          : <span className="muted small">Aucun rôle préféré</span>}
      </div>
      <div className="player-card__pool">
        {top.length ? (
          top.map((e) => <ChampionAvatar key={e.champion_id} champion={champs.get(e.champion_id)} id={e.champion_id} size={30} showName />)
        ) : (
          <span className="muted small">Pool vide — <Link to={`/players/${player.id}`}>ajoute des champions</Link></span>
        )}
      </div>
      {(sync.isError || del.isError) && <ErrorMessage error={sync.error ?? del.error} />}
      <div className="player-card__actions">
        <Link to={`/players/${player.id}`} className="btn btn--ghost btn--sm">Profil</Link>
        {canSync && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => sync.mutate(player.id)} disabled={sync.isPending}>
            {sync.isPending ? 'Synchro…' : 'Synchroniser'}
          </button>
        )}
        <button type="button" className="btn btn--danger btn--sm" onClick={onDelete} disabled={del.isPending} aria-label={`Supprimer ${riotId(player)}`}>
          Supprimer
        </button>
      </div>
    </li>
  );
}

function TeamEditor({ team, players, onClose }: { team: Team | 'new' | null; players: Player[]; onClose: () => void }) {
  const save = useSaveTeam();
  const [name, setName] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const id = useId();

  useEffect(() => {
    if (team === 'new') {
      setName('');
      setIds(players.slice(0, 5).map((p) => p.id));
    } else if (team) {
      setName(team.name);
      setIds(team.player_ids);
    }
    save.reset();
  }, [team]);

  const toggle = (pid: string) =>
    setIds((cur) => (cur.includes(pid) ? cur.filter((x) => x !== pid) : cur.length >= 5 ? cur : [...cur, pid]));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    save.mutate(
      { id: team && team !== 'new' ? team.id : undefined, body: { name: name.trim(), player_ids: ids } },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal open={!!team} onClose={onClose} title={team === 'new' ? 'Nouvelle équipe' : 'Modifier l’équipe'}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor={`${id}-name`} className="field__label">Nom de l’équipe</label>
          <input id={`${id}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="Les potes du jeudi" />
        </div>
        <fieldset className="fieldset">
          <legend className="field__label">Joueurs ({ids.length}/5)</legend>
          {players.length === 0 && <p className="muted">Ajoute d’abord des amis.</p>}
          <ul className="check-list">
            {players.map((p) => {
              const checked = ids.includes(p.id);
              return (
                <li key={p.id}>
                  <label className={`check ${checked ? 'is-on' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(p.id)} disabled={!checked && ids.length >= 5} />
                    <Avatar src={p.profile_icon_url} name={p.game_name} size={26} round />
                    <span>{riotId(p)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        {save.isError && <ErrorMessage error={save.error} />}
        <div className="row row--end">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Annuler</button>
          <button type="submit" className="btn btn--primary" disabled={!name.trim() || save.isPending}>
            {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TeamsSection({ players }: { players: Player[] }) {
  const teams = useTeams();
  const del = useDeleteTeam();
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const byId = new Map(players.map((p) => [p.id, p]));

  return (
    <section className="section">
      <SectionTitle
        action={<button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing('new')} disabled={!players.length}>+ Nouvelle équipe</button>}
      >
        Équipes
      </SectionTitle>
      {teams.isPending && <SkeletonCards count={2} height={70} />}
      {teams.isError && <ErrorMessage error={teams.error} onRetry={() => teams.refetch()} />}
      {del.isError && <ErrorMessage error={del.error} />}
      {teams.data && teams.data.length === 0 && (
        <EmptyState
          title="Aucune équipe"
          action={<button type="button" className="btn btn--primary" onClick={() => setEditing('new')} disabled={!players.length}>Créer une équipe</button>}
        >
          Une équipe regroupe les (jusqu’à) 5 amis qui jouent ensemble.
        </EmptyState>
      )}
      {teams.data && teams.data.length > 0 && (
        <ul className="grid">
          {teams.data.map((t) => (
            <li key={t.id} className="card team-card">
              <div className="team-card__head">
                <h3>{t.name}</h3>
                <span className="muted small">{t.player_ids.length}/5</span>
              </div>
              <div className="team-card__members">
                {t.player_ids.map((pid) => {
                  const p = byId.get(pid);
                  return p ? (
                    <Link key={pid} to={`/players/${pid}`} className="member" title={riotId(p)}>
                      <Avatar src={p.profile_icon_url} name={p.game_name} size={28} round />
                      <span>{p.game_name}</span>
                    </Link>
                  ) : null;
                })}
                {t.player_ids.length === 0 && <span className="muted small">Aucun joueur</span>}
              </div>
              <div className="player-card__actions">
                <Link to={`/compositions?team=${t.id}`} className="btn btn--primary btn--sm">Composer</Link>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(t)}>Modifier</button>
                <button
                  type="button"
                  className="btn btn--danger btn--sm"
                  onClick={() => window.confirm(`Supprimer l’équipe « ${t.name} » ?`) && del.mutate(t.id)}
                >
                  Supprimer
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <TeamEditor team={editing} players={players} onClose={() => setEditing(null)} />
    </section>
  );
}

export function TeamPage() {
  const players = usePlayers();
  return (
    <div className="page">
      <header className="page__head">
        <h1>Équipe</h1>
        <p className="lead">Ajoute tes amis, indique ce qu’ils savent jouer et ce qu’ils ont envie de jouer.</p>
      </header>
      <AddFriendForm />
      <section className="section">
        <SectionTitle>Joueurs</SectionTitle>
        {players.isPending && <SkeletonCards count={3} height={150} />}
        {players.isError && <ErrorMessage error={players.error} onRetry={() => players.refetch()} />}
        {players.data && players.data.length === 0 && (
          <EmptyState title="Aucun ami pour l’instant">
            Ajoute ton premier ami avec son Riot ID (Nom#TAG) dans le formulaire ci-dessus.
          </EmptyState>
        )}
        {players.data && players.data.length > 0 && (
          <ul className="grid">
            {players.data.map((p) => <PlayerCard key={p.id} player={p} />)}
          </ul>
        )}
      </section>
      {players.data && <TeamsSection players={players.data} />}
    </div>
  );
}
