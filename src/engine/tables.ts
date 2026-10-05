import type { Role } from '../api/types';
import type { TraitName } from './traits';

// Constant tables (French texts, theme rules) originally extracted from the former Python engine.
// Changing a string changes engine output: update the golden files in __golden__/ accordingly.
/* eslint-disable */

export const TRAITS: readonly TraitName[] = [
  "engage",
  "peel",
  "poke",
  "waveclear",
  "splitpush",
  "pick",
  "teamfight",
  "early",
  "late",
  "mobility",
  "frontline",
  "cc",
  "sustain",
  "objective"
];

export const ROLE_LABELS: Record<Role, string> = {
  "TOP": "Top",
  "JUNGLE": "Jungle",
  "MID": "Mid",
  "BOTTOM": "ADC",
  "SUPPORT": "Support"
};

export const DEFAULT_ARCHETYPES: { key: string; label: string; description: string }[] = [
  {
    "key": "vanguard",
    "label": "Tank engageur",
    "description": "Tank qui lance les combats."
  },
  {
    "key": "warden",
    "label": "Tank protecteur",
    "description": "Tank qui protège ses carries."
  },
  {
    "key": "juggernaut",
    "label": "Juggernaut",
    "description": "Combattant lent et très résistant."
  },
  {
    "key": "diver",
    "label": "Plongeur",
    "description": "Combattant mobile qui plonge sur les carries."
  },
  {
    "key": "skirmisher",
    "label": "Duelliste",
    "description": "Combattant fort en duel et en split."
  },
  {
    "key": "assassin",
    "label": "Assassin",
    "description": "Élimine une cible fragile en un instant."
  },
  {
    "key": "burst_mage",
    "label": "Mage burst",
    "description": "Mage aux gros dégâts instantanés."
  },
  {
    "key": "battlemage",
    "label": "Mage de combat",
    "description": "Mage qui inflige des dégâts continus au cœur du combat."
  },
  {
    "key": "artillery",
    "label": "Mage artilleur",
    "description": "Mage à très longue portée qui poke."
  },
  {
    "key": "marksman",
    "label": "Tireur",
    "description": "Carry à distance aux dégâts continus."
  },
  {
    "key": "enchanter",
    "label": "Enchanteur",
    "description": "Soutien qui soigne, bouclie et buffe."
  },
  {
    "key": "catcher",
    "label": "Attrapeur",
    "description": "Soutien qui attrape une cible isolée."
  },
  {
    "key": "specialist",
    "label": "Spécialiste",
    "description": "Champion au style unique."
  }
];

export const ARCHETYPE_TRAITS: Record<string, Partial<Record<TraitName, number>>> = {
  "vanguard": {
    "engage": 3,
    "peel": 1,
    "waveclear": 1,
    "pick": 1,
    "teamfight": 3,
    "early": 1,
    "late": 2,
    "mobility": 1,
    "frontline": 3,
    "cc": 3,
    "sustain": 1,
    "objective": 1
  },
  "warden": {
    "engage": 1,
    "peel": 3,
    "teamfight": 2,
    "early": 1,
    "late": 2,
    "mobility": 1,
    "frontline": 3,
    "cc": 2,
    "sustain": 1
  },
  "juggernaut": {
    "engage": 1,
    "waveclear": 2,
    "splitpush": 2,
    "teamfight": 2,
    "early": 2,
    "late": 2,
    "frontline": 2,
    "cc": 1,
    "sustain": 3,
    "objective": 2
  },
  "diver": {
    "engage": 2,
    "waveclear": 1,
    "splitpush": 1,
    "pick": 2,
    "teamfight": 1,
    "early": 2,
    "late": 1,
    "mobility": 2,
    "frontline": 2,
    "cc": 2,
    "sustain": 1,
    "objective": 2
  },
  "skirmisher": {
    "waveclear": 2,
    "splitpush": 3,
    "pick": 1,
    "teamfight": 1,
    "early": 1,
    "late": 3,
    "mobility": 2,
    "sustain": 2,
    "objective": 2
  },
  "assassin": {
    "waveclear": 1,
    "splitpush": 1,
    "pick": 3,
    "teamfight": 1,
    "early": 2,
    "late": 1,
    "mobility": 3,
    "objective": 1
  },
  "burst_mage": {
    "poke": 1,
    "waveclear": 2,
    "pick": 2,
    "teamfight": 2,
    "early": 2,
    "late": 2,
    "cc": 2
  },
  "battlemage": {
    "waveclear": 3,
    "teamfight": 3,
    "early": 1,
    "late": 2,
    "frontline": 1,
    "cc": 1,
    "sustain": 1
  },
  "artillery": {
    "poke": 3,
    "waveclear": 3,
    "pick": 1,
    "teamfight": 2,
    "early": 1,
    "late": 2,
    "cc": 1
  },
  "marksman": {
    "poke": 1,
    "waveclear": 2,
    "splitpush": 1,
    "teamfight": 2,
    "early": 1,
    "late": 3,
    "objective": 3
  },
  "enchanter": {
    "peel": 3,
    "poke": 1,
    "teamfight": 2,
    "early": 1,
    "late": 2,
    "cc": 1,
    "sustain": 2
  },
  "catcher": {
    "engage": 2,
    "peel": 2,
    "pick": 3,
    "teamfight": 1,
    "early": 2,
    "late": 1,
    "cc": 3
  },
  "specialist": {
    "poke": 1,
    "waveclear": 2,
    "splitpush": 2,
    "teamfight": 2,
    "early": 1,
    "late": 2,
    "cc": 1
  }
};

