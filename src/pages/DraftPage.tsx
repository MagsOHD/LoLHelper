import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage, MOCK_MODE } from '../api/client';
import { activeEnemyProfiles, clashProfiles, draftDocId, emptyDraft, keptOnReset, scoutedProfiles, usedChampions, MAX_BANS, type DraftKind } from '../api/draft';
import { useOurClashTeam, useUpcomingClash } from '../api/clashHooks';
import { useDraftAdvice, useDraftEngine, useDraftSession, useEnemyProfiles } from '../api/draftHooks';
import type { DraftSnapshot } from '../api/draftSession';
import { useMeta, usePlayers, useTeams } from '../api/hooks';
import { mergeDetectedGame, NO_ACTIVE_GAME, type DetectFriend } from '../api/spectator';
import type { DraftAllySlot, DraftEnemySlot, DraftPhase, DraftState, Player } from '../api/types';
import { CompanionHelp } from '../components/draft/CompanionHelp';
import { BanAdviceCard, EnemyAnalysisCard, PickAdviceCard } from '../components/draft/DraftAdvice';
import { DraftBoard } from '../components/draft/DraftBoard';
import { EnemyPlayersCard, PickOrderCard, PredictionsCard, RiotProgress, ScoutingPanel } from '../components/draft/EnemyIntel';
import { InGamePanel } from '../components/draft/InGamePanel';
import { OurClashCard } from '../components/clash/ClashCards';
import { EmptyState, ErrorMessage, Skeleton, Spinner } from '../components/ui';

/** Automatic game detection while the draft is over but the game not detected yet. */
export const AUTO_DETECT_MS = 30_000;

const PHASE_LABEL: Record<DraftPhase, string> = {
  planning: 'Préparation',
  ban: 'Phase de bans',
  pick: 'Phase de picks',
  finalization: 'Finalisation',
  in_game: 'En jeu',
  ended: 'Terminée',
};

function SourceIndicator({ snap, players }: { snap: DraftSnapshot; players: Player[] }) {
  const { draft, liveFresh, live } = snap;
  if (liveFresh && live) {
    const owner = players.find((p) => p.id === live.player_id)?.game_name ?? 'un ami';
    return <span className="source source--companion"><span className="source__dot" aria-hidden="true" />Synchronisé avec le client (PC de {owner})</span>;
  }
  if (draft.source === 'spectator' && draft.phase === 'in_game') {
    return <span className="source source--spectator"><span className="source__dot" aria-hidden="true" />Partie en cours détectée</span>;
  }
  if (draft.source === 'companion') {
    return <span className="source source--idle"><span className="source__dot" aria-hidden="true" />Client déconnecté — dernière synchro conservée</span>;
  }
  return <span className="source source--manual"><span className="source__dot" aria-hidden="true" />Saisie manuelle</span>;
}

function SaveState({ snap }: { snap: DraftSnapshot }) {
  if (snap.saveError) return <span className="save-state save-state--error">Non enregistré : {snap.saveError}</span>;
  if (snap.saving || snap.pending) return <span className="save-state"><Spinner label="Enregistrement" /> Enregistrement…</span>;
  if (snap.syncedAt) return <span className="save-state save-state--ok">Partagé avec l’équipe</span>;
  return null;
}

