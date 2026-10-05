"""Game plan ("comment jouer la compo") and matchup plan ("comment jouer contre eux")."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

from .analysis import DIVE_ARCHES, DPS_ARCHES, SQUISHY_CARRY_ARCHES, counter_details, team_notes
from .catalog import DAMAGE_ARCHETYPES, ChampData, ChampionCatalog, archetype_label, placeholder_data
from .models import GamePlan, LaneMatchup, MatchupPlan, PhasePlan, Pick, Role, RoleTip, ThreatInfo
from .themes import ThemeDef, detect_themes, lore_pairs

ROLE_ORDER = [Role.TOP, Role.JUNGLE, Role.MID, Role.BOTTOM, Role.SUPPORT]

# Champions whose kit puts several enemies airborne (Yasuo / Yone ultimate follow-up).
KNOCKUPS = {
    "Malphite", "Alistar", "Nautilus", "Rakan", "Janna", "Ornn", "Sejuani", "MonkeyKing", "Zac",
    "Vi", "XinZhao", "Rell", "Chogath", "JarvanIV", "Gragas", "LeeSin", "Poppy", "Kalista",
    "Gnar", "Aatrox", "Diana", "Nami", "Thresh", "Volibear", "Camille", "Sion", "KSante",
    "Lillia", "Skarner", "Tristana", "Azir", "Braum", "Leona", "Shyvana",
}
KNOCKUP_DUO = {
    "Yasuo": "son ultime (Dernier Souffle) s'enchaîne sur chaque cible projetée en l'air",
    "Yone": "son ultime et son Q3 enchaînent sur les cibles projetées en l'air",
}

FAMOUS_COMBOS: list[tuple[str, str, str]] = [
    ("Orianna", "Malphite", "Orianna place sa balle sur Malphite : son ultime suit l'engage et regroupe tout le monde"),
    ("Orianna", "JarvanIV", "Jarvan IV enferme l'équipe adverse dans son ultime, Orianna déclenche son onde de choc"),
    ("Orianna", "Zac", "Zac atterrit au milieu des adversaires avec la balle d'Orianna"),
    ("MissFortune", "Amumu", "l'ultime d'Amumu immobilise tout le monde pendant le Barrage de Miss Fortune"),
    ("MissFortune", "Leona", "Leona immobilise, Miss Fortune canalise son ultime sans être interrompue"),
    ("MissFortune", "Galio", "Galio provoque les adversaires sous le Barrage de Miss Fortune"),
    ("Kalista", "Thresh", "Kalista lance Thresh avec son ultime pour un engage imprévisible"),
    ("Kalista", "Skarner", "Kalista projette Skarner, qui ramène un carry adverse avec son ultime"),
    ("Xayah", "Rakan", "Rakan et Xayah se rejoignent par leurs ultimes : engage puis immunité de Xayah"),
    ("Lucian", "Braum", "chaque attaque rapide de Lucian déclenche la passive étourdissante de Braum"),
    ("Lucian", "Nami", "la Marée de Nami enchaîne les tirs rapides de Lucian"),
    ("Twitch", "Lulu", "Lulu rend Twitch inarrêtable avec son bouclier et son ultime"),
    ("KogMaw", "Lulu", "Lulu protège Kog'Maw, la tourelle humaine de l'équipe"),
    ("Jinx", "Lulu", "Lulu garde Jinx en vie le temps qu'elle s'emballe"),
    ("MasterYi", "Taric", "Taric rend Master Yi invulnérable en plein milieu des combats"),
    ("Kayle", "Taric", "Taric et Kayle superposent leurs invulnérabilités"),
    ("TwistedFate", "Nocturne", "deux ultimes globaux : Twisted Fate et Nocturne tombent ensemble sur une cible"),
    ("Galio", "Nocturne", "Nocturne plonge sous Paranoïa, Galio arrive par son ultime"),
    ("Galio", "Camille", "Camille isole une cible dans son ultime, Galio la rejoint"),
    ("Sion", "Orianna", "Sion fonce dans l'équipe adverse avec la balle d'Orianna"),
    ("Yasuo", "Malphite", "l'ultime de Malphite projette toute l'équipe : Yasuo enchaîne son Dernier Souffle"),
    ("Yasuo", "Diana", "Diana regroupe les adversaires, Yasuo enchaîne derrière une projection"),
    ("Zilean", "Kayle", "Zilean empêche Kayle de mourir pendant qu'elle scale"),
    ("Sona", "Taric", "Taric et Sona : soins, boucliers et contrôles en chaîne"),
    ("Jhin", "Zyra", "les racines de Zyra préparent le W de Jhin"),
    ("Ashe", "Sejuani", "la flèche d'Ashe et l'engage de Sejuani gèlent toute une équipe"),
    ("Caitlyn", "Lux", "les pièges de Caitlyn sur cibles immobilisées par Lux"),
    ("Nidalee", "Caitlyn", "double poke à longue portée sous les tours adverses"),
    ("Rumble", "Amumu", "Amumu bloque les adversaires dans l'Égaliseur de Rumble"),
    ("Kennen", "Galio", "Kennen plonge, Galio suit avec son ultime pour un double contrôle de zone"),
    ("Pantheon", "TwistedFate", "Twisted Fate et Pantheon tombent ensemble sur une lane"),
    ("Shen", "Ezreal", "Shen protège Ezreal où qu'il soit sur la carte"),
    ("Zoe", "Yuumi", "Yuumi accompagne Zoe partout"),
]

ARCH_SPIKES: dict[str, str] = {
    "vanguard": "niveau 6 (ultime d'engage) et premier objet de tank",
    "warden": "premier objet de soutien et niveau 6",
    "juggernaut": "premier objet complet : domine les combats rapprochés",
    "diver": "niveau 6 et premier objet : peut plonger sur les carries",
    "skirmisher": "2 à 3 objets : devient un monstre en duel",
    "assassin": "niveau 6 et premier objet de létalité",
    "burst_mage": "niveau 6 et premier objet de puissance",
    "battlemage": "2 objets : dégâts de zone continus en combat",
    "artillery": "premier objet de mana/puissance : poke très punitive",
    "marksman": "2 à 3 objets : dégâts continus énormes",
    "enchanter": "premier objet de soin/bouclier",
    "catcher": "niveau 2 et niveau 6 : menace d'engage permanente",
    "specialist": "dépend de son kit : surveille ses niveaux clés",
}

ARCH_PLAY: dict[str, str] = {
    "vanguard": "Tank d'engage : tu ouvres les combats et tu encaisses.",
    "warden": "Tank protecteur : tu restes près de tes carries et tu repousses les plongeurs.",
    "juggernaut": "Combattant résistant : tu avances et tu tapes tout ce qui est à portée.",
    "diver": "Plongeur : tu sautes sur un carry adverse au bon moment.",
    "skirmisher": "Duelliste : tu gagnes les 1v1 et tu tiens une lane seul.",
    "assassin": "Assassin : tu attends qu'une cible fragile soit exposée pour la tuer.",
    "burst_mage": "Mage burst : tu combos une cible puis tu te replaces.",
    "battlemage": "Mage de combat : tu restes au cœur du combat pour faire des dégâts de zone.",
    "artillery": "Mage artilleur : tu pokes de très loin et tu ne te laisses pas atteindre.",
    "marksman": "Tireur : tu tapes ce qui est à portée en restant derrière ta frontline.",
    "enchanter": "Enchanteur : boucliers, soins et buffs sur tes carries.",
    "catcher": "Attrapeur : tu cherches à immobiliser une cible isolée.",
    "specialist": "Spécialiste : joue autour des forces uniques de ton kit.",
}

ARCH_JOB: dict[str, str] = {
    "vanguard": "Ton job : doubler l'engage et encaisser en première ligne.",
    "warden": "Ton job : rester devant tes carries et repousser les plongeurs.",
    "juggernaut": "Ton job : avancer en première ligne et taper tout ce qui est à portée.",
    "diver": "Ton job : atteindre les carries adverses une fois leurs sorts défensifs utilisés.",
    "skirmisher": "Ton job : gagner les duels et punir les adversaires qui s'isolent.",
    "assassin": "Ton job : éliminer un carry adverse exposé, puis ressortir.",
    "burst_mage": "Ton job : effacer une cible prioritaire avec ton combo.",
    "battlemage": "Ton job : placer tes dégâts de zone sur les cibles regroupées.",
    "artillery": "Ton job : user l'adversaire de loin avant et pendant les combats.",
    "marksman": "Ton job : faire des dégâts continus à portée maximale.",
    "enchanter": "Ton job : renforcer tes carries avec boucliers, soins et buffs.",
    "catcher": "Ton job : trouver le pick qui ouvre le combat.",
}


# --------------------------------------------------------------------------- team view


class _Fmt(dict):
    def __missing__(self, key: str) -> str:
        return "votre équipe"


def _names(champs: Iterable[ChampData]) -> str:
    names = [c.name for c in champs]
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " et " + names[-1]


def _best(champs: Sequence[ChampData], key, minimum: float = 0) -> ChampData | None:
    best = None
    best_v = None
    for c in champs:
        v = key(c)
        if v < minimum:
            continue
        if best_v is None or v > best_v or (v == best_v and c.name < best.name):  # type: ignore[union-attr]
            best, best_v = c, v
    return best


def _carry_score(c: ChampData) -> float:
    return c["late"] * 2 + (2 if c.archetype in DAMAGE_ARCHETYPES else 0) + (1 if c.archetype == "marksman" else 0) + c["teamfight"] * 0.3


@dataclass
class Team:
    picks: list[tuple[Role | None, ChampData]]

    @property
    def champs(self) -> list[ChampData]:
        return [c for _, c in self.picks]

    def role_of(self, c: ChampData) -> Role | None:
        for r, x in self.picks:
            if x is c:
                return r
        return None

    def by_role(self, role: Role) -> ChampData | None:
        for r, c in self.picks:
            if r == role:
                return c
        return None

    @property
    def n(self) -> int:
        return len(self.picks)

    def avg(self, trait: str) -> float:
        return sum(c[trait] for c in self.champs) / self.n if self.n else 0.0

    def total(self, trait: str) -> int:
        return sum(c[trait] for c in self.champs)

    @property
    def engager(self) -> ChampData | None:
        return _best(self.champs, lambda c: c["engage"] * 2 + c["cc"] + c["frontline"] * 0.5, 4)

    @property
    def carry(self) -> ChampData | None:
        return _best(self.champs, _carry_score, 0)

    @property
    def frontliner(self) -> ChampData | None:
        return _best(self.champs, lambda c: c["frontline"], 2)

    @property
    def peeler(self) -> ChampData | None:
        carry = self.carry
        return _best([c for c in self.champs if c is not carry], lambda c: c["peel"] * 2 + c["cc"] * 0.5, 4)

    @property
    def poker(self) -> ChampData | None:
        return _best(self.champs, lambda c: c["poke"], 2)

    @property
    def splitter(self) -> ChampData | None:
        return _best(self.champs, lambda c: c["splitpush"], 3)

    @property
    def picker(self) -> ChampData | None:
        return _best(self.champs, lambda c: c["pick"] * 2 + c["cc"], 5)

    @property
    def cc_holder(self) -> ChampData | None:
        return _best(self.champs, lambda c: c["cc"], 2)

    def aoe(self, exclude: ChampData | None = None) -> ChampData | None:
        return _best([c for c in self.champs if c is not exclude], lambda c: c["teamfight"] + (1 if c.archetype in DAMAGE_ARCHETYPES else 0), 3)

    def fmt(self) -> _Fmt:
        d = _Fmt()
        for key in ("engager", "carry", "frontliner", "peeler", "poker", "splitter", "picker"):
            c = getattr(self, key)
            if c is not None:
                d[key] = c.name
        jg = self.by_role(Role.JUNGLE)
        d["jungler"] = jg.name if jg else "votre jungler"
        aoe = self.aoe(self.engager)
        d["tf"] = aoe.name if aoe else d.get("carry", "vos carries")
        divers = [c for c in self.champs if c.archetype in DIVE_ARCHES or (c.archetype == "vanguard" and c["mobility"] >= 2)]
        d["divers"] = _names(divers[:3]) or d.get("engager", "vos plongeurs")
        sk = [c for c in self.champs if c.archetype in {"skirmisher", "diver", "juggernaut", "assassin"}]
        d["skirmishers"] = _names(sk[:3]) or d["jungler"]
        d.setdefault("carry", "votre carry")
        d.setdefault("engager", d.get("frontliner", "votre frontline"))
        d.setdefault("peeler", d.get("frontliner", "votre support"))
        d.setdefault("poker", d["carry"])
        d.setdefault("splitter", d.get("frontliner", d["carry"]))
        d.setdefault("picker", d["engager"])
        d.setdefault("frontliner", d["engager"])
        return d


def _team(picks: Sequence[Pick], catalog: ChampionCatalog) -> Team:
    out = []
    for p in picks:
        d = catalog.data(p.champion_id) or placeholder_data(p.champion_id)
        out.append((p.role, d))
    out.sort(key=lambda x: ROLE_ORDER.index(x[0]) if x[0] in ROLE_ORDER else 9)
    return Team(out)


def _strategy_theme(themes: list[tuple[ThemeDef, float]], team: Team) -> ThemeDef | None:
    """The playstyle used for strategic advice (thematic themes have no strategy of their own)."""
    for t, _ in themes:
        if not t.thematic:
            return t
    found = detect_themes(team.champs, limit=10)
    for t, _ in found:
        if not t.thematic:
            return t
    return None


# --------------------------------------------------------------------------- texts per playstyle

WIN: dict[str, list[str]] = {
    "engage": [
        "Grouper à 5 autour des objectifs et laisser {engager} lancer le combat sur plusieurs cibles",
        "Enchaîner les sorts de zone de {tf} juste après l'engage",
        "Gagner les combats à 5 avant que l'adversaire ne puisse vous kiter",
    ],
    "pick": [
        "Prendre la vision dans la jungle adverse pour attraper un isolé avec {picker}",
        "Transformer chaque pick en objectif immédiat (drake, Héraut, tour)",
        "Éviter les 5v5 frontaux à nombre égal",
    ],
    "poke_siege": [
        "User l'adversaire avec {poker} avant chaque objectif",
        "Assiéger les tours : l'adversaire ne peut pas défendre en restant à moitié de vie",
        "N'engager que lorsque l'adversaire a perdu une bonne partie de ses PV",
    ],
    "protect_carry": [
        "Garder {carry} en vie : toute l'équipe joue autour de lui",
        "{peeler} reste collé à {carry} au lieu de chercher des kills",
        "Laisser l'adversaire engager puis contre-attaquer quand ses sorts sont utilisés",
    ],
    "split_push": [
        "{splitter} pousse une lane latérale et attire deux adversaires",
        "Les autres tiennent le milieu sans engager et prennent l'objectif du côté opposé",
        "Forcer l'adversaire à choisir entre sa tour et l'objectif",
    ],
    "dive": [
        "Plonger ensemble sur les carries adverses : {divers} doivent arriver en même temps",
        "Tuer le carry adverse dans les premières secondes du combat",
        "Utiliser la mobilité pour attaquer par les flancs plutôt que de face",
    ],
    "early_snowball": [
        "Gagner les lanes et multiplier les ganks avec {jungler}",
        "Prendre Larves du Néant, Héraut et drakes tant que vous êtes plus forts",
        "Finir la partie avant 25-30 minutes",
    ],
    "scaling": [
        "Survivre aux 15 premières minutes sans donner d'or",
        "Farmer pour que {carry} complète ses objets",
        "Gagner les gros combats de fin de partie autour du Nashor et de l'Âme du dragon",
    ],
    "skirmish": [
        "Gagner les escarmouches à 2 ou 3 autour de la jungle et des buffs",
        "Punir chaque adversaire isolé avec {skirmishers}",
        "Convertir chaque escarmouche gagnée en objectif neutre",
    ],
}

ENEMY_WIN: dict[str, str] = {
    "engage": "{engager} cherche un gros engage sur plusieurs d'entre vous, suivi des dégâts de zone de {tf}",
    "pick": "Ils veulent attraper un joueur isolé avec {picker} puis jouer à 5 contre 4",
    "poke_siege": "Ils veulent vous user avec {poker} avant chaque objectif et assiéger vos tours",
    "protect_carry": "Tout tourne autour de {carry}, protégé par {peeler}",
    "split_push": "{splitter} va split push pour forcer votre équipe à se diviser",
    "dive": "Ils vont plonger sur vos carries avec {divers}",
    "early_snowball": "Ils veulent prendre l'avance tôt (ganks, invades) et finir vite",
    "scaling": "Ils veulent atteindre la fin de partie, où {carry} devient dominant",
    "skirmish": "Ils cherchent des escarmouches à 2-3 dans la jungle avec {skirmishers}",
}

MID: dict[str, tuple[str, list[str]]] = {
    "engage": ("Regroupez-vous pour les objectifs et cherchez le combat à 5.", [
        "Arrivez sur le drake 30 secondes avant son apparition pour poser la vision",
        "{engager} engage quand au moins 3 adversaires sont regroupés",
    ]),
    "pick": ("Jouez la vision et les embuscades dans la jungle.", [
        "Placez des balises profondes et attendez un adversaire qui ward seul",
        "{picker} se cache dans les buissons sur le chemin des adversaires",
    ]),
    "poke_siege": ("Poussez les vagues et assiégez les tours avec la poke.", [
        "Prenez le Héraut et cassez les tours extérieures",
        "{poker} use la cible avant chaque engagement",
    ]),
    "protect_carry": ("Laissez {carry} farmer en sécurité et jouez autour de lui.", [
        "Donnez les vagues de sbires sûres à {carry}",
        "{peeler} accompagne {carry} sur toute la carte",
    ]),
    "split_push": ("Mettez en place le 1-3-1 : {splitter} sur une lane latérale.", [
        "{splitter} garde la vision de la jungle adjacente pour ne pas se faire collapse",
        "Le groupe central nettoie les vagues et ne combat pas sans {splitter}",
    ]),
    "dive": ("Cherchez les combats où vous pouvez atteindre les carries.", [
        "Plongez quand les sorts défensifs adverses (Flash, Zhonya, peel) sont utilisés",
        "Attaquez par les flancs avec {divers}",
    ]),
    "early_snowball": ("Transformez l'avance en tours et en objectifs.", [
        "Envahissez la jungle adverse avec la priorité de lane",
        "Prenez les tours avec le Héraut et rapprochez-vous de la base adverse",
    ]),
    "scaling": ("Farmez et ne prenez pas de combats inutiles.", [
        "Échangez les objectifs plutôt que de combattre en infériorité",
        "Protégez {carry} pendant qu'il complète ses objets",
    ]),
    "skirmish": ("Restez près de votre jungler et cherchez les 2v2/3v3.", [
        "Contestez les buffs et le Carapateur avec {skirmishers}",
        "Envahissez quand vos lanes ont la priorité",
    ]),
}

LATE: dict[str, tuple[str, list[str]]] = {
    "engage": ("Un bon engage sur le Nashor ou l'Âme gagne la partie.", [
        "Ne vous dispersez pas : cherchez le combat à 5 près des objectifs",
    ]),
    "pick": ("Un pick sur un carry adverse = Nashor gratuit.", [
        "Ne combattez pas à 5 sans avoir attrapé quelqu'un d'abord",
    ]),
    "poke_siege": ("Assiégez avec la poke et n'engagez qu'une fois l'adversaire affaibli.", [
        "Ne vous faites pas attraper en avançant pour poker : restez groupés",
    ]),
    "protect_carry": ("{carry} doit taper du début à la fin de chaque combat.", [
        "Placez-vous en formation : frontline devant, {peeler} à côté de {carry}",
    ]),
    "split_push": ("{splitter} met la pression d'un côté pendant que l'équipe prend le Nashor ou un inhibiteur.", [
        "Ne combattez pas à 4 contre 5 sans raison : reculez si l'adversaire force",
    ]),
    "dive": ("Plongez ensemble sur la backline au premier faux pas adverse.", [
        "Ciblez le carry adverse en priorité, ignorez la frontline",
    ]),
    "early_snowball": ("Plus la partie dure, moins votre avance compte : forcez la fin.", [
        "Avec le Nashor, poussez directement les inhibiteurs",
    ]),
    "scaling": ("Vous êtes la meilleure équipe de fin de partie : combattez autour du Nashor et de l'Âme.", [
        "Un seul mort de {carry} peut coûter la partie : positionnement prudent",
    ]),
    "skirmish": ("Restez groupés à 3 minimum et punissez les isolés.", [
        "Évitez les combats à 5 en ligne droite face à une meilleure compo de teamfight",
    ]),
}

AVOID: dict[str, list[str]] = {
    "engage": ["Engager à 2 ou 3 pendant que le reste de l'équipe est loin"],
    "pick": ["Se battre à 5 contre 5 de face sans avoir pris l'avantage numérique"],
    "poke_siege": ["Engager à 5 contre 5 quand l'adversaire est encore full vie"],
    "protect_carry": ["Laisser {carry} seul sur une lane latérale sans vision"],
    "split_push": ["Que {splitter} split sans vision : un mort coûte un objectif à l'équipe"],
    "dive": ["Plonger un par un : un plongeur seul meurt avant d'avoir servi"],
    "early_snowball": ["Laisser traîner la partie : chaque minute rapproche l'adversaire de ses objets"],
    "scaling": ["Forcer des combats avant que {carry} ait au moins 2 objets"],
    "skirmish": ["Se battre en ligne droite à 5 contre une compo de teamfight"],
}


def _fill(text: str, fmt: _Fmt) -> str:
    return text.format_map(fmt)


# --------------------------------------------------------------------------- game plan


def _identity(team: Team, themes: list[tuple[ThemeDef, float]], strat: ThemeDef | None, prefix: str = "Compo") -> str:
    if not team.n:
        return "Aucun champion sélectionné."
    label = themes[0][0].label if themes else "équilibrée"
    head = f"{prefix} « {label} »"
    if themes and themes[0][0].thematic and strat:
        head += f" jouée en « {strat.label} »"
    roles = []
    eng = team.engager
    carry = team.carry
    if eng and eng is not carry:
        roles.append(f"{eng.name} lance les combats")
    if carry:
        roles.append(f"{carry.name} porte les dégâts")
    peel = team.peeler
    if peel and peel not in (eng, carry) and (strat and strat.key == "protect_carry" or peel["peel"] >= 3):
        roles.append(f"{peel.name} protège {carry.name if carry else 'les carries'}")
    split = team.splitter
    if split and split not in (eng, carry) and strat and strat.key == "split_push":
        roles.append(f"{split.name} met la pression en split push")
    poke = team.poker
    if poke and poke is not carry and poke["poke"] >= 3 and len(roles) < 3:
        roles.append(f"{poke.name} use l'adversaire à distance")
    if not roles:
        return head + "."
    return head + " : " + ", ".join(roles[:-1]) + (" et " if len(roles) > 1 else "") + roles[-1] + "."


def _phases(team: Team, strat: ThemeDef | None, fmt: _Fmt) -> list[PhasePlan]:
    early_avg, late_avg = team.avg("early"), team.avg("late")
    tips: list[str] = []
    if early_avg >= 2.2:
        summary = "Votre début de partie est fort : prenez l'initiative."
    elif early_avg <= 1.4:
        summary = "Votre début de partie est faible : farmez et évitez les morts inutiles."
    else:
        summary = "Début de partie équilibré : jouez vos lanes favorables."
    strong = sorted([c for c in team.champs if c["early"] >= 3], key=lambda c: c.name)
    weak = sorted([c for c in team.champs if c["early"] <= 1 and c["late"] >= 3], key=lambda c: c.name)
    for c in strong[:2]:
        tips.append(f"{c.name} : gros potentiel en début de partie, cherche les échanges et les kills avant que l'adversaire ne scale")
    for c in weak[:2]:
        tips.append(f"{c.name} : début de partie difficile, farme en sécurité, son moment viendra")
    jg = team.by_role(Role.JUNGLE)
    if jg:
        lanes = [c for c in team.champs if c is not jg and c["early"] >= 2 and c["cc"] >= 2]
        target = lanes[0].name if lanes else None
        if jg["early"] >= 2:
            tips.append(f"{jg.name} peut ganker tôt" + (f", en priorité avec {target}" if target else "") + " ou envahir")
        else:
            tips.append(f"{jg.name} doit farmer et contre-ganker plutôt que de forcer des ganks")
    if strat and strat.key in ("pick", "skirmish", "early_snowball"):
        tips.append("Prenez le contrôle de la vision autour du premier drake et des Larves du Néant")
    phases = [PhasePlan(phase="early", summary=summary, tips=tips)]

    key = strat.key if strat else "engage"
    mid_s, mid_t = MID.get(key, MID["engage"])
    late_s, late_t = LATE.get(key, LATE["engage"])
    mid_tips = [_fill(t, fmt) for t in mid_t]
    if team.splitter and key != "split_push":
        mid_tips.append(f"{team.splitter.name} peut split push entre deux objectifs pour attirer l'attention")
    late_tips = [_fill(t, fmt) for t in late_t]
    carry = team.carry
    if carry and carry.archetype in SQUISHY_CARRY_ARCHES:
        front = team.frontliner
        late_tips.append(f"{carry.name} se place derrière " + (front.name if front else "le reste de l'équipe") + " et tape ce qui est à portée")
    if late_avg >= 2.4:
        late_s += " Le temps joue pour vous."
    elif late_avg <= 1.5:
        late_s += " Attention : l'adversaire scale probablement mieux."
    phases.append(PhasePlan(phase="mid", summary=_fill(mid_s, fmt), tips=mid_tips))
    phases.append(PhasePlan(phase="late", summary=_fill(late_s, fmt), tips=late_tips))
    return phases


def _spikes(team: Team, catalog: ChampionCatalog) -> list[str]:
    out = []
    for _, c in team.picks:
        spikes = catalog.meta(c.id)["power_spikes"]
        if spikes:
            out.append(f"{c.name} : " + ", ".join(spikes[:2]))
        else:
            out.append(f"{c.name} : {ARCH_SPIKES.get(c.archetype, ARCH_SPIKES['specialist'])}")
    return out


def _combos(team: Team) -> list[str]:
    ids = {c.id: c for c in team.champs}
    out: list[str] = []
    used_pairs: set[frozenset[str]] = set()

    def add(a: ChampData, b: ChampData, text: str) -> None:
        pair = frozenset((a.id, b.id))
        if pair in used_pairs or a is b:
            return
        used_pairs.add(pair)
        out.append(f"{a.name} + {b.name} : {text}")

    for a, b, text in FAMOUS_COMBOS:
        if a in ids and b in ids:
            add(ids[a], ids[b], text)
    for duo, text in KNOCKUP_DUO.items():
        if duo in ids:
            for k in sorted(KNOCKUPS):
                if k in ids and k != duo:
                    add(ids[k], ids[duo], f"{ids[k].name} projette les adversaires en l'air, {text}")
                    break
    eng = team.engager
    if eng and eng["engage"] >= 3:
        aoe = team.aoe(eng)
        if aoe:
            add(eng, aoe, f"{eng.name} engage, {aoe.name} déclenche ses dégâts de zone sur les cibles regroupées")
    carry = team.carry
    peel = team.peeler
    if carry and peel and carry["late"] >= 3 and peel["peel"] >= 2:
        add(peel, carry, f"{peel.name} garde {carry.name} en vie : plus le combat dure, plus {carry.name} fait de dégâts")
    catcher = _best([c for c in team.champs if c["pick"] >= 3 and c["cc"] >= 2], lambda c: c["cc"] + c["pick"], 0)
    burst = _best([c for c in team.champs if c is not catcher and c.archetype in {"assassin", "burst_mage"}], lambda c: c["pick"], 0)
    if catcher and burst:
        add(catcher, burst, f"{catcher.name} immobilise une cible, {burst.name} la tue avant qu'elle ne réagisse")
    divers = [c for c in team.champs if c.archetype in DIVE_ARCHES and c["mobility"] >= 2]
    if len(divers) >= 2:
        add(divers[0], divers[1], "plongez ensemble sur la même cible pour la tuer instantanément")
    pairs = [(a, b, d) for a, b, d in lore_pairs() if a in ids and b in ids]
    for a, b, d in pairs[:1]:
        add(ids[a], ids[b], f"lien de lore ({d}) : jouez-les ensemble sur la même lane ou le même côté")
    return out[:5]


def _objectives(team: Team, strat: ThemeDef | None, fmt: _Fmt) -> list[str]:
    out = []
    early, late = team.avg("early"), team.avg("late")
    key = strat.key if strat else ""
    if early >= 2 or key in ("early_snowball", "skirmish", "dive"):
        out.append(f"Larves du Néant et Héraut : prenez-les tôt avec la priorité de lane, {fmt['jungler']} en tête")
        out.append("Drakes : contestez dès le premier, votre début de partie le permet")
    else:
        out.append("Premiers drakes : ne les contestez que si vos lanes ont la priorité, sinon échangez (Larves, farm, plaques)")
    if key == "poke_siege" or team.total("poke") >= 6:
        out.append("Tours : utilisez le Héraut et la poke pour prendre les plaques et les tours extérieures")
    if team.splitter:
        out.append(f"Tours latérales : {team.splitter.name} les fait tomber pendant que l'équipe menace un objectif")
    fast = sorted([c for c in team.champs if c["objective"] >= 3], key=lambda c: c.name)
    if fast:
        out.append(f"{_names(fast[:2])} tape(nt) très vite les objectifs : Nashor rapide possible après un pick")
    if late >= 2.3:
        out.append("Âme du dragon et Nashor : vos combats de fin de partie sont les plus forts, jouez-les sans vous précipiter")
    else:
        out.append("Nashor : prenez-le après un combat gagné ou un pick sur un carry adverse")
    return out


def _role_tips(team: Team, strat: ThemeDef | None, catalog: ChampionCatalog, fmt: _Fmt) -> list[RoleTip]:
    tips_out = []
    eng, carry, peel = team.engager, team.carry, team.peeler
    front, split, poke, picker = team.frontliner, team.splitter, team.poker, team.picker
    for role, c in team.picks:
        tips: list[str] = []
        play = catalog.meta(c.id)["playstyle"] or ARCH_PLAY.get(c.archetype, "")
        if play:
            tips.append(play)
        if c is carry:
            tips.append(f"Ton job : faire les dégâts. Reste derrière {front.name if front and front is not c else 'ta frontline'} et tape ce qui est à portée.")
        elif c is eng:
            target = carry.name if carry else "tes carries"
            tips.append(f"Ton job : lancer les combats. Engage quand {target} est à portée pour suivre.")
        elif c is peel:
            tips.append(f"Ton job : protéger {carry.name if carry else 'tes carries'}. Garde tes sorts pour les plongeurs adverses.")
        elif c is split and strat and strat.key == "split_push":
            tips.append("Ton job : pousser une lane latérale et attirer plusieurs adversaires. Garde Téléportation ou une sortie.")
        elif c is poke and c["poke"] >= 3:
            tips.append("Ton job : user l'adversaire avant les combats sans te mettre à portée d'engage.")
        elif c is picker:
            tips.append("Ton job : attraper une cible isolée. Joue autour de la vision et des buissons.")
        elif c is front:
            tips.append("Ton job : encaisser en première ligne et absorber les sorts adverses.")
        else:
            tips.append(ARCH_JOB.get(c.archetype, "Ton job : apporter tes dégâts et tes contrôles en suivant l'engage de l'équipe."))
        if role == Role.JUNGLE:
            strong = [x for x in team.champs if x is not c and x["early"] >= 2 and x["cc"] >= 2]
            if strong:
                tips.append(f"Joue autour des lanes fortes ({_names(strong[:2])}) pour tes ganks.")
        elif role == Role.SUPPORT and carry and carry is not c:
            tips.append(f"Vision : prépare les objectifs 1 minute à l'avance et ne laisse pas {carry.name} sans couverture.")
        tips_out.append(RoleTip(role=role, champion_id=c.id, tips=tips[:3]))
    return tips_out


def _avoid(team: Team, strat: ThemeDef | None, fmt: _Fmt) -> list[str]:
    out = [_fill(t, fmt) for t in AVOID.get(strat.key if strat else "", [])]
    _, warnings = team_notes(team.champs)
    joined = " ".join(warnings)
    if "Pas de frontline" in joined:
        out.append("Se faire engager en ligne droite : sans frontline, gardez vos distances et vos sorts défensifs")
    if "100% AD" in joined or "majoritairement AD" in joined:
        out.append("Les combats longs contre une équipe qui empile l'armure : cherchez les picks")
    if "100% AP" in joined or "majoritairement AP" in joined:
        out.append("Les combats longs contre une équipe qui empile la résistance magique : cherchez les picks")
    if "Waveclear faible" in joined:
        out.append("Laisser les vagues s'accumuler sur vos tours : vous aurez du mal à défendre")
    if "Peu d'engage" in joined:
        out.append("Attendre que l'adversaire fasse une erreur sans créer de pression : poussez les vagues et prenez la vision")
    if team.avg("late") >= 2.4 and (not strat or strat.key != "scaling"):
        out.append(f"Les combats inutiles avant que {fmt['carry']} ait ses objets")
    return out[:5]


def _damage_profile(team: Team) -> dict[str, float]:
    weights = {"AD": 0.0, "AP": 0.0, "MIXED": 0.0}
    for c in team.champs:
        w = 1.5 if c.archetype in DAMAGE_ARCHETYPES else 1.0 if c.archetype in {"juggernaut", "diver", "specialist"} else 0.5
        weights[c.damage if c.damage in weights else "MIXED"] += w
    total = sum(weights.values())
    if total <= 0:
        return {"AD": 0.0, "AP": 0.0, "MIXED": 0.0}
    out = {k: round(v / total, 3) for k, v in weights.items()}
    drift = round(1.0 - sum(out.values()), 3)
    top = max(out, key=lambda k: out[k])
    out[top] = round(out[top] + drift, 3)
    return out


def build_game_plan(picks: list[Pick], catalog: ChampionCatalog) -> GamePlan:
    team = _team(picks, catalog)
    themes = detect_themes(team.champs)
    strat = _strategy_theme(themes, team)
    fmt = team.fmt()
    win = [_fill(t, fmt) for t in WIN.get(strat.key, [])] if strat else []
    if themes and themes[0][0].thematic:
        win.append(f"Assumer le thème « {themes[0][0].label} » : jouez sur les forces de vos champions")
    if not win:
        win = ["Jouer groupé autour des objectifs"]
    if not team.n:
        return GamePlan(
            identity="Aucun champion sélectionné.", detected_themes=[], win_conditions=[], phases=[],
            power_spikes=[], key_combos=[], objectives=[], role_tips=[], avoid=[],
            damage_profile={"AD": 0.0, "AP": 0.0, "MIXED": 0.0},
        )
    return GamePlan(
        identity=_identity(team, themes, strat),
        detected_themes=[t.key for t, _ in themes],
        win_conditions=win,
        phases=_phases(team, strat, fmt),
        power_spikes=_spikes(team, catalog),
        key_combos=_combos(team),
        objectives=_objectives(team, strat, fmt),
        role_tips=_role_tips(team, strat, catalog, fmt),
        avoid=_avoid(team, strat, fmt),
        damage_profile=_damage_profile(team),
    )


# --------------------------------------------------------------------------- matchup plan


def _how_to_win(ours: Team, enemy: Team, our_strat: ThemeDef | None, their_fmt: _Fmt) -> list[str]:
    out: list[str] = []
    fmt = ours.fmt()
    if our_strat and WIN.get(our_strat.key):
        out.append("Votre plan : " + _fill(WIN[our_strat.key][0], fmt)[0].lower() + _fill(WIN[our_strat.key][0], fmt)[1:])
    lines = sorted(counter_details(ours.champs, enemy.champs), key=lambda l: (-l.threat, l.key))
    eng, peel, cc = ours.engager, ours.peeler, ours.cc_holder
    for l in lines:
        if l.threat < 0.45 or len(out) >= 5:
            continue
        if l.key == "dive":
            protector = peel or ours.frontliner or cc
            divers = [c for c in enemy.champs if c.archetype in DIVE_ARCHES]
            top = divers[0].name if divers else "leurs plongeurs"
            if protector:
                out.append(f"Leur dive vise vos carries : restez groupés autour de {protector.name} et gardez vos contrôles pour {top}")
            else:
                out.append(f"Leur dive vise vos carries : jouez groupés et gardez Flash / sorts défensifs pour {top}")
        elif l.key == "poke":
            if eng and eng["engage"] >= 2:
                out.append(f"Ne subissez pas leur poke : {eng.name} doit engager vite ou contourner par un flanc")
            else:
                out.append("Ne restez pas sous leur poke : reculez pour vous soigner et défendez sous tour avec le waveclear")
        elif l.key == "engage":
            text = f"Espacez-vous face à l'engage de {their_fmt['engager']}"
            if peel:
                text += f", puis {peel.name} contre-engage sur ceux qui ont plongé"
            out.append(text)
        elif l.key == "split":
            ans = ours.splitter or _best(ours.champs, lambda c: c["waveclear"] + c["frontline"], 0)
            out.append(f"{ans.name if ans else 'Un joueur solide'} répond à {their_fmt['splitter']} ; les autres forcent un objectif à 5 contre 4")
        elif l.key == "pick":
            out.append(f"Déplacez-vous groupés et wardez avant d'entrer dans la jungle : {their_fmt['picker']} attend un isolé")
        elif l.key == "frontline":
            dps = [c for c in ours.champs if c.archetype in DPS_ARCHES]
            who = dps[0].name if dps else "vos carries"
            out.append(f"Leur frontline est épaisse : {who} tape ce qui est à portée, ne forcez pas un accès impossible à leurs carries")
        elif l.key == "early":
            if ours.avg("early") + 0.3 < enemy.avg("early"):
                out.append("Ils sont plus forts tôt : jouez safe, wardez contre les ganks et cédez un objectif plutôt que de perdre un combat")
            else:
                out.append("Vous tenez la comparaison en début de partie : contestez leurs invades et leurs premiers objectifs")
        elif l.key == "late":
            if ours.avg("late") + 0.3 < enemy.avg("late"):
                out.append(f"Ils scalent mieux ({their_fmt['carry']}) : prenez l'avance tôt et finissez avant leurs objets")
            else:
                out.append("Vous scalez au moins aussi bien : pas de précipitation, gagnez les combats de fin de partie")
    if ours.avg("early") >= enemy.avg("early") + 0.4 and not any("finissez" in t for t in out):
        out.append("Vous êtes plus forts tôt : forcez les combats et les objectifs avant 20 minutes")
    elif ours.avg("late") >= enemy.avg("late") + 0.4 and not any("scalez" in t for t in out):
        out.append("Vous êtes plus forts en fin de partie : limitez la casse au début et jouez les gros objectifs plus tard")
    return out[:6]


def _threat_value(c: ChampData, ours: Team) -> float:
    v = (c["late"] + c["early"]) / 2 + (2.0 if c.archetype in DAMAGE_ARCHETYPES else 0.0)
    v += 0.5 * c["pick"] + (0.8 if c["engage"] >= 3 else 0.0)
    our_peel = ours.total("peel") + 0.5 * ours.total("frontline")
    n = max(1, ours.n)
    if c.archetype in DIVE_ARCHES and our_peel / n < 1.5:
        v += 1.5
    if c["poke"] >= 3 and ours.avg("engage") < 1.4:
        v += 1.0
    if c["engage"] >= 3 and ours.avg("peel") < 1.2:
        v += 1.0
    if c["splitpush"] >= 3 and ours.avg("waveclear") < 1.6:
        v += 1.0
    if c["pick"] >= 3 and ours.avg("mobility") < 1.2:
        v += 0.8
    return v


def _threat_why(c: ChampData, ours: Team) -> str:
    parts: list[str] = []
    squishy = [x for x in ours.champs if x.archetype in SQUISHY_CARRY_ARCHES]
    target = squishy[0].name if squishy else (ours.carry.name if ours.carry else "vos carries")
    if c.archetype == "assassin":
        parts.append(f"assassin capable de tuer {target} en un seul combo")
    elif c.archetype in {"diver", "skirmisher"} and c["mobility"] >= 2:
        parts.append(f"plonge facilement sur {target}")
    if c["engage"] >= 3:
        parts.append("peut lancer un engage sur plusieurs d'entre vous")
    if c["poke"] >= 3:
        parts.append("sa poke va vous user avant chaque combat")
    if c["splitpush"] >= 3:
        parts.append("gagne les duels et met la pression en split push")
    if c["pick"] >= 3 and c.archetype not in {"assassin"}:
        parts.append("peut attraper un joueur isolé")
    if c["late"] >= 3 and c.archetype in DAMAGE_ARCHETYPES:
        parts.append("devient la principale source de dégâts en fin de partie")
    elif c["early"] >= 3:
        parts.append("très fort en début de partie")
    if not parts:
        parts.append(f"{archetype_label(c.archetype).lower()} qui apporte beaucoup à son équipe")
    text = f"{c.name} : " + ", ".join(parts[:2])
    return text[0].upper() + text[1:] + "."


def _threat_handle(c: ChampData, ours: Team, catalog: ChampionCatalog) -> str:
    parts: list[str] = []
    tips = catalog.meta(c.id)["counter_tips"]
    if tips:
        parts.append(tips.strip().rstrip(".") + ".")
    cc = ours.cc_holder
    if c.archetype in DIVE_ARCHES and cc:
        parts.append(f"Gardez les contrôles de {cc.name} pour sa plongée.")
    elif c.archetype in {"marksman", "artillery", "burst_mage", "battlemage"}:
        diver = _best([x for x in ours.champs if x.archetype in DIVE_ARCHES or x["engage"] >= 3], lambda x: x["mobility"] + x["engage"], 0)
        if diver:
            parts.append(f"{diver.name} doit l'atteindre en priorité dans les combats.")
        else:
            parts.append("Forcez-le à se rapprocher : attendez qu'il gaspille ses sorts avant d'engager.")
    elif c["splitpush"] >= 3:
        ans = ours.splitter or ours.frontliner
        if ans:
            parts.append(f"{ans.name} peut le contenir en lane latérale ; sinon prenez un objectif à 5 contre 4.")
    elif c["engage"] >= 3:
        parts.append("Ne restez pas groupés en ligne droite et punissez-le quand son engage est en recharge.")
    if not parts:
        parts.append("Wardez sa position et ne lui donnez pas de kill gratuit.")
    return " ".join(parts[:2])


def _category(c: ChampData) -> str:
    a = c.archetype
    if a in {"vanguard", "warden"}:
        return "tank"
    if a in {"juggernaut", "diver", "skirmisher"}:
        return "fighter"
    if a == "assassin":
        return "assassin"
    if a in {"burst_mage", "battlemage", "artillery"}:
        return "mage"
    if a == "marksman":
        return "marksman"
    if a in {"enchanter", "catcher"}:
        return a
    return "other"


LANE_RULES: dict[tuple[str, str], str] = {
    ("fighter", "tank"): "Tu gagnes les duels sur la durée : punis chacun de ses last-hits et split push, un tank ne peut pas te tuer seul.",
    ("tank", "fighter"): "Ton adversaire te bat en duel : farme prudemment, appelle ton jungler et brille en combat d'équipe.",
    ("tank", "tank"): "Lane passive : farme, garde ta Téléportation pour les combats et le premier drake.",
    ("fighter", "fighter"): "Duel serré : trade quand ses sorts clés sont en recharge et surveille les niveaux.",
    ("fighter", "mage"): "Reste près des sbires pour éviter sa poke et engage quand il gaspille ses sorts.",
    ("mage", "fighter"): "Garde tes distances et punis chacune de ses approches avec tes sorts.",
    ("mage", "assassin"): "Ton adversaire veut te tuer en un combo : garde un sort de survie ou de contrôle pour sa plongée et wardez les flancs.",
    ("assassin", "mage"): "Esquive ses sorts clés puis punis : ton adversaire est vulnérable dès que ses sorts sont en recharge.",
    ("mage", "mage"): "Duel de portée et de mana : pousse ta vague et va aider ton jungler en premier.",
    ("assassin", "assassin"): "Le premier qui rate son combo perd l'échange : joue autour de vos temps de recharge.",
    ("marksman", "marksman"): "Duel de farm et de positionnement : jouez autour de vos niveaux 2 et de vos supports.",
    ("enchanter", "catcher"): "Reste derrière tes sbires pour éviter ses grabs et soigne ou protège ton ADC après chacun de ses engages.",
    ("catcher", "enchanter"): "Force les engages : l'enchanteur ne peut pas tout soigner si tu verrouilles l'ADC.",
    ("enchanter", "enchanter"): "Lane de poke et de soins : gagnez les échanges courts et gérez bien votre mana.",
    ("catcher", "catcher"): "Le premier qui touche son grab gagne la lane : restez derrière vos sbires.",
    ("tank", "enchanter"): "Engage dès que l'enchanteur a utilisé son bouclier ou son soin.",
    ("enchanter", "tank"): "Ne te place pas à portée d'engage et poke ton adversaire dès qu'il avance.",
    ("tank", "catcher"): "Les deux supports cherchent l'engage : celui qui garde ses contrôles pour contre-engager gagne.",
    ("catcher", "tank"): "Les deux supports cherchent l'engage : touche ton grab quand son engage est en recharge.",
    ("assassin", "fighter"): "Ton adversaire encaisse mieux que toi : évite les longs échanges et roam vers les autres lanes.",
    ("fighter", "assassin"): "Ton adversaire ne peut pas te tuer facilement : force les échanges longs et suis ses roams.",
}


def _lane_advice(a: ChampData, e: ChampData, catalog: ChampionCatalog) -> str:
    parts: list[str] = []
    rule = LANE_RULES.get((_category(a), _category(e)))
    if rule:
        parts.append(rule)
    diff = a["early"] - e["early"]
    if diff >= 1:
        parts.append(f"Avantage {a.name} en début de partie : joue agressif avant le niveau 6.")
    elif diff <= -1:
        parts.append(f"Avantage {e.name} en début de partie : évite les échanges longs" + (" et attends ton scaling." if a["late"] > e["late"] else " et attends l'aide de ton jungler."))
    if e["poke"] >= 3 and a["poke"] <= 1:
        parts.append(f"{e.name} harcèle à distance : reste derrière les sbires et engage quand ses sorts sont en recharge.")
    if e["mobility"] >= 3 and a["cc"] >= 2:
        parts.append(f"{e.name} est très mobile : garde tes contrôles pour son entrée en combat.")
    if e["splitpush"] >= 3 and a["splitpush"] < 2:
        parts.append(f"Ne laisse pas {e.name} split sans réponse : signale ses déplacements à ton équipe.")
    tips = catalog.meta(e.id)["counter_tips"]
    if tips:
        first = tips.split(". ")[0].strip().rstrip(".")
        parts.append(first + ".")
    if not parts:
        parts.append("Matchup équilibré : farme proprement et joue autour de ton jungler.")
    return " ".join(parts[:3])


def _suggested_bans(ours: Team, enemy: Team, catalog: ChampionCatalog, limit: int = 3) -> list[str]:
    if not ours.n:
        return []
    taken = {c.id for c in ours.champs} | {c.id for c in enemy.champs}
    n = ours.n
    our_peel = (ours.total("peel") + 0.5 * ours.total("frontline")) / n
    our_engage = ours.avg("engage")
    our_mob = ours.avg("mobility")
    our_wc = ours.avg("waveclear")
    our_early, our_late = ours.avg("early"), ours.avg("late")
    has_squishy_carry = any(c.archetype in SQUISHY_CARRY_ARCHES for c in ours.champs)
    scored = []
    for c in catalog.all_data():
        if c.id in taken or not c.roles:
            continue
        s = 0.0
        if c.archetype in DIVE_ARCHES and has_squishy_carry:
            s += (c["mobility"] + c["pick"]) * (1.3 if our_peel < 1.5 else 0.6)
        if c["poke"] >= 3:
            s += c["poke"] * (1.2 if our_engage < 1.4 else 0.4)
        if c["pick"] >= 3:
            s += c["pick"] * (1.0 if our_mob < 1.3 else 0.4)
        if c["engage"] >= 3:
            s += c["engage"] * (1.0 if ours.avg("peel") < 1.2 else 0.4)
        if c["splitpush"] >= 3:
            s += c["splitpush"] * (1.0 if our_wc < 1.6 else 0.3)
        if our_late > our_early + 0.4:
            s += c["early"] * 0.8
        elif our_early > our_late + 0.4:
            s += c["late"] * 0.8
        s += sum(c.traits) * 0.05
        scored.append((s, c.id))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [cid for _, cid in scored[:limit]]


def _objectives_vs(ours: Team, enemy: Team, our_strat: ThemeDef | None, their_strat: ThemeDef | None, their_fmt: _Fmt) -> list[str]:
    out = []
    oe, ee = ours.avg("early"), enemy.avg("early")
    ol, el = ours.avg("late"), enemy.avg("late")
    if oe >= ee + 0.3:
        out.append("Larves du Néant et premiers drakes : contestez-les, vous êtes plus forts tôt")
    elif oe + 0.3 <= ee:
        out.append("Premiers objectifs : cédez-les s'ils sont mieux placés et prenez l'objectif de l'autre côté de la carte")
    else:
        out.append("Premiers objectifs : celui qui a la priorité en mid et bot doit les prendre, suivez la priorité de lane")
    if their_strat and their_strat.key == "poke_siege":
        out.append("Ne défendez pas une tour sous leur poke : engagez avant le siège ou laissez-la et prenez un objectif ailleurs")
    if their_strat and their_strat.key == "split_push" or enemy.splitter:
        out.append(f"Gardez vos tours latérales sous vision face à {their_fmt['splitter']}")
    if ol >= el + 0.3:
        out.append("Nashor et Âme du dragon : le temps joue pour vous, ne les forcez pas trop tôt")
    elif ol + 0.3 <= el:
        out.append(f"Nashor : prenez-le dès qu'un carry adverse ({their_fmt['carry']}) meurt, avant qu'ils ne scalent")
    else:
        out.append("Nashor : à jouer après un pick ou un combat gagné")
    if ours.splitter:
        out.append(f"{ours.splitter.name} peut forcer des tours latérales pendant qu'ils regardent le drake")
    return out


def build_matchup_plan(ally: list[Pick], enemy: list[Pick], catalog: ChampionCatalog) -> MatchupPlan:
    ours = _team(ally, catalog)
    theirs = _team(enemy, catalog)
    their_themes = detect_themes(theirs.champs)
    their_strat = _strategy_theme(their_themes, theirs) if theirs.n else None
    our_themes = detect_themes(ours.champs)
    our_strat = _strategy_theme(our_themes, ours) if ours.n else None
    their_fmt = theirs.fmt()

    if not theirs.n:
        return MatchupPlan(
            enemy_identity="Aucun champion adverse renseigné.", enemy_themes=[], enemy_win_conditions=[],
            how_to_win=[_fill(t, ours.fmt()) for t in WIN.get(our_strat.key, [])] if our_strat else [],
            threats=[], lane_matchups=[], objectives=[],
            suggested_bans=_suggested_bans(ours, theirs, catalog),
        )

    enemy_win = []
    if their_strat:
        enemy_win.append(_fill(ENEMY_WIN[their_strat.key], their_fmt))
    for t, _ in their_themes[1:]:
        if not t.thematic and t is not their_strat and t.key in ENEMY_WIN:
            enemy_win.append(_fill(ENEMY_WIN[t.key], their_fmt))
    if theirs.avg("late") >= 2.4 and not any("fin de partie" in w for w in enemy_win):
        enemy_win.append(f"Atteindre la fin de partie, où {their_fmt['carry']} fait des dégâts énormes")
    if theirs.avg("early") >= 2.2 and not any("tôt" in w for w in enemy_win):
        enemy_win.append("Prendre l'avance en début de partie et ne jamais la rendre")

    ranked = sorted(theirs.champs, key=lambda c: (-_threat_value(c, ours), c.name))
    threats = []
    count = max(2, min(4, theirs.n))
    for rank, c in enumerate(ranked[:count]):
        v = _threat_value(c, ours)
        danger = 3 if v >= 6 else 2 if v >= 4 else 1
        if rank == 0:
            danger = max(danger, 2)
        threats.append(ThreatInfo(champion_id=c.id, danger=danger, why=_threat_why(c, ours), how_to_handle=_threat_handle(c, ours, catalog)))

    lanes = []
    for role in ROLE_ORDER:
        a, e = ours.by_role(role), theirs.by_role(role)
        if a and e:
            lanes.append(LaneMatchup(role=role, ally_champion_id=a.id, enemy_champion_id=e.id, advice=_lane_advice(a, e, catalog)))

    return MatchupPlan(
        enemy_identity=_identity(theirs, their_themes, their_strat, prefix="Compo adverse"),
        enemy_themes=[t.key for t, _ in their_themes],
        enemy_win_conditions=enemy_win,
        how_to_win=_how_to_win(ours, theirs, our_strat, their_fmt) if ours.n else [],
        threats=threats,
        lane_matchups=lanes,
        objectives=_objectives_vs(ours, theirs, our_strat, their_strat, their_fmt),
        suggested_bans=_suggested_bans(ours, theirs, catalog),
    )


__all__ = ["build_game_plan", "build_matchup_plan"]