export const ARCHETYPE_ROLES: Record<string, Role[]> = {
  "vanguard": [
    "TOP",
    "SUPPORT",
    "JUNGLE"
  ],
  "warden": [
    "SUPPORT",
    "TOP"
  ],
  "juggernaut": [
    "TOP"
  ],
  "diver": [
    "JUNGLE",
    "TOP"
  ],
  "skirmisher": [
    "TOP",
    "JUNGLE"
  ],
  "assassin": [
    "MID",
    "JUNGLE"
  ],
  "burst_mage": [
    "MID",
    "SUPPORT"
  ],
  "battlemage": [
    "MID",
    "TOP"
  ],
  "artillery": [
    "MID",
    "SUPPORT"
  ],
  "marksman": [
    "BOTTOM"
  ],
  "enchanter": [
    "SUPPORT"
  ],
  "catcher": [
    "SUPPORT"
  ],
  "specialist": [
    "TOP",
    "MID"
  ]
};

export const DAMAGE_ARCHETYPES_LIST: string[] = [
  "artillery",
  "assassin",
  "battlemage",
  "burst_mage",
  "marksman",
  "skirmisher"
];

export const TRAIT_FR: Record<TraitName, string> = {
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
  "objective": "la prise d'objectifs"
};

export const COUNTER_FR: Record<string, string> = {
  "dive": "au dive adverse",
  "poke": "à la poke adverse",
  "engage": "à l'engage adverse",
  "split": "au split push adverse",
  "pick": "aux picks adverses",
  "frontline": "à la frontline adverse",
  "early": "à l'early adverse",
  "late": "au scaling adverse"
};

export const KNOCKUPS_LIST: string[] = [
  "Aatrox",
  "Alistar",
  "Azir",
  "Braum",
  "Camille",
  "Chogath",
  "Diana",
  "Gnar",
  "Gragas",
  "Janna",
  "JarvanIV",
  "KSante",
  "Kalista",
  "LeeSin",
  "Leona",
  "Lillia",
  "Malphite",
  "MonkeyKing",
  "Nami",
  "Nautilus",
  "Ornn",
  "Poppy",
  "Rakan",
  "Rell",
  "Sejuani",
  "Shyvana",
  "Sion",
  "Skarner",
  "Thresh",
  "Tristana",
  "Vi",
  "Volibear",
  "XinZhao",
  "Zac"
];

export const KNOCKUP_DUO: Record<string, string> = {
  "Yasuo": "son ultime (Dernier Souffle) s'enchaîne sur chaque cible projetée en l'air",
  "Yone": "son ultime et son Q3 enchaînent sur les cibles projetées en l'air"
};