function DraftView({ initial, title, subtitle, players }: { initial: DraftState; title: string; subtitle: string; players: Player[] }) {
  const meta = useMeta();
  const engine = useDraftEngine();
  const { session, snap } = useDraftSession(initial, players, engine.data);
  const draft = snap?.draft;
  const { advice, error: adviceError } = useDraftAdvice(draft, players, engine.data);
  const [detect, setDetect] = useState<{ busy: boolean; msg: string | null; error: string | null }>({ busy: false, msg: null, error: null });
  const draftRef = useRef<DraftState | undefined>(draft);
  draftRef.current = draft;

  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  // Enemy profiles: same server as the draft's friends (Riot IDs can be looked up elsewhere when scouting).
  const canFetchProfiles = MOCK_MODE || Boolean(meta.data?.riot_configured);
  const platform = initial.player_ids.map((id) => byId.get(id)?.platform).find(Boolean) ?? meta.data?.platform ?? 'euw1';
  const enemyProfiles = useEnemyProfiles(session, draft, platform, canFetchProfiles);
  // Friends selectable in a slot: the draft's friends, plus anyone already placed (companion match).
  const friends = useMemo(() => {
    const ids = new Set([...initial.player_ids, ...(draft?.ally.map((s) => s.player_id).filter((x): x is string => !!x) ?? [])]);
    return players.filter((p) => ids.has(p.id));
  }, [players, initial.player_ids, draft?.ally]);
  const clashTournaments = useUpcomingClash(platform, canFetchProfiles);
  const ourClash = useOurClashTeam(session, draft, friends, platform, canFetchProfiles, Boolean(snap?.loaded), Boolean(snap?.liveFresh));

  const h = useMemo(() => ({
    hold: (p: string) => session?.hold(p),
    release: (p: string) => session?.release(p),
  }), [session]);

  const setAlly = useCallback((i: number, slot: DraftAllySlot) => {
    session?.edit([`ally.${i}`], (d) => ({ ...d, ally: d.ally.map((s, j) => (j === i ? slot : s)) }));
  }, [session]);

  const setAllyPlayer = useCallback((i: number, pid: string | null) => {
    const cur = draftRef.current;
    if (!cur) return;
    const other = pid ? cur.ally.findIndex((s, j) => j !== i && s.player_id === pid) : -1;
    const paths = [`ally.${i}`, ...(other >= 0 ? [`ally.${other}`] : [])];
    session?.edit(paths, (d) => ({
      ...d,
      ally: d.ally.map((s, j) => (j === i ? { ...s, player_id: pid } : j === other ? { ...s, player_id: d.ally[i].player_id ?? null } : s)),
    }));
  }, [session]);

  const setEnemy = useCallback((i: number, slot: DraftEnemySlot) => {
    session?.edit([`enemy.${i}`], (d) => ({ ...d, enemy: d.enemy.map((s, j) => (j === i ? slot : s)) }));
  }, [session]);

  const setBans = useCallback((side: 'ally' | 'enemy', bans: string[]) => {
    const field = side === 'ally' ? 'ally_bans' : 'enemy_bans';
    session?.edit([field], (d) => ({ ...d, [field]: bans.slice(0, MAX_BANS) }));
  }, [session]);

  /** "Choisir": the recommendation becomes the friend's hover. */
  const choose = useCallback((playerId: string, championId: string) => {
    const cur = draftRef.current;
    if (!cur) return;
    let i = cur.ally.findIndex((s) => s.player_id === playerId);
    if (i < 0) i = cur.ally.findIndex((s) => !s.player_id && !s.locked);
    if (i < 0) return;
    session?.edit([`ally.${i}`], (d) => ({
      ...d,
      ally: d.ally.map((s, j) => (j === i ? { ...s, player_id: playerId, champion_id: championId, locked: false } : s)),
    }));
  }, [session]);

  const reset = () => {
    if (!session || !draft) return;
    if (!window.confirm('Réinitialiser la draft pour toute l’équipe ? (les adversaires repérés sont conservés)')) return;
    const fresh = emptyDraft(draft.id, initial.player_ids, initial.team_id ?? null);
    session.replace({ ...fresh, enemy_profiles: keptOnReset(draft) });
    setDetect({ busy: false, msg: null, error: null });
  };

  const canDetect = MOCK_MODE || Boolean(meta.data?.riot_configured);
  const detectFriends = useCallback((): DetectFriend[] => {
    const cur = draftRef.current;
    const order = [...(cur?.ally.map((s) => s.player_id).filter((x): x is string => !!x) ?? []), ...initial.player_ids];
    return Array.from(new Set(order))
      .map((id) => byId.get(id))
      .filter((p): p is Player => !!p && (MOCK_MODE || !!p.puuid))
      .map((p) => ({ player_id: p.id, puuid: p.puuid, platform: p.platform }));
  }, [byId, initial.player_ids]);

  const runDetect = useCallback(async (quiet: boolean) => {
    const friendsToCheck = detectFriends();
    if (!friendsToCheck.length) {
      if (!quiet) setDetect({ busy: false, msg: null, error: 'Aucun ami synchronisé avec Riot dans cette draft (puuid inconnu).' });
      return;
    }
    if (!quiet) setDetect({ busy: true, msg: null, error: null });
    try {
      const cur = draftRef.current;
      const game = await api.detectGame(friendsToCheck, {
        knownPlayers: players.map((p) => ({ id: p.id, puuid: p.puuid })),
        known: { game_id: cur?.game_id, accounts: cur?.enemy_accounts },
      });
      const latest = draftRef.current;
      if (game && latest && session) {
        session.replace(mergeDetectedGame(latest, game));
        setDetect({ busy: false, msg: 'Partie détectée : les comptes adverses sont affichés.', error: null });
      } else if (!quiet) {
        setDetect({ busy: false, msg: NO_ACTIVE_GAME, error: null });
      }
    } catch (err) {
      if (!quiet) setDetect({ busy: false, msg: null, error: errorMessage(err) });
    }
  }, [detectFriends, players, session]);

  // Automatic check every 30 s once the draft is over (strict Riot budget: first friend found wins).
  const phase = draft?.phase;
  useEffect(() => {
    if (!canDetect || !session || (phase !== 'finalization' && phase !== 'ended')) return;
    const t = setInterval(() => void runDetect(true), AUTO_DETECT_MS);
    return () => clearInterval(t);
  }, [canDetect, session, phase, runDetect]);

  if (!snap || !draft) return <div className="stack" aria-busy="true"><Skeleton height={60} /><Skeleton height={320} /></div>;

  const exclude = usedChampions(draft);
  const inGame = draft.phase === 'in_game';
  const friendAdvice = (advice?.players ?? [])
    .filter((a) => byId.has(a.player_id))
    .sort((a, b) => draft.ally.findIndex((s) => s.player_id === a.player_id) - draft.ally.findIndex((s) => s.player_id === b.player_id));
  const toPick = friendAdvice.filter((a) => !a.locked_champion_id);
  const bansOpen = draft.ally_bans.length < MAX_BANS && (draft.phase === 'planning' || draft.phase === 'ban' || !draft.ally.some((s) => s.locked));
  const active = activeEnemyProfiles(draft);
  const scouted = scoutedProfiles(draft);

  return (
    <div className="page draft-page">
      <header className="draft-head">
        <div className="draft-head__title">
          <Link to="/" className="back">← Équipe</Link>
          <h1>Draft en direct</h1>
          <p className="lead">{title}<span className="muted"> · {subtitle}</span></p>
        </div>
        <div className="draft-head__actions">
          {canDetect && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void runDetect(false)} disabled={detect.busy}>
              {detect.busy ? <><Spinner label="Détection" /> Détection…</> : 'Détecter la partie'}
            </button>
          )}
          <button type="button" className="btn btn--danger btn--sm" onClick={reset}>Réinitialiser</button>
        </div>
      </header>

      <div className="draft-status" role="status" aria-live="polite">
        <SourceIndicator snap={snap} players={players} />
        <span className="chip chip--muted">{PHASE_LABEL[draft.phase]}</span>
        {draft.side && <span className={`chip chip--muted side side--${draft.side}`}>Côté {draft.side === 'blue' ? 'bleu' : 'rouge'}</span>}
        <SaveState snap={snap} />
        <RiotProgress statuses={enemyProfiles.statuses} />
      </div>
      {snap.loadError && <ErrorMessage error={`Draft partagée indisponible (${snap.loadError}) : la saisie reste possible sur cet appareil.`} />}
      {detect.error && <ErrorMessage error={detect.error} />}
      {detect.msg && <p className="notice" role="status">{detect.msg}</p>}
      {snap.liveFresh && (
        <p className="hint">Les cases marquées <span className="dslot__client">Client</span> (numéros adverses cerclés) sont remplies par le programme compagnon : une modification à la main y sera remplacée à sa prochaine mise à jour.</p>
      )}

      {inGame && <InGamePanel draft={draft} profiles={active} statuses={enemyProfiles.statuses} />}

      <div className={`draft-layout ${inGame ? 'draft-layout--ingame' : ''}`}>
        <div className="draft-main">
          <DraftBoard
            ally={draft.ally}
            enemy={draft.enemy}
            allyBans={draft.ally_bans}
            enemyBans={draft.enemy_bans}
            friends={friends}
            exclude={exclude}
            coverage={snap.liveFresh ? snap.coverage : null}
            h={h}
            onAlly={setAlly}
            onAllyPlayer={setAllyPlayer}
            onEnemy={setEnemy}
            onBans={setBans}
          />
          {!inGame && <OurClashCard clash={ourClash} players={friends} tournaments={clashTournaments} enabled={canFetchProfiles} />}
          {!inGame && <ScoutingPanel
            profiles={scouted}
            clash={clashProfiles(draft)}
            clashNotes={enemyProfiles.clashNotes}
            statuses={enemyProfiles.statuses}
            insights={advice?.enemy_players ?? []}
            platforms={meta.data?.platforms ?? [platform]}
            defaultPlatform={platform}
            enabled={canFetchProfiles}
            onScout={enemyProfiles.scout}
            onRemove={enemyProfiles.removeScouted}
            onRetry={enemyProfiles.retry}
          />}
        </div>

        <section className="draft-advice" aria-labelledby="draft-advice-title">
          <h2 id="draft-advice-title">Conseils</h2>
          {engine.isPending && <div className="stack" aria-busy="true"><Skeleton height={140} /><Skeleton height={140} /></div>}
          {engine.isError && <ErrorMessage error={engine.error} onRetry={() => engine.refetch()} />}
          {adviceError && <ErrorMessage error={adviceError} />}
          {advice && (
            <>
              {!inGame && <PickOrderCard items={advice.pick_order ?? []} />}
              {!inGame && (friendAdvice.length === 0 ? (
                <EmptyState title="Aucun ami à conseiller" icon="✦">
                  Attribue une case à un ami (menu « Coéquipier ») pour recevoir des propositions de champions.
                </EmptyState>
              ) : (
                <div className="advice-list">
                  {[...toPick, ...friendAdvice.filter((a) => a.locked_champion_id)].map((a) => (
                    <PickAdviceCard
                      key={a.player_id}
                      advice={a}
                      player={byId.get(a.player_id)}
                      slot={draft.ally.find((s) => s.player_id === a.player_id)}
                      onChoose={(cid) => choose(a.player_id, cid)}
                    />
                  ))}
                </div>
              ))}
              {!inGame && bansOpen && <BanAdviceCard bans={advice.bans} canBan={draft.ally_bans.length < MAX_BANS} onBan={(cid) => setBans('ally', [...draft.ally_bans, cid])} />}
              {!inGame && <PredictionsCard predictions={advice.predictions ?? []} profiles={active} />}
              {!inGame && <EnemyPlayersCard insights={advice.enemy_players ?? []} profiles={active} />}
              <EnemyAnalysisCard analysis={advice.enemy} />
            </>
          )}
        </section>
      </div>

      <CompanionHelp />
    </div>
  );
}

