"""Composition generator: beam search over (role, champion) per player + local improvement."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from .analysis import counter_details, counter_score, team_notes, viability
from .catalog import ROLE_LABELS, TRAITS, ChampData, ChampionCatalog, archetype_label
from .models import (
    CompositionSuggestion,
    GenerationOptions,
    PlayerInput,
    PoolEntry,
    Role,
    ScoreBreakdown,
    SuggestedPick,
)
from .themes import ThemeDef, all_themes, get_theme, lore_pairs, team_sums

ROLE_ORDER = [Role.TOP, Role.JUNGLE, Role.MID, Role.BOTTOM, Role.SUPPORT]
PREF_FIT = [1.0, 0.8, 0.6, 0.45, 0.35]
UNLISTED_ROLE_FIT = 0.15
AUTO_THEMATIC_FACTOR = 0.95

TRAIT_FR = {
    "engage": "l'engage",
    "peel": "la protection des carries",
    "poke": "la poke",
    "waveclear": "le waveclear",
    "splitpush": "le split push",
    "pick": "les picks",
    "teamfight": "les combats d'équipe",
    "early": "la pression en début de partie",
    "late": "la puissance en fin de partie",
    "mobility": "la mobilité",
    "frontline": "la frontline",
    "cc": "les contrôles",
    "sustain": "la survie",
    "objective": "la prise d'objectifs",
}

COUNTER_FR = {
    "dive": "au dive adverse",
    "poke": "à la poke adverse",
    "engage": "à l'engage adverse",
    "split": "au split push adverse",
    "pick": "aux picks adverses",
    "frontline": "à la frontline adverse",
    "early": "à l'early adverse",
    "late": "au scaling adverse",
}


@dataclass(slots=True)
class Cand:
    pidx: int
    role: Role
    champ: ChampData
    comfort: float
    desire: float
    role_fit: float
    entry: PoolEntry | None
    locked: bool
    iv: float = 0.0  # individual value used to pre-rank candidates

    @property
    def comfort_part(self) -> float:
        return 0.75 * self.comfort + 0.25 * self.role_fit


@dataclass
class _Player:
    idx: int
    inp: PlayerInput
    forced: Role | None
    locked: str | None
    role_fit: dict[Role, float]
    pool: dict[str, PoolEntry]
    wanted: set[str]
    wanted_arch: set[str]
    avoided: set[str]
    base: list[Cand]


@dataclass
class _Ctx:
    catalog: ChampionCatalog
    options: GenerationOptions
    players: list[_Player]
    excluded: set[str]
    enemy: list[ChampData]
    w_comfort: float
    w_desire: float
    w_theme: float
    w_balance: float
    w_counter: float
    penalty: dict[str, float] | None = None  # diversification during the search


# --------------------------------------------------------------------------- helpers


def _role_fit(p: PlayerInput, forced: Role | None) -> dict[Role, float]:
    if forced:
        return {r: (1.0 if r == forced else 0.0) for r in ROLE_ORDER}
    prefs = [r for i, r in enumerate(p.preferences.roles) if r not in p.preferences.roles[:i]]
    games = {r: p.role_games.get(r, 0) for r in ROLE_ORDER}
    max_games = max(games.values()) if games else 0
    out = {}
    for r in ROLE_ORDER:
        g = 0.3 + 0.7 * games[r] / max_games if max_games > 0 else 0.6
        if prefs:
            pref = PREF_FIT[prefs.index(r)] if r in prefs else UNLISTED_ROLE_FIT
            out[r] = 0.8 * pref + 0.2 * g if max_games > 0 else pref
        else:
            out[r] = g
    return out


def _generic_strength(c: ChampData) -> int:
    return sum(c.traits)


def _fmt_points(points: int) -> str:
    if points >= 1_000_000:
        return f"{points / 1_000_000:.1f}M".replace(".", ",").replace(",0M", "M")
    if points >= 1000:
        return f"{round(points / 1000)}k"
    return str(points)


def _evaluate(ctx: _Ctx, theme: ThemeDef, picks: Sequence[Cand]) -> tuple[float, dict[str, float]]:
    n = len(picks)
    champs = [c.champ for c in picks]
    sums = team_sums(champs)
    comfort = sum(c.comfort_part for c in picks) / n
    desire = sum(c.desire for c in picks) / n
    fit = theme.fit(champs, sums)
    bal = viability(champs, sums, ignore_damage=theme.ignore_damage_mix)
    total = ctx.w_comfort * comfort + ctx.w_desire * desire + ctx.w_theme * fit + ctx.w_balance * bal
    weights = ctx.w_comfort + ctx.w_desire + ctx.w_theme + ctx.w_balance
    parts = {"comfort": comfort, "desire": desire, "theme_fit": fit, "balance": bal}
    if ctx.enemy:
        cnt = counter_score(champs, ctx.enemy)
        total += ctx.w_counter * cnt
        weights += ctx.w_counter
        parts["counter"] = cnt
    score = total / weights
    if ctx.penalty:
        score -= sum(ctx.penalty.get(c.champ.id, 0.0) for c in picks)
    return score, parts


# --------------------------------------------------------------------------- setup


def _prepare(players: list[PlayerInput], options: GenerationOptions, catalog: ChampionCatalog) -> _Ctx:
    expl = options.exploration
    excluded = {catalog.resolve(b) or b for b in options.bans}
    enemy_data = []
    for e in options.enemy_champions:
        d = catalog.data(e)
        if d:
            enemy_data.append(d)
            excluded.add(d.id)
    locked = {pid: catalog.resolve(cid) for pid, cid in options.locked_picks.items() if catalog.resolve(cid)}

    ctx = _Ctx(
        catalog=catalog,
        options=options,
        players=[],
        excluded=excluded,
        enemy=enemy_data,
        w_comfort=0.32 * (1 - 0.5 * expl),
        w_desire=0.14 + 0.06 * expl,
        w_theme=0.30 if options.theme else 0.26,
        w_balance=0.18,
        w_counter=0.12,
    )
    all_champs = catalog.all_data()
    for idx, p in enumerate(players):
        forced = options.role_assignments.get(p.player_id)
        lock = locked.get(p.player_id)
        pool = {}
        for e in p.pool:
            cid = catalog.resolve(e.champion_id)
            if cid and cid not in pool:
                pool[cid] = e
        pl = _Player(
            idx=idx,
            inp=p,
            forced=forced,
            locked=lock,
            role_fit=_role_fit(p, forced),
            pool=pool,
            wanted={catalog.resolve(c) or c for c in p.preferences.wanted_champions},
            wanted_arch=set(p.preferences.wanted_archetypes),
            avoided={catalog.resolve(c) or c for c in p.preferences.avoided_champions},
            base=[],
        )
        ctx.players.append(pl)

    other_locks = {pid: cid for pid, cid in locked.items()}
    for pl in ctx.players:
        blocked = excluded | {cid for pid, cid in other_locks.items() if pid != pl.inp.player_id}
        roles = [pl.forced] if pl.forced else ROLE_ORDER
        cands: list[Cand] = []
        if pl.locked:
            d = catalog.data(pl.locked)
            if d:
                viable = [r for r in roles if r in d.roles] or list(roles)
                e = pl.pool.get(d.id)
                for r in viable:
                    cands.append(_cand(pl, r, d, e, locked=True))
            pl.base = cands
            continue
        seen: set[tuple[str, Role]] = set()
        for cid in sorted(pl.pool, key=lambda c: (-pl.pool[c].comfort, -pl.pool[c].desire, c)):
            e = pl.pool[cid]
            if cid in blocked or cid in pl.avoided:
                continue
            if e.comfort < 0.01 and cid not in pl.wanted and expl <= 0:
                continue
            d = catalog.data(cid)
            if not d:
                continue
            for r in roles:
                if r in d.roles:
                    cands.append(_cand(pl, r, d, e))
                    seen.add((cid, r))
        # exploration: unknown champions of the player's main roles
        n_extra = round(expl * 10)
        if n_extra:
            main_roles = [r for r in roles if pl.role_fit[r] >= 0.6] or list(roles)
            for r in main_roles:
                pool_r = [
                    c for c in all_champs
                    if r in c.roles and (c.id, r) not in seen and c.id not in blocked and c.id not in pl.avoided
                ]
                pool_r.sort(key=lambda c: (c.archetype not in pl.wanted_arch, -_generic_strength(c), c.id))
                for c in pool_r[:n_extra]:
                    cands.append(_cand(pl, r, c, None))
                    seen.add((c.id, r))
        # safety net: every allowed role must have a few options
        for r in roles:
            have = sum(1 for c in cands if c.role == r)
            if have < 3:
                pool_r = [
                    c for c in all_champs
                    if r in c.roles and (c.id, r) not in seen and c.id not in blocked and c.id not in pl.avoided
                ]
                pool_r.sort(key=lambda c: (c.archetype not in pl.wanted_arch, -_generic_strength(c), c.id))
                for c in pool_r[: 3 - have]:
                    cands.append(_cand(pl, r, c, None))
                    seen.add((c.id, r))
        pl.base = cands
    return ctx


def _cand(pl: _Player, role: Role, d: ChampData, e: PoolEntry | None, locked: bool = False) -> Cand:
    comfort = e.comfort if e else 0.0
    desire = e.desire if e else 0.0
    if d.id in pl.wanted:
        desire = 1.0
    elif d.archetype in pl.wanted_arch:
        desire = max(desire, 0.6)
    return Cand(pl.idx, role, d, comfort, desire, pl.role_fit[role], e, locked)


def _theme_candidates(ctx: _Ctx, pl: _Player, theme: ThemeDef, explicit: bool, limit: int) -> list[Cand]:
    cands = list(pl.base)
    if theme.thematic and not pl.locked:
        per_role = 6 if explicit else round(ctx.options.exploration * 6)
        if per_role:
            blocked = ctx.excluded | {
                ctx.catalog.resolve(cid) or cid
                for pid, cid in ctx.options.locked_picks.items()
                if pid != pl.inp.player_id
            }
            have = {(c.champ.id, c.role) for c in cands}
            roles = [pl.forced] if pl.forced else ROLE_ORDER
            for r in roles:
                extra = [
                    c for c in ctx.catalog.all_data()
                    if r in c.roles and (c.id, r) not in have and c.id not in blocked
                    and c.id not in pl.avoided and theme.affinity(c) > 0
                ]
                extra.sort(key=lambda c: (c.archetype not in pl.wanted_arch, -_generic_strength(c), c.id))
                for c in extra[:per_role]:
                    cands.append(_cand(pl, r, c, None))
    wt = ctx.w_theme * (1.0 if theme.thematic else 0.8)
    for c in cands:
        c.iv = ctx.w_comfort * c.comfort_part + ctx.w_desire * c.desire + wt * theme.affinity(c.champ)
    cands.sort(key=lambda c: (-c.iv, c.champ.id, c.role.value))
    # keep the best overall while guaranteeing a few options per role
    chosen: list[Cand] = []
    per_role_count: dict[Role, int] = {}
    for c in cands:
        if per_role_count.get(c.role, 0) < 3:
            chosen.append(c)
            per_role_count[c.role] = per_role_count.get(c.role, 0) + 1
    for c in cands:
        if len(chosen) >= limit + 5:
            break
        if c not in chosen:
            chosen.append(c)
    chosen.sort(key=lambda c: (-c.iv, c.champ.id, c.role.value))
    return chosen


# --------------------------------------------------------------------------- search


def _key(picks: Sequence[Cand]) -> tuple:
    return tuple(sorted((c.pidx, c.role.value, c.champ.id) for c in picks))


def _search(ctx: _Ctx, theme: ThemeDef, explicit: bool, beam: int, limit: int, keep: int) -> list[tuple[float, dict, list[Cand]]]:
    per_player = [_theme_candidates(ctx, pl, theme, explicit, limit) for pl in ctx.players]
    order = sorted(range(len(ctx.players)), key=lambda i: (len(per_player[i]), i))
    states: list[tuple[float, list[Cand]]] = [(0.0, [])]
    for i in order:
        nxt: dict[tuple, tuple[float, list[Cand]]] = {}
        for _, picks in states:
            used_roles = {c.role for c in picks}
            used_champs = {c.champ.id for c in picks}
            for c in per_player[i]:
                if c.role in used_roles or c.champ.id in used_champs:
                    continue
                new = picks + [c]
                k = _key(new)
                if k in nxt:
                    continue
                score, _ = _evaluate(ctx, theme, new)
                nxt[k] = (score, new)
        if not nxt:
            return []
        states = sorted(nxt.values(), key=lambda s: (-s[0], _key(s[1])))[:beam]

    results: dict[tuple, tuple[float, dict, list[Cand]]] = {}
    for _, picks in states[: max(keep, 3)]:
        picks = _improve(ctx, theme, picks, per_player)
        score, parts = _evaluate(ctx, theme, picks)
        results[_key(picks)] = (score, parts, picks)
    for score, picks in states:
        k = _key(picks)
        if k not in results:
            results[k] = (score, _evaluate(ctx, theme, picks)[1], picks)
    out = sorted(results.values(), key=lambda r: (-r[0], _key(r[2])))
    return out


def _improve(ctx: _Ctx, theme: ThemeDef, picks: list[Cand], per_player: list[list[Cand]]) -> list[Cand]:
    best, _ = _evaluate(ctx, theme, picks)
    for _ in range(3):
        improved = False
        for pos in range(len(picks)):
            cur = picks[pos]
            others = picks[:pos] + picks[pos + 1:]
            used_roles = {c.role for c in others}
            used_champs = {c.champ.id for c in others}
            for c in per_player[cur.pidx]:
                if c is cur or c.role in used_roles or c.champ.id in used_champs:
                    continue
                trial = others[:pos] + [c] + others[pos:]
                s, _ = _evaluate(ctx, theme, trial)
                if s > best + 1e-9:
                    best, picks, improved = s, trial, True
                    cur = c
                    others = picks[:pos] + picks[pos + 1:]
        # swap the (role, champion) of two players when both know the other's pick
        lookup = [{(c.role, c.champ.id): c for c in cands} for cands in per_player]
        for a in range(len(picks)):
            for b in range(a + 1, len(picks)):
                pa, pb = picks[a], picks[b]
                ca = lookup[pa.pidx].get((pb.role, pb.champ.id))
                cb = lookup[pb.pidx].get((pa.role, pa.champ.id))
                if ca is None or cb is None:
                    continue
                trial = list(picks)
                trial[a], trial[b] = ca, cb
                s, _ = _evaluate(ctx, theme, trial)
                if s > best + 1e-9:
                    best, picks, improved = s, trial, True
        if not improved:
            break
    return picks


# --------------------------------------------------------------------------- output


def _reasons(ctx: _Ctx, theme: ThemeDef, c: Cand, picks: Sequence[Cand]) -> list[str]:
    pl = ctx.players[c.pidx]
    out: list[str] = []
    e = c.entry
    if c.locked:
        out.append("Choix verrouillé")
    if e and e.mastery_points >= 1000:
        pts = _fmt_points(e.mastery_points)
        out.append(f"Champion maîtrisé ({pts} points)" if e.comfort >= 0.45 else f"Déjà joué ({pts} points de maîtrise)")
    if e and e.recent_games > 0:
        wr = round(100 * e.recent_wins / e.recent_games)
        plural = "s" if e.recent_games > 1 else ""
        out.append(f"Joué récemment ({e.recent_games} partie{plural}, {wr} % de victoires)")
    if e and "manual" in e.sources and e.mastery_points < 1000 and e.recent_games == 0:
        out.append(f"Dans ton pool (confort {round(e.comfort * 100)} %)")
    if c.champ.id in pl.wanted:
        out.append("Champion que tu as envie de jouer")
    elif c.champ.archetype in pl.wanted_arch:
        out.append(f"Correspond à ton envie : {archetype_label(c.champ.archetype)}")
    if c.comfort < 0.1 and c.champ.id not in pl.wanted and not c.locked:
        out.append("Découverte : un nouveau champion à essayer")
    label = ROLE_LABELS[c.role]
    prefs = pl.inp.preferences.roles
    if pl.forced:
        out.append(f"Rôle imposé : {label}")
    elif prefs and prefs[0] == c.role:
        out.append(f"Ton rôle préféré ({label})")
    elif c.role in prefs:
        out.append(f"Rôle souhaité ({label})")
    elif prefs:
        out.append(f"Rôle de dépannage ({label})")
    elif pl.inp.role_games.get(c.role, 0) > 0:
        out.append(f"Rôle que tu joues souvent ({label})")
    # contribution to the theme
    if theme.thematic:
        if theme.pairs_theme:
            ids = {p.champ.id for p in picks}
            for a, b, desc in lore_pairs():
                if c.champ.id in (a, b) and a in ids and b in ids:
                    other = b if c.champ.id == a else a
                    out.append(f"Lien de lore avec {ctx.catalog.name(other)} : {desc}")
                    break
        elif theme.is_member(c.champ):
            out.append(f"Colle au thème : {theme.label}")
    else:
        best_t, best_v = None, 0.0
        for i, w in theme.weights:
            v = c.champ.traits[i] * w
            if c.champ.traits[i] >= 2 and v > best_v:
                best_t, best_v = i, v
        if best_t is not None:
            out.append(f"Apporte {TRAIT_FR[TRAITS[best_t]]} à la compo")
    return out


def _suggestion(ctx: _Ctx, theme: ThemeDef, score: float, parts: dict, picks: list[Cand]) -> CompositionSuggestion:
    champs = [c.champ for c in picks]
    strengths, warnings = team_notes(champs, ignore_damage=theme.ignore_damage_mix)
    if theme.thematic:
        members = len(theme.members_in(champs))
        need = theme.required_members(len(champs))
        if members >= need:
            strengths.insert(0, f"Thème respecté : {members}/{len(champs)} champions « {theme.label} »")
        else:
            warnings.insert(0, f"Thème partiellement respecté : {members}/{len(champs)} champions « {theme.label} »")
    if ctx.enemy:
        lines = counter_details(champs, ctx.enemy)
        for l in sorted(lines, key=lambda l: (-l.threat, l.key)):
            if l.threat >= 0.5 and l.answer >= 0.7:
                strengths.append(f"Bonne réponse {COUNTER_FR[l.key]}")
            elif l.threat >= 0.5 and l.answer < 0.4:
                warnings.append(f"Peu de réponses {COUNTER_FR[l.key]}")
    ordered = sorted(picks, key=lambda c: ROLE_ORDER.index(c.role))
    sp = [
        SuggestedPick(
            role=c.role,
            champion_id=c.champ.id,
            player_id=ctx.players[c.pidx].inp.player_id,
            comfort=round(c.comfort, 3),
            desire=round(c.desire, 3),
            reasons=_reasons(ctx, theme, c, picks),
        )
        for c in ordered
    ]
    return CompositionSuggestion(
        theme=theme.key,
        theme_label=theme.label,
        score=round(score * 100, 1),
        breakdown=ScoreBreakdown(
            comfort=round(parts["comfort"] * 100, 1),
            desire=round(parts["desire"] * 100, 1),
            theme_fit=round(parts["theme_fit"] * 100, 1),
            balance=round(parts["balance"] * 100, 1),
            counter=round(parts["counter"] * 100, 1) if "counter" in parts else None,
        ),
        picks=sp,
        strengths=strengths[:6],
        warnings=warnings[:5],
    )


def _differs(a: tuple, b: tuple, min_diff: int) -> bool:
    return len(set(a) ^ set(b)) // 2 >= min_diff


def generate_compositions(
    players: list[PlayerInput], options: GenerationOptions, catalog: ChampionCatalog
) -> list[CompositionSuggestion]:
    if not players:
        return []
    if len(players) > 5:
        raise ValueError("Une composition compte au plus 5 joueurs")
    ctx = _prepare(players, options, catalog)
    count = options.count

    theme = get_theme(options.theme)
    if theme is not None:
        # repeated searches, each one penalising the picks already proposed -> diverse lineups
        chosen: list[tuple[float, dict, list[Cand]]] = []
        keys: list[frozenset[str]] = []
        ctx.penalty = {}
        for _ in range(count * 2):
            if sum(1 for r in chosen if theme.satisfied([c.champ for c in r[2]])) >= count:
                break
            found = _search(ctx, theme, explicit=True, beam=16, limit=20, keep=3)
            fresh = [r for r in found if frozenset(c.champ.id for c in r[2]) not in keys]
            ok = [r for r in fresh if theme.satisfied([c.champ for c in r[2]])]
            new = (ok or fresh or [None])[0]
            if new is None:
                break
            keys.append(frozenset(c.champ.id for c in new[2]))
            chosen.append(new)
            for c in new[2]:
                ctx.penalty[c.champ.id] = ctx.penalty.get(c.champ.id, 0.0) + 0.02
        ctx.penalty = None
        chosen = [(*_evaluate(ctx, theme, r[2]), r[2]) for r in chosen]
        if any(theme.satisfied([c.champ for c in r[2]]) for r in chosen):
            chosen = [r for r in chosen if theme.satisfied([c.champ for c in r[2]])]
        chosen.sort(key=lambda r: (-r[0], _key(r[2])))
        chosen = chosen[:count]
        return [_suggestion(ctx, theme, s, p, picks) for s, p, picks in chosen]

    # automatic mode: best lineups across diverse themes
    per_theme: list[tuple[ThemeDef, list[tuple[float, dict, list[Cand]]]]] = []
    for t in all_themes():
        found = _search(ctx, t, explicit=False, beam=8, limit=14, keep=2)
        if t.thematic:
            # fun themes stay in the mix but a strategic lineup wins a tie
            found = [
                (r[0] * AUTO_THEMATIC_FACTOR, r[1], r[2])
                for r in found
                if t.satisfied([c.champ for c in r[2]]) and len(r[2]) >= 3
            ]
        if found:
            per_theme.append((t, found))
    per_theme.sort(key=lambda x: (-x[1][0][0], x[0].key))
    chosen_t: list[tuple[ThemeDef, tuple[float, dict, list[Cand]]]] = []
    keys = []
    for depth in range(3):
        for t, found in per_theme:
            if len(chosen_t) >= count:
                break
            if depth >= len(found):
                continue
            r = found[depth]
            k = _key(r[2])
            if any(not _differs(k, o, 2 if depth == 0 else 1) for o in keys):
                # same lineup already proposed under another theme: try the next one
                alt = next((x for x in found[depth + 1:] if all(_differs(_key(x[2]), o, 1) for o in keys)), None)
                if alt is None:
                    continue
                r, k = alt, _key(alt[2])
            chosen_t.append((t, r))
            keys.append(k)
        if len(chosen_t) >= count:
            break
    chosen_t.sort(key=lambda x: (-x[1][0], x[0].key))
    return [_suggestion(ctx, t, s, p, picks) for t, (s, p, picks) in chosen_t]
