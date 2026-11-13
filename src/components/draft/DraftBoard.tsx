import { useId, type ReactNode } from 'react';
import { useChampionMap } from '../../api/hooks';
import type { Coverage } from '../../api/draft';
import { MAX_BANS } from '../../api/draft';
import type { DraftAllySlot, DraftEnemySlot, Player, Role } from '../../api/types';
import { ROLES } from '../../api/types';
import { ROLE_SHORT } from '../../lib/format';
import { ChampionAvatar } from '../ChampionAvatar';
import { ChampionPicker } from '../ChampionPicker';

export interface SlotHandlers {
  hold(path: string): void;
  release(path: string): void;
}

/** Keeps a path "held" while focus is inside (remote / companion updates do not overwrite it). */
export function Hold({ path, h, children, className }: { path: string; h: SlotHandlers; children: ReactNode; className?: string }) {
  return (
    <div
      className={className}
      onFocusCapture={() => h.hold(path)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) h.release(path);
      }}
    >
      {children}
    </div>
  );
}

function RoleSelect({ id, label, value, onChange, disabled }: {
  id: string;
  label: string;
  value: Role | null | undefined;
  onChange: (r: Role | null) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <label className="sr-only" htmlFor={id}>{label}</label>
      <select
        id={id}
        className="input input--role dslot__role"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange((e.target.value || null) as Role | null)}
      >
        <option value="">Rôle ?</option>
        {ROLES.map((r) => <option key={r} value={r}>{ROLE_SHORT[r]}</option>)}
      </select>
    </>
  );
}

function ClientBadge() {
  return <span className="dslot__client" title="Rempli par le programme compagnon">Client</span>;
}

export function AllySlotRow({ index, slot, friends, exclude, covered, h, onChange, onPlayer }: {
  index: number;
  slot: DraftAllySlot;
  /** Friends that may be assigned to a slot. */
  friends: Player[];
  exclude: string[];
  covered: boolean;
  h: SlotHandlers;
  onChange: (slot: DraftAllySlot) => void;
  onPlayer: (playerId: string | null) => void;
}) {
  const id = useId();
  const champs = useChampionMap();
  const friend = friends.find((f) => f.id === slot.player_id);
  const who = friend?.game_name ?? 'Coéquipier';
  const state = !slot.champion_id ? 'empty' : slot.locked ? 'locked' : 'hover';
  const champName = slot.champion_id ? champs.get(slot.champion_id)?.name ?? slot.champion_id : '';
  return (
    <li className={`dslot dslot--ally dslot--${state} ${friend ? 'dslot--friend' : ''}`}>
      <div className="dslot__top">
        <label className="sr-only" htmlFor={`${id}-who`}>Joueur de la case {index + 1}</label>
        <select
          id={`${id}-who`}
          className={`dslot__who ${friend ? 'is-friend' : ''}`}
          value={slot.player_id ?? ''}
          onChange={(e) => onPlayer(e.target.value || null)}
        >
          <option value="">Coéquipier</option>
          {friends.map((f) => <option key={f.id} value={f.id}>{f.game_name}</option>)}
        </select>
        {covered && <ClientBadge />}
        <RoleSelect id={`${id}-role`} label={`Rôle de ${who}`} value={slot.role} onChange={(role) => onChange({ ...slot, role })} />
      </div>
      <div className="dslot__main">
        <Hold path={`ally.${index}`} h={h} className="dslot__picker">
          <ChampionPicker
            label={`Champion de ${who}`}
            hideLabel
            value={slot.champion_id ?? null}
            role={slot.role ?? null}
            exclude={exclude}
            onSelect={(cid) => onChange({ ...slot, champion_id: cid })}
            onClear={() => onChange({ ...slot, champion_id: null, locked: false })}
            placeholder="Choisir…"
          />
        </Hold>
        <button
          type="button"
          className={`lock-btn ${slot.locked ? 'is-on' : ''}`}
          aria-pressed={slot.locked}
          disabled={!slot.champion_id}
          onClick={() => onChange({ ...slot, locked: !slot.locked })}
          aria-label={slot.locked ? `${champName} verrouillé pour ${who} : repasser en survol` : `Verrouiller ${champName || 'le champion'} pour ${who}`}
        >
          <span aria-hidden="true">{slot.locked ? '🔒' : '◌'}</span>
          <span className="lock-btn__txt">{slot.locked ? 'Verrouillé' : 'Survol'}</span>
        </button>
      </div>
    </li>
  );
}