export function DraftPage() {
  const params = useParams();
  const kind = params.kind as DraftKind;
  const id = params.id ?? '';
  const players = usePlayers();
  const teams = useTeams();
  const validKind = kind === 'team' || kind === 'player';
  const team = kind === 'team' ? teams.data?.find((t) => t.id === id) : undefined;
  const player = kind === 'player' ? players.data?.find((p) => p.id === id) : undefined;
  const playerIds = useMemo(() => (team ? team.player_ids : player ? [player.id] : []), [team, player]);
  const initial = useMemo(
    () => emptyDraft(draftDocId(validKind ? kind : 'player', id), playerIds, team?.id ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, id, playerIds.join(',')],
  );

  if (!validKind) {
    return <EmptyState title="Draft introuvable" action={<Link className="btn btn--primary" to="/">Retour à l’équipe</Link>} />;
  }
  if (players.isPending || (kind === 'team' && teams.isPending)) {
    return <div className="page" aria-busy="true"><Skeleton height={60} /><Skeleton height={320} /></div>;
  }
  if (players.isError || teams.isError) {
    return <ErrorMessage error={errorMessage(players.error ?? teams.error)} onRetry={() => { void players.refetch(); void teams.refetch(); }} />;
  }
  if (!team && !player) {
    return (
      <EmptyState title={kind === 'team' ? 'Équipe introuvable' : 'Joueur introuvable'} action={<Link className="btn btn--primary" to="/">Retour à l’équipe</Link>}>
        Elle a peut-être été supprimée.
      </EmptyState>
    );
  }
  const names = playerIds.map((pid) => players.data?.find((p) => p.id === pid)?.game_name).filter(Boolean);
  const title = team ? `Équipe « ${team.name} »` : `Draft de ${player!.game_name}`;
  const subtitle = team ? (names.length ? names.join(', ') : 'aucun joueur') : 'avec 4 coéquipiers';
  return <DraftView key={initial.id} initial={initial} title={title} subtitle={subtitle} players={players.data ?? []} />;
}