export const FAMOUS_COMBOS: [string, string, string][] = [
  [
    "Orianna",
    "Malphite",
    "Orianna place sa balle sur Malphite : son ultime suit l'engage et regroupe tout le monde"
  ],
  [
    "Orianna",
    "JarvanIV",
    "Jarvan IV enferme l'équipe adverse dans son ultime, Orianna déclenche son onde de choc"
  ],
  [
    "Orianna",
    "Zac",
    "Zac atterrit au milieu des adversaires avec la balle d'Orianna"
  ],
  [
    "MissFortune",
    "Amumu",
    "l'ultime d'Amumu immobilise tout le monde pendant le Barrage de Miss Fortune"
  ],
  [
    "MissFortune",
    "Leona",
    "Leona immobilise, Miss Fortune canalise son ultime sans être interrompue"
  ],
  [
    "MissFortune",
    "Galio",
    "Galio provoque les adversaires sous le Barrage de Miss Fortune"
  ],
  [
    "Kalista",
    "Thresh",
    "Kalista lance Thresh avec son ultime pour un engage imprévisible"
  ],
  [
    "Kalista",
    "Skarner",
    "Kalista projette Skarner, qui ramène un carry adverse avec son ultime"
  ],
  [
    "Xayah",
    "Rakan",
    "Rakan et Xayah se rejoignent par leurs ultimes : engage puis immunité de Xayah"
  ],
  [
    "Lucian",
    "Braum",
    "chaque attaque rapide de Lucian déclenche la passive étourdissante de Braum"
  ],
  [
    "Lucian",
    "Nami",
    "la Marée de Nami enchaîne les tirs rapides de Lucian"
  ],
  [
    "Twitch",
    "Lulu",
    "Lulu rend Twitch inarrêtable avec son bouclier et son ultime"
  ],
  [
    "KogMaw",
    "Lulu",
    "Lulu protège Kog'Maw, la tourelle humaine de l'équipe"
  ],
  [
    "Jinx",
    "Lulu",
    "Lulu garde Jinx en vie le temps qu'elle s'emballe"
  ],
  [
    "MasterYi",
    "Taric",
    "Taric rend Master Yi invulnérable en plein milieu des combats"
  ],
  [
    "Kayle",
    "Taric",
    "Taric et Kayle superposent leurs invulnérabilités"
  ],
  [
    "TwistedFate",
    "Nocturne",
    "deux ultimes globaux : Twisted Fate et Nocturne tombent ensemble sur une cible"
  ],
  [
    "Galio",
    "Nocturne",
    "Nocturne plonge sous Paranoïa, Galio arrive par son ultime"
  ],
  [
    "Galio",
    "Camille",
    "Camille isole une cible dans son ultime, Galio la rejoint"
  ],
  [
    "Sion",
    "Orianna",
    "Sion fonce dans l'équipe adverse avec la balle d'Orianna"
  ],
  [
    "Yasuo",
    "Malphite",
    "l'ultime de Malphite projette toute l'équipe : Yasuo enchaîne son Dernier Souffle"
  ],
  [
    "Yasuo",
    "Diana",
    "Diana regroupe les adversaires, Yasuo enchaîne derrière une projection"
  ],
  [
    "Zilean",
    "Kayle",
    "Zilean empêche Kayle de mourir pendant qu'elle scale"
  ],
  [
    "Sona",
    "Taric",
    "Taric et Sona : soins, boucliers et contrôles en chaîne"
  ],
  [
    "Jhin",
    "Zyra",
    "les racines de Zyra préparent le W de Jhin"
  ],
  [
    "Ashe",
    "Sejuani",
    "la flèche d'Ashe et l'engage de Sejuani gèlent toute une équipe"
  ],
  [
    "Caitlyn",
    "Lux",
    "les pièges de Caitlyn sur cibles immobilisées par Lux"
  ],
  [
    "Nidalee",
    "Caitlyn",
    "double poke à longue portée sous les tours adverses"
  ],
  [
    "Rumble",
    "Amumu",
    "Amumu bloque les adversaires dans l'Égaliseur de Rumble"
  ],
  [
    "Kennen",
    "Galio",
    "Kennen plonge, Galio suit avec son ultime pour un double contrôle de zone"
  ],
  [
    "Pantheon",
    "TwistedFate",
    "Twisted Fate et Pantheon tombent ensemble sur une lane"
  ],
  [
    "Shen",
    "Ezreal",
    "Shen protège Ezreal où qu'il soit sur la carte"
  ],
  [
    "Zoe",
    "Yuumi",
    "Yuumi accompagne Zoe partout"
  ]
];