export function EnemySlotRow({ index, slot, exclude, covered, h, onChange }: {
  index: number;
  slot: DraftEnemySlot;
  exclude: string[];
  covered: boolean;
  h: SlotHandlers;
  onChange: (slot: DraftEnemySlot) => void;
}) {
  const id = useId();
  return (
    <li className={`dslot dslot--enemy dslot--${slot.champion_id ? 'locked' : 'empty'}`}>
      <span className={`slot__num ${covered ? 'slot__num--client' : ''}`} title={covered ? 'Rempli par le programme compagnon' : undefined}>
        <span aria-hidden="true">{index + 1}</span>
        {covered && <span className="sr-only">Rempli par le client</span>}
      </span>
      <Hold path={`enemy.${index}`} h={h} className="dslot__picker">
        <ChampionPicker
          label={`Champion adverse ${index + 1}`}
          hideLabel
          value={slot.champion_id ?? null}
          role={slot.role ?? null}
          exclude={exclude}
          onSelect={(cid) => onChange({ ...slot, champion_id: cid, locked: true })}
          onClear={() => onChange({ champion_id: null, role: slot.role ?? null, locked: false })}
          placeholder="Adversaire…"
        />
      </Hold>
      <RoleSelect id={`${id}-role`} label={`Rôle de l’adversaire ${index + 1} (optionnel)`} value={slot.role} onChange={(role) => onChange({ ...slot, role })} />
    </li>
  );
}

export function BansRow({ side, bans, exclude, covered, h, onChange }: {
  side: 'ally' | 'enemy';
  bans: string[];
  exclude: string[];
  covered: boolean;
  h: SlotHandlers;
  onChange: (bans: string[]) => void;
}) {
  const champs = useChampionMap();
  const label = side === 'ally' ? 'Nos bans' : 'Leurs bans';
  return (
    <div className={`bans bans--${side}`}>
      <div className="bans__head">
        <span className="bans__label">{label} <span className="muted">({bans.length}/{MAX_BANS})</span></span>
        {covered && <ClientBadge />}
      </div>
      <ul className="bans__list" aria-label={label}>
        {bans.map((cid) => {
          const name = champs.get(cid)?.name ?? cid;
          return (
            <li key={cid} className="ban-chip">
              <ChampionAvatar champion={champs.get(cid)} id={cid} size={26} />
              <span className="ban-chip__name">{name}</span>
              <button type="button" className="icon-btn icon-btn--sm" onClick={() => onChange(bans.filter((b) => b !== cid))} aria-label={`Retirer le ban ${name}`}>×</button>
            </li>
          );
        })}
      </ul>
      {bans.length < MAX_BANS && (
        <Hold path={`${side}_bans`} h={h} className="bans__add">
          <ChampionPicker
            label={side === 'ally' ? 'Ajouter un de nos bans' : 'Ajouter un de leurs bans'}
            hideLabel
            exclude={exclude}
            showRoleFilter={false}
            onSelect={(cid) => onChange([...bans, cid].slice(0, MAX_BANS))}
            placeholder="+ Ban…"
          />
        </Hold>
      )}
    </div>
  );
}

export function DraftBoard({ ally, enemy, allyBans, enemyBans, friends, exclude, coverage, h, onAlly, onAllyPlayer, onEnemy, onBans }: {
  ally: DraftAllySlot[];
  enemy: DraftEnemySlot[];
  allyBans: string[];
  enemyBans: string[];
  friends: Player[];
  exclude: string[];
  coverage: Coverage | null;
  h: SlotHandlers;
  onAlly: (i: number, slot: DraftAllySlot) => void;
  onAllyPlayer: (i: number, playerId: string | null) => void;
  onEnemy: (i: number, slot: DraftEnemySlot) => void;
  onBans: (side: 'ally' | 'enemy', bans: string[]) => void;
}) {
  const without = (cid: string | null | undefined) => (cid ? exclude.filter((x) => x !== cid) : exclude);
  return (
    <div className="draft-board">
      <section className="card card--ally draft-side" aria-labelledby="draft-allies">
        <h2 id="draft-allies" className="draft-side__title">Alliés</h2>
        <BansRow side="ally" bans={allyBans} exclude={exclude} covered={!!coverage?.bans} h={h} onChange={(b) => onBans('ally', b)} />
        <ul className="dslots">
          {ally.map((s, i) => (
            <AllySlotRow
              key={i}
              index={i}
              slot={s}
              friends={friends}
              exclude={without(s.champion_id)}
              covered={!!coverage?.ally[i]}
              h={h}
              onChange={(slot) => onAlly(i, slot)}
              onPlayer={(pid) => onAllyPlayer(i, pid)}
            />
          ))}
        </ul>
      </section>
      <section className="card card--enemy draft-side" aria-labelledby="draft-enemies">
        <h2 id="draft-enemies" className="draft-side__title">Ennemis</h2>
        <BansRow side="enemy" bans={enemyBans} exclude={exclude} covered={!!coverage?.bans} h={h} onChange={(b) => onBans('enemy', b)} />
        <ul className="dslots">
          {enemy.map((s, i) => (
            <EnemySlotRow
              key={i}
              index={i}
              slot={s}
              exclude={without(s.champion_id)}
              covered={!!coverage?.enemy[i]}
              h={h}
              onChange={(slot) => onEnemy(i, slot)}
            />
          ))}
        </ul>
        <p className="hint">Rôles adverses optionnels : ils sont devinés s’ils sont vides.</p>
      </section>
    </div>
  );
}

