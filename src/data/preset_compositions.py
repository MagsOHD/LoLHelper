"""
Compositions d'équipe prédéfinies pour League of Legends.
"""

# Compositions prédéfinies classiques
PRESET_COMPOSITIONS = {
    "Poke Composition": {
        "description": "Composition basée sur le poke à distance avant les teamfights",
        "blue_team": ["Jayce", "Nidalee", "Xerath", "Ezreal", "Karma"],
        "strategy": "Poke à distance, disengage, sieges"
    },
    "Engage Composition": {
        "description": "Composition d'engage avec beaucoup de CC",
        "blue_team": ["Malphite", "Jarvan IV", "Orianna", "Ashe", "Leona"],
        "strategy": "Engage massif, teamfights 5v5"
    },
    "Protect the Carry": {
        "description": "Composition pour protéger l'ADC hypercarry",
        "blue_team": ["Ornn", "Ivern", "Lulu", "Jinx", "Janna"],
        "strategy": "Protéger l'ADC, scale vers late game"
    },
    "Split Push": {
        "description": "Composition avec split push et map pressure",
        "blue_team": ["Fiora", "Lee Sin", "Twisted Fate", "Ezreal", "Thresh"],
        "strategy": "Split push, map pressure, picks"
    },
    "Pick Composition": {
        "description": "Composition pour attraper des cibles isolées",
        "blue_team": ["Rengar", "Elise", "LeBlanc", "Jhin", "Pyke"],
        "strategy": "Picks isolés, vision control"
    },
    "Teamfight Composition": {
        "description": "Composition optimale pour les teamfights 5v5",
        "blue_team": ["Kennen", "Amumu", "Viktor", "Miss Fortune", "Rell"],
        "strategy": "Teamfights massifs avec AOE"
    },
    "Dive Composition": {
        "description": "Composition pour dive les backlines",
        "blue_team": ["Camille", "Nocturne", "Sylas", "Kai'Sa", "Nautilus"],
        "strategy": "Dive la backline ennemie"
    },
    "Kite Composition": {
        "description": "Composition pour kite et contrôler",
        "blue_team": ["Gnar", "Graves", "Azir", "Caitlyn", "Thresh"],
        "strategy": "Kite, peel, contrôle de zone"
    },
    "Early Game": {
        "description": "Composition forte en early game",
        "blue_team": ["Renekton", "Lee Sin", "Pantheon", "Draven", "Leona"],
        "strategy": "Dominer l'early game, snowball"
    },
    "Late Game Scaling": {
        "description": "Composition qui scale en late game",
        "blue_team": ["Kayle", "Master Yi", "Kassadin", "Vayne", "Sona"],
        "strategy": "Survivre l'early, dominer le late"
    },
    "Meta S15": {
        "description": "Composition meta saison 15",
        "blue_team": ["Aatrox", "Viego", "Ahri", "Jinx", "Thresh"],
        "strategy": "Composition équilibrée meta actuel"
    },
    "Full AD": {
        "description": "Composition full dégâts physiques",
        "blue_team": ["Darius", "Graves", "Zed", "Draven", "Pyke"],
        "strategy": "Overwhelm avec AD, attention aux tanks"
    },
    "Full AP": {
        "description": "Composition full dégâts magiques",
        "blue_team": ["Mordekaiser", "Elise", "Syndra", "Ziggs", "Brand"],
        "strategy": "Burst magique, attention à la MR"
    },
    "Tank Composition": {
        "description": "Composition avec beaucoup de frontline",
        "blue_team": ["Ornn", "Sejuani", "Galio", "Ashe", "Braum"],
        "strategy": "Frontline solide, CC chain"
    },
    "Assassin Composition": {
        "description": "Composition d'assassins mobile",
        "blue_team": ["Akali", "Kha'Zix", "Zed", "Samira", "Pyke"],
        "strategy": "Burst, mobilité, eliminer les carries"
    }
}

def get_preset_names():
    """Retourne la liste des noms de compositions prédéfinies."""
    return list(PRESET_COMPOSITIONS.keys())

def get_preset_composition(name):
    """Retourne une composition prédéfinie par son nom."""
    return PRESET_COMPOSITIONS.get(name)

def get_all_presets():
    """Retourne toutes les compositions prédéfinies."""
    return PRESET_COMPOSITIONS