export const ARCH_SPIKES: Record<string, string> = {
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
  "specialist": "dépend de son kit : surveille ses niveaux clés"
};

export const ARCH_PLAY: Record<string, string> = {
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
  "specialist": "Spécialiste : joue autour des forces uniques de ton kit."
};

export const ARCH_JOB: Record<string, string> = {
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
  "catcher": "Ton job : trouver le pick qui ouvre le combat."
};

export const WIN: Record<string, string[]> = {
  "engage": [
    "Grouper à 5 autour des objectifs et laisser {engager} lancer le combat sur plusieurs cibles",
    "Enchaîner les sorts de zone de {tf} juste après l'engage",
    "Gagner les combats à 5 avant que l'adversaire ne puisse vous kiter"
  ],
  "pick": [
    "Prendre la vision dans la jungle adverse pour attraper un isolé avec {picker}",
    "Transformer chaque pick en objectif immédiat (drake, Héraut, tour)",
    "Éviter les 5v5 frontaux à nombre égal"
  ],
  "poke_siege": [
    "User l'adversaire avec {poker} avant chaque objectif",
    "Assiéger les tours : l'adversaire ne peut pas défendre en restant à moitié de vie",
    "N'engager que lorsque l'adversaire a perdu une bonne partie de ses PV"
  ],
  "protect_carry": [
    "Garder {carry} en vie : toute l'équipe joue autour de lui",
    "{peeler} reste collé à {carry} au lieu de chercher des kills",
    "Laisser l'adversaire engager puis contre-attaquer quand ses sorts sont utilisés"
  ],
  "split_push": [
    "{splitter} pousse une lane latérale et attire deux adversaires",
    "Les autres tiennent le milieu sans engager et prennent l'objectif du côté opposé",
    "Forcer l'adversaire à choisir entre sa tour et l'objectif"
  ],
  "dive": [
    "Plonger ensemble sur les carries adverses : {divers} doivent arriver en même temps",
    "Tuer le carry adverse dans les premières secondes du combat",
    "Utiliser la mobilité pour attaquer par les flancs plutôt que de face"
  ],
  "early_snowball": [
    "Gagner les lanes et multiplier les ganks avec {jungler}",
    "Prendre Larves du Néant, Héraut et drakes tant que vous êtes plus forts",
    "Finir la partie avant 25-30 minutes"
  ],
  "scaling": [
    "Survivre aux 15 premières minutes sans donner d'or",
    "Farmer pour que {carry} complète ses objets",
    "Gagner les gros combats de fin de partie autour du Nashor et de l'Âme du dragon"
  ],
  "skirmish": [
    "Gagner les escarmouches à 2 ou 3 autour de la jungle et des buffs",
    "Punir chaque adversaire isolé avec {skirmishers}",
    "Convertir chaque escarmouche gagnée en objectif neutre"
  ]
};

export const ENEMY_WIN: Record<string, string> = {
  "engage": "{engager} cherche un gros engage sur plusieurs d'entre vous, suivi des dégâts de zone de {tf}",
  "pick": "Ils veulent attraper un joueur isolé avec {picker} puis jouer à 5 contre 4",
  "poke_siege": "Ils veulent vous user avec {poker} avant chaque objectif et assiéger vos tours",
  "protect_carry": "Tout tourne autour de {carry}, protégé par {peeler}",
  "split_push": "{splitter} va split push pour forcer votre équipe à se diviser",
  "dive": "Ils vont plonger sur vos carries avec {divers}",
  "early_snowball": "Ils veulent prendre l'avance tôt (ganks, invades) et finir vite",
  "scaling": "Ils veulent atteindre la fin de partie, où {carry} devient dominant",
  "skirmish": "Ils cherchent des escarmouches à 2-3 dans la jungle avec {skirmishers}"
};

