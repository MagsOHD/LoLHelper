import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useChampions } from '../api/hooks';
import type { ChampionInfo, Role } from '../api/types';
import { ROLES } from '../api/types';
import { norm, ROLE_LABEL, ROLE_SHORT } from '../lib/format';
import { ChampionAvatar } from './ChampionAvatar';

interface Props {
  label: string;
  /** Hide the label visually (still read by screen readers). */
  hideLabel?: boolean;
  /** Selected champion (single-value mode). Omit for "add" mode. */
  value?: string | null;
  onSelect: (championId: string) => void;
  onClear?: () => void;
  exclude?: string[];
  role?: Role | null;
  showRoleFilter?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

const MAX_RESULTS = 60;

/** Searchable, keyboard-accessible champion combobox (search by French name). */
export function ChampionPicker({
  label, hideLabel, value, onSelect, onClear, exclude = [], role = null, showRoleFilter = true,
  placeholder = 'Rechercher un champion…', disabled,
}: Props) {
  const { data: champions = [], isLoading } = useChampions();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [roleFilter, setRoleFilter] = useState<Role | null>(role);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const listId = `${id}-list`;

  useEffect(() => setRoleFilter(role), [role]);

  const selected = value ? champions.find((c) => c.id === value) : undefined;

  const results = useMemo(() => {
    const q = norm(query.trim());
    const ex = new Set(exclude);
    const list = champions.filter(
      (c) => !ex.has(c.id) && (!roleFilter || c.roles.includes(roleFilter)) && (!q || norm(c.name).includes(q) || norm(c.id).includes(q)),
    );
    if (q) list.sort((a, b) => Number(!norm(a.name).startsWith(q)) - Number(!norm(b.name).startsWith(q)));
    return list.slice(0, MAX_RESULTS);
  }, [champions, query, roleFilter, exclude]);

  useEffect(() => setActive(0), [query, roleFilter]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditing(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function choose(c: ChampionInfo) {
    onSelect(c.id);
    setQuery('');
    setOpen(false);
    setEditing(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      if (open && results[active]) {
        e.preventDefault();
        choose(results[active]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
      setEditing(false);
    }
  }

  const showSelected = !!value && !editing;

  return (
    <div className="picker" ref={wrapRef}>
      <label htmlFor={`${id}-input`} className={hideLabel ? 'sr-only' : 'field__label'}>{label}</label>
      {showSelected ? (
        <div className="picker__selected">
          <button
            type="button"
            className="picker__current"
            disabled={disabled}
            onClick={() => {
              setEditing(true);
              setOpen(true);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
            aria-label={`${label} : ${selected?.name ?? value}. Changer`}
          >
            <ChampionAvatar champion={selected} id={value ?? undefined} size={28} />
            <span className="picker__current-name">{selected?.name ?? value}</span>
          </button>
          {onClear && (
            <button type="button" className="icon-btn" onClick={onClear} aria-label={`Retirer ${selected?.name ?? value}`} disabled={disabled}>
              ×
            </button>
          )}
        </div>
      ) : (
        <div className="picker__control">
          <input
            ref={inputRef}
            id={`${id}-input`}
            className="input"
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && results[active] ? `${id}-opt-${active}` : undefined}
            autoComplete="off"
            placeholder={isLoading ? 'Chargement des champions…' : placeholder}
            value={query}
            disabled={disabled}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
        </div>
      )}
      {open && !showSelected && (
        <div className="picker__pop">
          {showRoleFilter && (
            <div className="picker__roles" role="group" aria-label="Filtrer par rôle">
              <button type="button" className={`picker__role ${!roleFilter ? 'is-on' : ''}`} onClick={() => setRoleFilter(null)} aria-pressed={!roleFilter}>
                Tous
              </button>
              {ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`picker__role ${roleFilter === r ? 'is-on' : ''}`}
                  onClick={() => setRoleFilter(roleFilter === r ? null : r)}
                  aria-pressed={roleFilter === r}
                  title={ROLE_LABEL[r]}
                >
                  <span aria-hidden="true">{ROLE_SHORT[r]}</span>
                  <span className="sr-only">{ROLE_LABEL[r]}</span>
                </button>
              ))}
            </div>
          )}
          <ul className="picker__list" role="listbox" id={listId} ref={listRef} aria-label={label}>
            {results.length === 0 && <li className="picker__empty">Aucun champion trouvé</li>}
            {results.map((c, i) => (
              <li
                key={c.id}
                id={`${id}-opt-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                className={`picker__opt ${i === active ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(c)}
              >
                <ChampionAvatar champion={c} size={28} />
                <span className="picker__opt-name">{c.name}</span>
                <span className="picker__opt-roles">
                  {c.roles.slice(0, 2).map((r) => ROLE_SHORT[r]).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
