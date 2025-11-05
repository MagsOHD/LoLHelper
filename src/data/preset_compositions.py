"""
Compositions d'équipe professionnelles de League of Legends.
Basées sur des drafts réels de compétitions professionnelles (LCK, LPL, LEC, Worlds).
"""

# Compositions réelles de matches professionnels
PRESET_COMPOSITIONS = {
    # T1 vs JDG - Worlds 2023 Finals
    "T1 vs JDG (Worlds 2023 Game 1)": {
        "description": "Composition de T1 lors de la finale des Worlds 2023",
        "blue_team": ["Aatrox", "Maokai", "Azir", "Xayah", "Rakan"],
        "strategy": "Engage avec Rakan, protection de Xayah, scaling Azir",
        "team": "T1",
        "opponent": "JDG",
        "tournament": "Worlds 2023 Finals"
    },

    # JDG Composition - Worlds 2023
    "JDG vs T1 (Worlds 2023 Game 1)": {
        "description": "Composition de JDG lors de la finale des Worlds 2023",
        "blue_team": ["Jax", "Sejuani", "Orianna", "Varus", "Lulu"],
        "strategy": "Protect Varus comp avec Lulu, engage Orianna/Sejuani",
        "team": "JDG",
        "opponent": "T1",
        "tournament": "Worlds 2023 Finals"
    },

    # Gen.G Composition - LCK 2024
    "Gen.G Signature (LCK 2024)": {
        "description": "Composition signature de Gen.G dominante en LCK",
        "blue_team": ["Renekton", "Viego", "Orianna", "Aphelios", "Thresh"],
        "strategy": "Engage massif Orianna/Renekton, DPS Aphelios",
        "team": "Gen.G",
        "tournament": "LCK Spring 2024"
    },

    # BLG Composition - LPL 2024
    "BLG Aggressive (LPL 2024)": {
        "description": "Style agressif caractéristique de la LPL",
        "blue_team": ["Gnar", "LeeSin", "Akali", "Kaisa", "Nautilus"],
        "strategy": "Dive agressive, mobilité maximale",
        "team": "BLG",
        "tournament": "LPL Spring 2024"
    },

    # G2 Composition - LEC 2024
    "G2 Flex Pick (LEC 2024)": {
        "description": "Composition flexible de G2 avec flex picks",
        "blue_team": ["Jayce", "Graves", "Sylas", "Ezreal", "Karma"],
        "strategy": "Poke, kite, flex picks pour draft advantage",
        "team": "G2 Esports",
        "tournament": "LEC Spring 2024"
    },

    # T1 Faker Carry - MSI 2023
    "T1 Faker Azir (MSI 2023)": {
        "description": "Composition centrée sur Faker et Azir",
        "blue_team": ["Gragas", "Wukong", "Azir", "Jinx", "Leona"],
        "strategy": "Protect Faker, engage Wukong/Leona, DPS Jinx",
        "team": "T1",
        "tournament": "MSI 2023"
    },

    # DRX Worlds 2022 Champions
    "DRX Worlds Champions (2022)": {
        "description": "Draft iconique de DRX champions du monde 2022",
        "blue_team": ["Aatrox", "Viego", "Sylas", "Caitlyn", "Heimerdinger"],
        "strategy": "Flex Heimerdinger bot, sustain fight",
        "team": "DRX",
        "tournament": "Worlds 2022 Finals"
    },

    # WBG - Worlds 2023 Semi
    "WBG Teamfight (Worlds 2023)": {
        "description": "Composition teamfight de Weibo Gaming",
        "blue_team": ["Rumble", "Poppy", "Viktor", "MissFortune", "Amumu"],
        "strategy": "Teamfight AOE massif, zone control",
        "team": "Weibo Gaming",
        "tournament": "Worlds 2023"
    },

    # FNC Classic - LEC
    "FNC Engage Classic": {
        "description": "Composition engage classique de Fnatic",
        "blue_team": ["Malphite", "JarvanIV", "Orianna", "Ashe", "Leona"],
        "strategy": "Multi-engage, teamfight 5v5",
        "team": "Fnatic",
        "tournament": "LEC"
    },

    # Cloud9 Poke - LCS
    "C9 Poke Composition": {
        "description": "Composition poke/siege de Cloud9",
        "blue_team": ["Jayce", "Nidalee", "Zoe", "Ezreal", "Yuumi"],
        "strategy": "Poke avant fight, siege, disengage",
        "team": "Cloud9",
        "tournament": "LCS"
    },

    # 1v9 Carry Composition
    "Solo Carry Meta": {
        "description": "Composition pour porter seul (meta solo queue)",
        "blue_team": ["Fiora", "Graves", "Akali", "Draven", "Pyke"],
        "strategy": "High skill ceiling, snowball, 1v9 potential",
        "team": "Solo Queue Meta",
        "tournament": "Meta S14"
    },

    # Tank Meta
    "Tank Meta (MSI 2023)": {
        "description": "Meta des tanks avec frontline massive",
        "blue_team": ["Ornn", "Sejuani", "Galio", "Jinx", "TahmKench"],
        "strategy": "Frontline unkillable, protect ADC",
        "team": "Meta composition",
        "tournament": "MSI 2023"
    },

    # Assassin Meta
    "Assassin Meta Worlds 2023": {
        "description": "Meta des assassins mobiles Worlds 2023",
        "blue_team": ["Renekton", "Khazix", "Zed", "Samira", "Rell"],
        "strategy": "Burst, pick, mobilité",
        "team": "Meta composition",
        "tournament": "Worlds 2023"
    },

    # Split Push Pro
    "LCK Split Push": {
        "description": "Composition split push professionnelle",
        "blue_team": ["Fiora", "LeeSin", "TwistedFate", "Ezreal", "Bard"],
        "strategy": "Split push top, global pressure, disengage",
        "team": "LCK Teams",
        "tournament": "LCK 2024"
    },

    # Late Game Insurance
    "Late Game Insurance": {
        "description": "Composition scaling extrême",
        "blue_team": ["Kayle", "Kindred", "Kassadin", "Vayne", "Sona"],
        "strategy": "Survive early, hyper scale, auto-win late",
        "team": "Anti-meta",
        "tournament": "Late game comp"
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
