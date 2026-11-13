import { useEffect, useMemo, useState } from 'react';
import type { ChampionInfo, MetaStats, Role } from '../../api/types';
import { bestWorstMatchups, championDetail, laneMatchups, LOW_SAMPLE_GAMES, MATCHUP_MIN_GAMES, type MatchupLine } from '../../api/metaTier';
import { ROLE_LABEL } from '../../lib/format';
import { ChampionAvatar } from '../ChampionAvatar';
import { Modal } from '../Modal';
import { Bar, RoleBadge } from '../ui';
import { fmtInt, fmtPct } from './format';

function Duels({ title, lines, tone, empty, champs }: {
  title: string;
  lines: MatchupLine[];
  tone: 'green' | 'red';
  empty: string;
  champs: Map<string, ChampionInfo>;
}) {
  return (
    <div className={`duels duels--${tone}`}>
      <h4 className="sub">{title}</h4>
      {lines.length === 0 ? <p className="muted small">{empty}</p> : (
        <ul className="duels__list">
          {lines.map((l) => (
            <li key={l.opponent} className="duel">
              <ChampionAvatar champion={champs.get(l.opponent)} id={l.opponent} size={28} showName />
              <span className={`duel__wr ${tone === 'green' ? 'pos' : 'neg'}`}>{fmtPct(l.winrate, 0)}</span>
              <span className="duel__games">{fmtInt(l.games)} p.</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Champion detail: roles played, ban rate, best/worst lane duels in the selected role. */
export function ChampionMetaDrawer({ meta, championId, initialRole, champs, onClose }: {
  meta: MetaStats;
  championId: string | null;
  initialRole: Role | null;
  champs: Map<string, ChampionInfo>;
  onClose: () => void;
}) {
  const detail = useMemo(() => (championId ? championDetail(meta, championId) : null), [meta, championId]);
  const [role, setRole] = useState<Role | null>(initialRole);
  useEffect(() => {
    if (!detail) return;
    const plays = (r: Role | null) => !!r && detail.roles.some((l) => l.role === r);
    setRole(plays(initialRole) ? initialRole : detail.roles[0]?.role ?? null);
  }, [detail, initialRole]);

  const duels = useMemo(
    () => (championId && role ? bestWorstMatchups(laneMatchups(meta, role, championId)) : { best: [], worst: [] }),
    [meta, role, championId],
  );

  const champ = championId ? champs.get(championId) : undefined;
  const name = champ?.name ?? championId ?? '';
  return (
    <Modal open={!!championId && !!detail} onClose={onClose} title={name} variant="drawer">
      {detail && championId && (
        <div className="stack-lg cmeta">
          <div className="cmeta__head">
            <ChampionAvatar champion={champ} id={championId} size={56} />
            <div className="cmeta__id">
              {champ?.title && <p className="muted">{champ.title}</p>}
              <dl className="cmeta__kpis">
                <div><dt>Parties</dt><dd>{fmtInt(detail.games)}</dd></div>
                <div><dt>Bannissements</dt><dd>{fmtPct(detail.banRate)}</dd></div>
              </dl>
            </div>
          </div>

          <section className="stack-sm" aria-label="Rôles joués">
            <h3 className="sub">Rôles joués</h3>
            <ul className="cmeta__roles">
              {detail.roles.map((l) => (
                <li key={l.role}>
                  <button
                    type="button"
                    className={`cmeta__role ${role === l.role ? 'is-on' : ''}`}
                    aria-pressed={role === l.role}
                    onClick={() => setRole(l.role)}
                  >
                    <RoleBadge role={l.role} />
                    <span className="cmeta__role-bar"><Bar value={l.share} label={`Part de ses parties en ${ROLE_LABEL[l.role]}`} size="sm" /></span>
                    <span className="cmeta__role-nums">
                      <strong className={l.games < LOW_SAMPLE_GAMES ? 'muted' : ''}>{fmtPct(l.winrate)}</strong>
                      <span className="muted">{fmtInt(l.games)} p. · pick {fmtPct(l.pickRate)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {detail.roles.length > 1 && <p className="hint">Choisis un rôle pour voir ses face-à-face.</p>}
          </section>

          {role && (
            <section className="stack-sm" aria-label={`Face-à-face en ${ROLE_LABEL[role]}`}>
              <h3 className="sub">Face-à-face en {ROLE_LABEL[role]}</h3>
              <div className="cmeta__duels">
                <Duels
                  title="Bons duels" tone="green" lines={duels.best} champs={champs}
                  empty="Aucun duel favorable avec assez de parties."
                />
                <Duels
                  title="Duels difficiles" tone="red" lines={duels.worst} champs={champs}
                  empty="Aucun duel défavorable avec assez de parties."
                />
              </div>
              <p className="hint">
                Duels contre l’adversaire direct du même rôle, avec au moins {MATCHUP_MIN_GAMES} parties, classés par winrate
                lissé (ramené vers 50 %) : le pourcentage affiché est le winrate brut.
              </p>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
