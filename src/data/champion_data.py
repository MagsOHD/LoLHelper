"""
Module de récupération et gestion des données des champions League of Legends.
Utilise l'API Data Dragon de Riot Games.
"""

import requests
import json
import os
from typing import Dict, List, Optional
from diskcache import Cache

# Cache pour stocker les données localement
cache = Cache('data/cache')

class ChampionDataManager:
    """Gestionnaire des données des champions LoL."""

    def __init__(self):
        self.base_url = "https://ddragon.leagueoflegends.com"
        self.version = self._get_latest_version()
        self.champions: Dict = {}
        self.champion_list: List[str] = []

    def _get_latest_version(self) -> str:
        """Récupère la dernière version du jeu."""
        cached = cache.get('game_version')
        if cached:
            return cached

        try:
            response = requests.get(f"{self.base_url}/api/versions.json", timeout=10)
            response.raise_for_status()
            version = response.json()[0]
            cache.set('game_version', version, expire=86400)  # 24h cache
            return version
        except Exception as e:
            print(f"Erreur lors de la récupération de la version: {e}")
            return "14.1.1"  # Version par défaut

    def load_champions(self, force_refresh: bool = False) -> Dict:
        """Charge tous les champions avec leurs statistiques détaillées."""
        cache_key = f'champions_data_{self.version}'

        if not force_refresh:
            cached = cache.get(cache_key)
            if cached:
                self.champions = cached
                self.champion_list = list(cached.keys())
                return cached

        try:
            # Récupérer la liste des champions
            url = f"{self.base_url}/cdn/{self.version}/data/fr_FR/champion.json"
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            data = response.json()

            champions_data = {}

            # Charger les détails de chaque champion
            for champ_name, champ_info in data['data'].items():
                champ_id = champ_info['id']
                detailed_url = f"{self.base_url}/cdn/{self.version}/data/fr_FR/champion/{champ_id}.json"

                try:
                    detail_response = requests.get(detailed_url, timeout=10)
                    detail_response.raise_for_status()
                    detail_data = detail_response.json()

                    champion_detail = detail_data['data'][champ_id]

                    # Extraire les informations pertinentes
                    champions_data[champ_id] = {
                        'id': champ_id,
                        'name': champion_detail['name'],
                        'title': champion_detail['title'],
                        'tags': champion_detail['tags'],  # Roles: Fighter, Mage, etc.
                        'stats': champion_detail['stats'],
                        'info': champion_detail['info'],  # Difficulty, attack, defense, magic
                        'spells': [spell['name'] for spell in champion_detail['spells']],
                        'passive': champion_detail['passive']['name'],
                        'image': f"{self.base_url}/cdn/{self.version}/img/champion/{champ_id}.png"
                    }

                except Exception as e:
                    print(f"Erreur pour le champion {champ_id}: {e}")
                    continue

            # Sauvegarder en cache
            cache.set(cache_key, champions_data, expire=604800)  # 7 jours
            self.champions = champions_data
            self.champion_list = list(champions_data.keys())

            return champions_data

        except Exception as e:
            print(f"Erreur lors du chargement des champions: {e}")
            return {}

    def get_champion_by_id(self, champion_id: str) -> Optional[Dict]:
        """Récupère les informations d'un champion par son ID."""
        if not self.champions:
            self.load_champions()
        return self.champions.get(champion_id)

    def get_champions_by_role(self, role: str) -> List[Dict]:
        """Récupère tous les champions d'un rôle spécifique."""
        if not self.champions:
            self.load_champions()

        return [
            champ for champ in self.champions.values()
            if role in champ['tags']
        ]

    def get_champion_stats(self, champion_id: str) -> Optional[Dict]:
        """Récupère les statistiques d'un champion."""
        champion = self.get_champion_by_id(champion_id)
        return champion['stats'] if champion else None

    def search_champions(self, query: str) -> List[Dict]:
        """Recherche des champions par nom."""
        if not self.champions:
            self.load_champions()

        query_lower = query.lower()
        return [
            champ for champ in self.champions.values()
            if query_lower in champ['name'].lower() or query_lower in champ['id'].lower()
        ]

    def get_all_roles(self) -> List[str]:
        """Récupère tous les rôles disponibles."""
        if not self.champions:
            self.load_champions()

        roles = set()
        for champ in self.champions.values():
            roles.update(champ['tags'])

        return sorted(list(roles))


# Mapping des lanes standard de LoL
LANE_MAPPING = {
    'TOP': ['Fighter', 'Tank'],
    'JUNGLE': ['Fighter', 'Tank', 'Assassin'],
    'MID': ['Mage', 'Assassin'],
    'ADC': ['Marksman'],
    'SUPPORT': ['Support', 'Tank', 'Mage']
}


def get_champions_for_lane(lane: str, champion_manager: ChampionDataManager) -> List[Dict]:
    """Récupère les champions adaptés à une lane spécifique."""
    if lane not in LANE_MAPPING:
        return []

    preferred_roles = LANE_MAPPING[lane]
    champions = []

    for role in preferred_roles:
        champions.extend(champion_manager.get_champions_by_role(role))

    # Éliminer les doublons
    seen = set()
    unique_champions = []
    for champ in champions:
        if champ['id'] not in seen:
            seen.add(champ['id'])
            unique_champions.append(champ)

    return unique_champions