export const MID: Record<string, [string, string[]]> = {
  "engage": [
    "Regroupez-vous pour les objectifs et cherchez le combat à 5.",
    [
      "Arrivez sur le drake 30 secondes avant son apparition pour poser la vision",
      "{engager} engage quand au moins 3 adversaires sont regroupés"
    ]
  ],
  "pick": [
    "Jouez la vision et les embuscades dans la jungle.",
    [
      "Placez des balises profondes et attendez un adversaire qui ward seul",
      "{picker} se cache dans les buissons sur le chemin des adversaires"
    ]
  ],
  "poke_siege": [
    "Poussez les vagues et assiégez les tours avec la poke.",
    [
      "Prenez le Héraut et cassez les tours extérieures",
      "{poker} use la cible avant chaque engagement"
    ]
  ],
  "protect_carry": [
    "Laissez {carry} farmer en sécurité et jouez autour de lui.",
    [
      "Donnez les vagues de sbires sûres à {carry}",
      "{peeler} accompagne {carry} sur toute la carte"
    ]
  ],
  "split_push": [
    "Mettez en place le 1-3-1 : {splitter} sur une lane latérale.",
    [
      "{splitter} garde la vision de la jungle adjacente pour ne pas se faire collapse",
      "Le groupe central nettoie les vagues et ne combat pas sans {splitter}"
    ]
  ],
  "dive": [
    "Cherchez les combats où vous pouvez atteindre les carries.",
    [
      "Plongez quand les sorts défensifs adverses (Flash, Zhonya, peel) sont utilisés",
      "Attaquez par les flancs avec {divers}"
    ]
  ],
  "early_snowball": [
    "Transformez l'avance en tours et en objectifs.",
    [
      "Envahissez la jungle adverse avec la priorité de lane",
      "Prenez les tours avec le Héraut et rapprochez-vous de la base adverse"
    ]
  ],
  "scaling": [
    "Farmez et ne prenez pas de combats inutiles.",
    [
      "Échangez les objectifs plutôt que de combattre en infériorité",
      "Protégez {carry} pendant qu'il complète ses objets"
    ]
  ],
  "skirmish": [
    "Restez près de votre jungler et cherchez les 2v2/3v3.",
    [
      "Contestez les buffs et le Carapateur avec {skirmishers}",
      "Envahissez quand vos lanes ont la priorité"
    ]
  ]
};

export const LATE: Record<string, [string, string[]]> = {
  "engage": [
    "Un bon engage sur le Nashor ou l'Âme gagne la partie.",
    [
      "Ne vous dispersez pas : cherchez le combat à 5 près des objectifs"
    ]
  ],
  "pick": [
    "Un pick sur un carry adverse = Nashor gratuit.",
    [
      "Ne combattez pas à 5 sans avoir attrapé quelqu'un d'abord"
    ]
  ],
  "poke_siege": [
    "Assiégez avec la poke et n'engagez qu'une fois l'adversaire affaibli.",
    [
      "Ne vous faites pas attraper en avançant pour poker : restez groupés"
    ]
  ],
  "protect_carry": [
    "{carry} doit taper du début à la fin de chaque combat.",
    [
      "Placez-vous en formation : frontline devant, {peeler} à côté de {carry}"
    ]
  ],
  "split_push": [
    "{splitter} met la pression d'un côté pendant que l'équipe prend le Nashor ou un inhibiteur.",
    [
      "Ne combattez pas à 4 contre 5 sans raison : reculez si l'adversaire force"
    ]
  ],
  "dive": [
    "Plongez ensemble sur la backline au premier faux pas adverse.",
    [
      "Ciblez le carry adverse en priorité, ignorez la frontline"
    ]
  ],
  "early_snowball": [
    "Plus la partie dure, moins votre avance compte : forcez la fin.",
    [
      "Avec le Nashor, poussez directement les inhibiteurs"
    ]
  ],
  "scaling": [
    "Vous êtes la meilleure équipe de fin de partie : combattez autour du Nashor et de l'Âme.",
    [
      "Un seul mort de {carry} peut coûter la partie : positionnement prudent"
    ]
  ],
  "skirmish": [
    "Restez groupés à 3 minimum et punissez les isolés.",
    [
      "Évitez les combats à 5 en ligne droite face à une meilleure compo de teamfight"
    ]
  ]
};

