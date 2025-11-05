"""
Module de récupération et gestion des données des items League of Legends.
Utilise l'API Data Dragon de Riot Games.
"""

import requests
import json
import os
from typing import Dict, List, Optional, Set
from diskcache import Cache

# Cache pour stocker les données localement
cache = Cache('data/cache')

class ItemDataManager:
    """Gestionnaire des données des items LoL."""

    def __init__(self):
        self.base_url = "https://ddragon.leagueoflegends.com"
        self.version = self._get_latest_version()
        self.items: Dict = {}
        self.item_list: List[str] = []

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
            return "15.22.1"  # Version par défaut

    def load_items(self, force_refresh: bool = False) -> Dict:
        """Charge tous les items avec leurs statistiques détaillées."""
        cache_key = f'items_data_{self.version}'

        if not force_refresh:
            cached = cache.get(cache_key)
            if cached:
                self.items = cached
                self.item_list = list(cached.keys())
                return cached

        try:
            # Récupérer la liste des items
            url = f"{self.base_url}/cdn/{self.version}/data/fr_FR/item.json"
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            data = response.json()

            items_data = {}

            # Filtrer et traiter les items (exclure les items non achetables)
            for item_id, item_info in data['data'].items():
                # Exclure certains items non pertinents
                if self._is_purchasable_item(item_info):
                    items_data[item_id] = {
                        'id': item_id,
                        'name': item_info['name'],
                        'description': item_info.get('description', ''),
                        'plaintext': item_info.get('plaintext', ''),
                        'gold': item_info.get('gold', {}),
                        'stats': item_info.get('stats', {}),
                        'tags': item_info.get('tags', []),
                        'maps': item_info.get('maps', {}),
                        'into': item_info.get('into', []),  # Items que cet item peut construire
                        'from': item_info.get('from', []),  # Items nécessaires pour construire cet item
                        'image': f"{self.base_url}/cdn/{self.version}/img/item/{item_id}.png"
                    }

            # Sauvegarder en cache
            cache.set(cache_key, items_data, expire=604800)  # 7 jours
            self.items = items_data
            self.item_list = list(items_data.keys())

            return items_data

        except Exception as e:
            print(f"Erreur lors du chargement des items: {e}")
            return {}

    def _is_purchasable_item(self, item_info: Dict) -> bool:
        """Détermine si un item est achetable dans le jeu."""
        # Exclure les items sans coût ou marqués comme non achetables
        gold = item_info.get('gold', {})
        if not gold or gold.get('purchasable', True) == False:
            return False

        # Exclure uniquement les items vraiment inutilisables
        item_name = item_info.get('name', '').lower()
        excluded_keywords = ['trinket', 'deprecated', 'enchantment', 'quick charge', 'scorchclaw pup']

        for keyword in excluded_keywords:
            if keyword in item_name:
                return False

        # Vérifier que l'item est disponible sur la Faille de l'invocateur (map 11)
        maps = item_info.get('maps', {})
        if '11' in maps and not maps['11']:
            return False

        # Exclure les items avec un coût total de 0 (sauf les boots et les starter items)
        total_cost = gold.get('total', 0)
        if total_cost == 0 and 'boots' not in item_name and 'starting' not in item_name:
            return False

        return True

    def get_item_by_id(self, item_id: str) -> Optional[Dict]:
        """Récupère les informations d'un item par son ID."""
        if not self.items:
            self.load_items()
        return self.items.get(item_id)

    def get_items_by_tag(self, tag: str) -> List[Dict]:
        """Récupère tous les items d'une catégorie spécifique."""
        if not self.items:
            self.load_items()

        return [
            item for item in self.items.values()
            if tag in item['tags']
        ]

    def get_item_stats(self, item_id: str) -> Optional[Dict]:
        """Récupère les statistiques d'un item."""
        item = self.get_item_by_id(item_id)
        return item['stats'] if item else None

    def search_items(self, query: str) -> List[Dict]:
        """Recherche des items par nom."""
        if not self.items:
            self.load_items()

        query_lower = query.lower()
        return [
            item for item in self.items.values()
            if query_lower in item['name'].lower() or query_lower in item['plaintext'].lower()
        ]

    def get_all_tags(self) -> List[str]:
        """Récupère toutes les catégories d'items disponibles."""
        if not self.items:
            self.load_items()

        tags = set()
        for item in self.items.values():
            tags.update(item['tags'])

        return sorted(list(tags))

    def get_items_by_price_range(self, min_price: int = 0, max_price: int = 10000) -> List[Dict]:
        """Récupère les items dans une fourchette de prix."""
        if not self.items:
            self.load_items()

        result = []
        for item in self.items.values():
            total_cost = item['gold'].get('total', 0)
            if min_price <= total_cost <= max_price:
                result.append(item)

        return sorted(result, key=lambda x: x['gold'].get('total', 0))

    def get_item_build_path(self, item_id: str) -> Dict:
        """Récupère le chemin de construction d'un item."""
        item = self.get_item_by_id(item_id)
        if not item:
            return {}

        result = {
            'item': item,
            'components': [],
            'builds_into': []
        }

        # Items composants
        for component_id in item.get('from', []):
            component = self.get_item_by_id(component_id)
            if component:
                result['components'].append(component)

        # Items qu'il peut construire
        for upgrade_id in item.get('into', []):
            upgrade = self.get_item_by_id(upgrade_id)
            if upgrade:
                result['builds_into'].append(upgrade)

        return result

    def get_recommended_items_for_stats(self, desired_stats: List[str]) -> List[Dict]:
        """Recommande des items basés sur les statistiques désirées."""
        if not self.items:
            self.load_items()

        scored_items = []

        for item in self.items.values():
            score = 0
            item_stats = item.get('stats', {})

            # Calculer un score basé sur les stats désirées
            for stat in desired_stats:
                if stat in item_stats and item_stats[stat] > 0:
                    score += item_stats[stat]

            if score > 0:
                scored_items.append({
                    'item': item,
                    'score': score,
                    'efficiency': score / max(item['gold'].get('total', 1), 1)  # Score par gold
                })

        # Trier par efficacité (score/coût)
        return sorted(scored_items, key=lambda x: x['efficiency'], reverse=True)


