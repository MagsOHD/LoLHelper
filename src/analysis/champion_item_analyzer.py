"""
Module d'analyse des relations champions-items.
Permet de trouver quels champions utilisent quels items et vice versa.
"""

from typing import Dict, List, Optional, Set, Tuple
import json
import os

class ChampionItemAnalyzer:
    """Analyseur des relations entre champions et items."""

    def __init__(self, champion_manager, item_manager):
        self.champion_manager = champion_manager
        self.item_manager = item_manager

        # Cache pour les builds recommandés (simulé)
        self.recommended_builds = self._generate_recommended_builds()

    def _generate_recommended_builds(self) -> Dict[str, List[str]]:
        """Génère des builds recommandés basés sur les rôles et stats des champions."""
        builds = {}

        if not self.champion_manager.champions or not self.item_manager.items:
            return builds

        # Mapping des rôles vers les types d'items recommandés
        role_item_preferences = {
            'Fighter': ['FlatPhysicalDamageMod', 'FlatHPPoolMod', 'FlatArmorMod'],
            'Tank': ['FlatHPPoolMod', 'FlatArmorMod', 'FlatSpellBlockMod'],
            'Mage': ['FlatMagicDamageMod', 'FlatMPPoolMod', 'FlatMPRegenMod'],
            'Assassin': ['FlatPhysicalDamageMod', 'FlatCritChanceMod', 'FlatMovementSpeedMod'],
            'Marksman': ['FlatPhysicalDamageMod', 'FlatCritChanceMod', 'FlatAttackSpeedMod'],
            'Support': ['FlatHPPoolMod', 'FlatMPRegenMod', 'FlatSpellBlockMod']
        }

        for champion_id, champion in self.champion_manager.champions.items():
            champion_builds = []
            champion_roles = champion.get('tags', [])

            # Pour chaque rôle du champion, trouver les meilleurs items
            for role in champion_roles:
                if role in role_item_preferences:
                    preferred_stats = role_item_preferences[role]

                    # Trouver les items qui donnent ces stats
                    role_items = self._find_best_items_for_stats(preferred_stats, limit=3)
                    champion_builds.extend([item['id'] for item in role_items])

            # Ajouter des items génériques selon les stats du champion
            champion_stats = champion.get('info', {})
            if champion_stats.get('attack', 0) > 7:
                # Champion orienté attaque
                attack_items = self._find_best_items_for_stats(['FlatPhysicalDamageMod'], limit=2)
                champion_builds.extend([item['id'] for item in attack_items])

            if champion_stats.get('magic', 0) > 7:
                # Champion orienté magie
                magic_items = self._find_best_items_for_stats(['FlatMagicDamageMod'], limit=2)
                champion_builds.extend([item['id'] for item in magic_items])

            # Éliminer les doublons et limiter à 6 items
            builds[champion_id] = list(dict.fromkeys(champion_builds))[:6]

        return builds

    def _find_best_items_for_stats(self, desired_stats: List[str], limit: int = 5) -> List[Dict]:
        """Trouve les meilleurs items pour des statistiques données."""
        scored_items = []

        for item in self.item_manager.items.values():
            score = 0
            item_stats = item.get('stats', {})

            for stat in desired_stats:
                if stat in item_stats:
                    score += item_stats[stat]

            if score > 0:
                # Calculer l'efficacité (score par coût)
                cost = item['gold'].get('total', 1)
                efficiency = score / max(cost, 1)

                scored_items.append({
                    **item,
                    'stat_score': score,
                    'efficiency': efficiency
                })

        # Trier par efficacité et retourner les meilleurs
        return sorted(scored_items, key=lambda x: x['efficiency'], reverse=True)[:limit]

    def get_champions_using_item(self, item_id: str) -> List[Dict]:
        """Trouve les champions qui utilisent généralement cet item."""
        item = self.item_manager.get_item_by_id(item_id)
        if not item:
            return []

        champions_using_item = []

        for champion_id, build in self.recommended_builds.items():
            if item_id in build:
                champion = self.champion_manager.get_champion_by_id(champion_id)
                if champion:
                    champions_using_item.append({
                        'champion': champion,
                        'synergy_score': self._calculate_item_champion_synergy(item, champion),
                        'build_position': build.index(item_id) + 1
                    })

        # Trier par score de synergie
        return sorted(champions_using_item, key=lambda x: x['synergy_score'], reverse=True)

    def get_recommended_items_for_champion(self, champion_id: str) -> List[Dict]:
        """Récupère les items recommandés pour un champion."""
        champion = self.champion_manager.get_champion_by_id(champion_id)
        if not champion:
            return []

        recommended_item_ids = self.recommended_builds.get(champion_id, [])
        recommended_items = []

        for item_id in recommended_item_ids:
            item = self.item_manager.get_item_by_id(item_id)
            if item:
                synergy_score = self._calculate_item_champion_synergy(item, champion)
                recommended_items.append({
                    'item': item,
                    'synergy_score': synergy_score,
                    'reason': self._get_synergy_reason(item, champion)
                })

        return recommended_items

    def _calculate_item_champion_synergy(self, item: Dict, champion: Dict) -> float:
        """Calcule un score de synergie entre un item et un champion."""
        score = 0.0

        champion_roles = champion.get('tags', [])
        champion_info = champion.get('info', {})
        item_stats = item.get('stats', {})
        item_tags = item.get('tags', [])

        # Bonus basé sur les rôles
        role_bonuses = {
            'Fighter': {
                'FlatPhysicalDamageMod': 2.0,
                'FlatHPPoolMod': 1.5,
                'FlatArmorMod': 1.2
            },
            'Tank': {
                'FlatHPPoolMod': 2.0,
                'FlatArmorMod': 2.0,
                'FlatSpellBlockMod': 2.0
            },
            'Mage': {
                'FlatMagicDamageMod': 2.0,
                'FlatMPPoolMod': 1.5,
                'FlatMPRegenMod': 1.3
            },
            'Assassin': {
                'FlatPhysicalDamageMod': 2.0,
                'FlatCritChanceMod': 1.8,
                'FlatMovementSpeedMod': 1.5
            },
            'Marksman': {
                'FlatPhysicalDamageMod': 2.0,
                'FlatCritChanceMod': 2.0,
                'FlatAttackSpeedMod': 1.8
            },
            'Support': {
                'FlatHPPoolMod': 1.5,
                'FlatMPRegenMod': 2.0,
                'FlatSpellBlockMod': 1.3
            }
        }

        # Calculer le score basé sur les rôles du champion
        for role in champion_roles:
            if role in role_bonuses:
                for stat, value in item_stats.items():
                    if stat in role_bonuses[role]:
                        score += value * role_bonuses[role][stat]

        # Bonus basé sur les caractéristiques du champion
        if champion_info.get('attack', 0) > 7:
            score += item_stats.get('FlatPhysicalDamageMod', 0) * 1.5
            score += item_stats.get('FlatCritChanceMod', 0) * 1.3

        if champion_info.get('magic', 0) > 7:
            score += item_stats.get('FlatMagicDamageMod', 0) * 1.5
            score += item_stats.get('FlatMPPoolMod', 0) * 1.2

        if champion_info.get('defense', 0) > 7:
            score += item_stats.get('FlatHPPoolMod', 0) * 1.3
            score += item_stats.get('FlatArmorMod', 0) * 1.3

        return score

    def _get_synergy_reason(self, item: Dict, champion: Dict) -> str:
        """Explique pourquoi cet item est recommandé pour ce champion."""
        reasons = []

        champion_roles = champion.get('tags', [])
        champion_info = champion.get('info', {})
        item_stats = item.get('stats', {})

        # Raisons basées sur les rôles
        if 'Fighter' in champion_roles:
            if item_stats.get('FlatPhysicalDamageMod', 0) > 0:
                reasons.append("Augmente les dégâts physiques (Fighter)")
            if item_stats.get('FlatHPPoolMod', 0) > 0:
                reasons.append("Améliore la survie (Fighter)")

        if 'Tank' in champion_roles:
            if item_stats.get('FlatHPPoolMod', 0) > 0:
                reasons.append("Essentiel pour tanker (Tank)")
            if item_stats.get('FlatArmorMod', 0) > 0 or item_stats.get('FlatSpellBlockMod', 0) > 0:
                reasons.append("Améliore les résistances (Tank)")

        if 'Mage' in champion_roles:
            if item_stats.get('FlatMagicDamageMod', 0) > 0:
                reasons.append("Augmente la puissance magique (Mage)")
            if item_stats.get('FlatMPPoolMod', 0) > 0:
                reasons.append("Améliore la réserve de mana (Mage)")

        if 'Marksman' in champion_roles:
            if item_stats.get('FlatCritChanceMod', 0) > 0:
                reasons.append("Essentiel pour les critiques (ADC)")
            if item_stats.get('FlatAttackSpeedMod', 0) > 0:
                reasons.append("Améliore le DPS (ADC)")

        # Raisons basées sur les caractéristiques
        if champion_info.get('attack', 0) > 8:
            if item_stats.get('FlatPhysicalDamageMod', 0) > 0:
                reasons.append("Exploite l'orientation attaque du champion")

        if champion_info.get('magic', 0) > 8:
            if item_stats.get('FlatMagicDamageMod', 0) > 0:
                reasons.append("Exploite l'orientation magique du champion")

        return " • ".join(reasons) if reasons else "Synergie générale avec le champion"

    def analyze_build_synergy(self, item_ids: List[str], champion_id: str) -> Dict:
        """Analyse la synergie d'un build complet avec un champion."""
        champion = self.champion_manager.get_champion_by_id(champion_id)
        if not champion:
            return {}

        total_synergy = 0.0
        item_details = []
        total_stats = {}
        total_cost = 0

        for item_id in item_ids:
            item = self.item_manager.get_item_by_id(item_id)
            if item:
                synergy = self._calculate_item_champion_synergy(item, champion)
                total_synergy += synergy

                item_details.append({
                    'item': item,
                    'synergy_score': synergy,
                    'reason': self._get_synergy_reason(item, champion)
                })

                # Accumuler les stats
                for stat, value in item.get('stats', {}).items():
                    total_stats[stat] = total_stats.get(stat, 0) + value

                total_cost += item['gold'].get('total', 0)

        # Calculer des métriques de build
        avg_synergy = total_synergy / len(item_ids) if item_ids else 0
        cost_efficiency = total_synergy / max(total_cost, 1)

        return {
            'champion': champion,
            'items': item_details,
            'total_synergy': total_synergy,
            'average_synergy': avg_synergy,
            'cost_efficiency': cost_efficiency,
            'total_stats': total_stats,
            'total_cost': total_cost,
            'build_rating': self._rate_build(avg_synergy, len(item_ids))
        }

    def _rate_build(self, avg_synergy: float, item_count: int) -> str:
        """Donne une note au build basée sur la synergie moyenne."""
        if avg_synergy > 50:
            return "S (Excellent)"
        elif avg_synergy > 30:
            return "A (Très Bien)"
        elif avg_synergy > 15:
            return "B (Bien)"
        elif avg_synergy > 5:
            return "C (Moyen)"
        else:
            return "D (Faible)"

    def find_alternative_items(self, item_id: str, champion_id: str, num_alternatives: int = 5) -> List[Dict]:
        """Trouve des items alternatifs similaires pour un champion."""
        original_item = self.item_manager.get_item_by_id(item_id)
        champion = self.champion_manager.get_champion_by_id(champion_id)

        if not original_item or not champion:
            return []

        original_stats = original_item.get('stats', {})
        alternatives = []

        for alt_item in self.item_manager.items.values():
            if alt_item['id'] == item_id:
                continue

            # Calculer la similarité des stats
            similarity = self._calculate_stat_similarity(original_stats, alt_item.get('stats', {}))

            if similarity > 0:
                synergy = self._calculate_item_champion_synergy(alt_item, champion)
                alternatives.append({
                    'item': alt_item,
                    'similarity_score': similarity,
                    'synergy_score': synergy,
                    'combined_score': similarity * 0.3 + synergy * 0.7
                })

        # Trier par score combiné
        return sorted(alternatives, key=lambda x: x['combined_score'], reverse=True)[:num_alternatives]

    def _calculate_stat_similarity(self, stats1: Dict, stats2: Dict) -> float:
        """Calcule la similarité entre deux ensembles de statistiques."""
        if not stats1 or not stats2:
            return 0.0

        common_stats = set(stats1.keys()) & set(stats2.keys())
        if not common_stats:
            return 0.0

        similarity = 0.0
        for stat in common_stats:
            # Calculer la similarité pour cette stat (plus les valeurs sont proches, plus c'est similaire)
            val1, val2 = stats1[stat], stats2[stat]
            if val1 > 0 and val2 > 0:
                ratio = min(val1, val2) / max(val1, val2)
                similarity += ratio

        return similarity / len(common_stats) * 100

    def calculate_team_synergy_matrix(self, champions: List[Dict]) -> List[List[float]]:
        """Calcule la matrice de synergie entre les champions d'une équipe."""
        if not champions:
            return []

        n = len(champions)
        matrix = [[0.0 for _ in range(n)] for _ in range(n)]

        for i in range(n):
            for j in range(n):
                if i == j:
                    matrix[i][j] = 100.0  # Auto-synergie parfaite
                else:
                    synergy = self._calculate_champion_synergy(champions[i], champions[j])
                    matrix[i][j] = synergy

        return matrix

    def _calculate_champion_synergy(self, champ1: Dict, champ2: Dict) -> float:
        """Calcule la synergie entre deux champions."""
        score = 50.0  # Score de base

        roles1 = set(champ1.get('tags', []))
        roles2 = set(champ2.get('tags', []))

        # Bonus pour complémentarité des rôles
        complementary_pairs = {
            ('Tank', 'Marksman'): 15,
            ('Support', 'Marksman'): 20,
            ('Tank', 'Mage'): 10,
            ('Support', 'Mage'): 12,
            ('Fighter', 'Mage'): 8,
            ('Assassin', 'Tank'): 12,
            ('Fighter', 'Support'): 8
        }

        for role1 in roles1:
            for role2 in roles2:
                pair = tuple(sorted([role1, role2]))
                if pair in complementary_pairs:
                    score += complementary_pairs[pair]

        # Pénalité pour trop de rôles similaires
        common_roles = roles1 & roles2
        if len(common_roles) > 1:
            score -= len(common_roles) * 5

        # Bonus basé sur les caractéristiques
        info1 = champ1.get('info', {})
        info2 = champ2.get('info', {})

        # Équilibre attaque/défense
        if info1.get('attack', 0) > 7 and info2.get('defense', 0) > 7:
            score += 10  # Tank + DPS
        if info1.get('magic', 0) > 7 and info2.get('attack', 0) > 7:
            score += 8   # AP + AD

        return min(max(score, 0), 100)

    def analyze_team_composition(self, champions: List[Dict]) -> Dict:
        """Analyse complète d'une composition d'équipe."""
        if not champions:
            return {}

        analysis = {}

        # Diversité des rôles
        all_roles = set()
        for champ in champions:
            all_roles.update(champ.get('tags', []))

        role_diversity = len(all_roles) / 6 * 100  # Max 6 rôles différents
        analysis['Diversité des Rôles'] = min(role_diversity, 100)

        # Équilibre des dégâts
        ad_champs = 0
        ap_champs = 0
        for champ in champions:
            info = champ.get('info', {})
            if info.get('attack', 0) > info.get('magic', 0):
                ad_champs += 1
            else:
                ap_champs += 1

        damage_balance = 100 - (abs(ad_champs - ap_champs) / len(champions) * 50)
        analysis['Équilibre des Dégâts'] = damage_balance

        # Présence de Tank (pourcentage basé sur le nombre de champions)
        tanks = sum(1 for champ in champions if 'Tank' in champ.get('tags', []))
        tank_presence = min((tanks / len(champions)) * 100, 100)
        analysis['Présence Tank'] = tank_presence

        # Présence de Support (pourcentage basé sur le nombre de champions)
        supports = sum(1 for champ in champions if 'Support' in champ.get('tags', []))
        support_presence = min((supports / len(champions)) * 100, 100)
        analysis['Présence Support'] = support_presence

        # Couverture des phases de jeu
        early_game = sum(1 for champ in champions if champ.get('info', {}).get('difficulty', 0) <= 5)
        late_game = sum(1 for champ in champions if champ.get('info', {}).get('difficulty', 0) > 5)

        phase_coverage = 100 - (abs(early_game - late_game) / len(champions) * 30)
        analysis['Couverture des Phases'] = phase_coverage

        # Synergie globale
        synergy_matrix = self.calculate_team_synergy_matrix(champions)
        if synergy_matrix:
            total_synergy = 0
            count = 0
            for i in range(len(synergy_matrix)):
                for j in range(len(synergy_matrix[i])):
                    if i != j:  # Exclure l'auto-synergie
                        total_synergy += synergy_matrix[i][j]
                        count += 1

            avg_synergy = total_synergy / count if count > 0 else 50
            analysis['Synergie Globale'] = avg_synergy

        return analysis