export const AVOID: Record<string, string[]> = {
  "engage": [
    "Engager à 2 ou 3 pendant que le reste de l'équipe est loin"
  ],
  "pick": [
    "Se battre à 5 contre 5 de face sans avoir pris l'avantage numérique"
  ],
  "poke_siege": [
    "Engager à 5 contre 5 quand l'adversaire est encore full vie"
  ],
  "protect_carry": [
    "Laisser {carry} seul sur une lane latérale sans vision"
  ],
  "split_push": [
    "Que {splitter} split sans vision : un mort coûte un objectif à l'équipe"
  ],
  "dive": [
    "Plonger un par un : un plongeur seul meurt avant d'avoir servi"
  ],
  "early_snowball": [
    "Laisser traîner la partie : chaque minute rapproche l'adversaire de ses objets"
  ],
  "scaling": [
    "Forcer des combats avant que {carry} ait au moins 2 objets"
  ],
  "skirmish": [
    "Se battre en ligne droite à 5 contre une compo de teamfight"
  ]
};

export const LANE_RULES: Record<string, string> = {
  "fighter|tank": "Tu gagnes les duels sur la durée : punis chacun de ses last-hits et split push, un tank ne peut pas te tuer seul.",
  "tank|fighter": "Ton adversaire te bat en duel : farme prudemment, appelle ton jungler et brille en combat d'équipe.",
  "tank|tank": "Lane passive : farme, garde ta Téléportation pour les combats et le premier drake.",
  "fighter|fighter": "Duel serré : trade quand ses sorts clés sont en recharge et surveille les niveaux.",
  "fighter|mage": "Reste près des sbires pour éviter sa poke et engage quand il gaspille ses sorts.",
  "mage|fighter": "Garde tes distances et punis chacune de ses approches avec tes sorts.",
  "mage|assassin": "Ton adversaire veut te tuer en un combo : garde un sort de survie ou de contrôle pour sa plongée et wardez les flancs.",
  "assassin|mage": "Esquive ses sorts clés puis punis : ton adversaire est vulnérable dès que ses sorts sont en recharge.",
  "mage|mage": "Duel de portée et de mana : pousse ta vague et va aider ton jungler en premier.",
  "assassin|assassin": "Le premier qui rate son combo perd l'échange : joue autour de vos temps de recharge.",
  "marksman|marksman": "Duel de farm et de positionnement : jouez autour de vos niveaux 2 et de vos supports.",
  "enchanter|catcher": "Reste derrière tes sbires pour éviter ses grabs et soigne ou protège ton ADC après chacun de ses engages.",
  "catcher|enchanter": "Force les engages : l'enchanteur ne peut pas tout soigner si tu verrouilles l'ADC.",
  "enchanter|enchanter": "Lane de poke et de soins : gagnez les échanges courts et gérez bien votre mana.",
  "catcher|catcher": "Le premier qui touche son grab gagne la lane : restez derrière vos sbires.",
  "tank|enchanter": "Engage dès que l'enchanteur a utilisé son bouclier ou son soin.",
  "enchanter|tank": "Ne te place pas à portée d'engage et poke ton adversaire dès qu'il avance.",
  "tank|catcher": "Les deux supports cherchent l'engage : celui qui garde ses contrôles pour contre-engager gagne.",
  "catcher|tank": "Les deux supports cherchent l'engage : touche ton grab quand son engage est en recharge.",
  "assassin|fighter": "Ton adversaire encaisse mieux que toi : évite les longs échanges et roam vers les autres lanes.",
  "fighter|assassin": "Ton adversaire ne peut pas te tuer facilement : force les échanges longs et suis ses roams."
};