# Catégories d'items pour faciliter la navigation
ITEM_CATEGORIES = {
    'DAMAGE': ['Damage'],
    'DEFENSE': ['Armor', 'SpellBlock'],
    'HEALTH': ['Health'],
    'MANA': ['Mana'],
    'SPEED': ['Boots'],
    'CRIT': ['CriticalStrike'],
    'SUPPORT': ['GoldPer', 'Trinket'],
    'CONSUMABLE': ['Consumable'],
    'JUNGLE': ['Jungle']
}

def get_items_by_category(category: str, item_manager: ItemDataManager) -> List[Dict]:
    """Récupère les items d'une catégorie spécifique."""
    if category not in ITEM_CATEGORIES:
        return []

    category_tags = ITEM_CATEGORIES[category]
    items = []

    for tag in category_tags:
        items.extend(item_manager.get_items_by_tag(tag))

    # Éliminer les doublons
    seen = set()
    unique_items = []
    for item in items:
        if item['id'] not in seen:
            seen.add(item['id'])
            unique_items.append(item)

    return unique_items

def analyze_item_synergy(item_ids: List[str], item_manager: ItemDataManager) -> Dict:
    """Analyse la synergie entre plusieurs items."""
    if not item_ids:
        return {}

    total_stats = {}
    total_cost = 0
    unique_effects = set()

    for item_id in item_ids:
        item = item_manager.get_item_by_id(item_id)
        if not item:
            continue

        # Accumuler les statistiques
        for stat, value in item.get('stats', {}).items():
            total_stats[stat] = total_stats.get(stat, 0) + value

        # Coût total
        total_cost += item['gold'].get('total', 0)

        # Effets uniques (basés sur les tags)
        unique_effects.update(item.get('tags', []))

    return {
        'total_stats': total_stats,
        'total_cost': total_cost,
        'unique_effects': list(unique_effects),
        'stat_efficiency': {
            stat: value / max(total_cost, 1) for stat, value in total_stats.items()
        }
    }