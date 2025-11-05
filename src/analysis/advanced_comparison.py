"""
Module d'analyse avancée pour la comparaison de champions avec items par niveau.
Combine l'analyse des champions, des items et du niveau pour des comparaisons précises.
"""

from typing import Dict, List, Optional, Tuple
import numpy as np
from src.data.champion_data import calculate_champion_stats_at_level
from src.data.item_data import analyze_item_synergy

class AdvancedChampionComparator:
    """Analyseur avancé pour comparer des champions avec équipements par niveau."""

    def __init__(self, champion_manager, item_manager, champion_item_analyzer):
        self.champion_manager = champion_manager
        self.item_manager = item_manager
        self.champion_item_analyzer = champion_item_analyzer

    def compare_champions_with_builds(self, comparisons: List[Dict], level: int = 6) -> Dict:
        """
        Compare plusieurs champions avec leurs builds à un niveau donné.

        Args:
            comparisons: Liste de dictionnaires avec 'champion_id' et 'item_ids'
            level: Niveau auquel effectuer la comparaison

        Returns:
            Dictionnaire avec l'analyse complète de comparaison
        """
        if not comparisons or len(comparisons) < 2:
            return {}

        results = {
            'level': level,
            'champions': [],
            'comparison_matrix': [],
            'rankings': {},
            'recommendations': []
        }

        # Calculer les stats finales pour chaque champion
        for comparison in comparisons:
            champion_id = comparison['champion_id']
            item_ids = comparison.get('item_ids', [])

            champion = self.champion_manager.get_champion_by_id(champion_id)
            if not champion:
                continue

            # Stats du champion au niveau donné
            champion_at_level = calculate_champion_stats_at_level(champion, level)
            champion_stats = champion_at_level.get('stats', {})

            # Stats des items
            item_stats = self._calculate_total_item_stats(item_ids)

            # Stats finales (champion + items)
            final_stats = self._combine_champion_and_item_stats(champion_stats, item_stats)

            # Coût total des items
            total_cost = sum(
                self.item_manager.get_item_by_id(item_id)['gold'].get('total', 0)
                for item_id in item_ids
                if self.item_manager.get_item_by_id(item_id)
            )

            # Synergie items-champion
            build_synergy = self.champion_item_analyzer.analyze_build_synergy(item_ids, champion_id)

            champion_result = {
                'champion': champion,
                'champion_at_level': champion_at_level,
                'items': [self.item_manager.get_item_by_id(item_id) for item_id in item_ids if self.item_manager.get_item_by_id(item_id)],
                'champion_stats': champion_stats,
                'item_stats': item_stats,
                'final_stats': final_stats,
                'total_cost': total_cost,
                'build_synergy': build_synergy,
                'effectiveness_scores': self._calculate_effectiveness_scores(final_stats, total_cost)
            }

            results['champions'].append(champion_result)

        # Créer la matrice de comparaison
        results['comparison_matrix'] = self._create_comparison_matrix(results['champions'])

        # Créer les classements
        results['rankings'] = self._create_rankings(results['champions'])

        # Générer des recommandations
        results['recommendations'] = self._generate_recommendations(results['champions'])

        return results

    def _calculate_total_item_stats(self, item_ids: List[str]) -> Dict:
        """Calcule les statistiques totales des items."""
        total_stats = {}

        for item_id in item_ids:
            item = self.item_manager.get_item_by_id(item_id)
            if not item:
                continue

            item_stats = item.get('stats', {})
            for stat, value in item_stats.items():
                total_stats[stat] = total_stats.get(stat, 0) + value

        return total_stats

    def _combine_champion_and_item_stats(self, champion_stats: Dict, item_stats: Dict) -> Dict:
        """Combine les stats du champion et des items."""
        final_stats = champion_stats.copy()

        # Mapping des stats d'items vers les stats de champion
        stat_mapping = {
            'FlatHPPoolMod': 'hp',
            'FlatMPPoolMod': 'mp',
            'FlatArmorMod': 'armor',
            'FlatSpellBlockMod': 'spellblock',
            'FlatPhysicalDamageMod': 'attackdamage',
            'FlatMagicDamageMod': 'magicpower',  # Nouveau stat pour la puissance magique
            'FlatCritChanceMod': 'critchance',
            'FlatAttackSpeedMod': 'attackspeed_bonus',  # Bonus d'AS en flat
            'FlatMovementSpeedMod': 'movespeed',
            'PercentLifeStealMod': 'lifesteal',
            'FlatHPRegenMod': 'hpregen',
            'FlatMPRegenMod': 'mpregen'
        }

        for item_stat, value in item_stats.items():
            if item_stat in stat_mapping:
                champion_stat = stat_mapping[item_stat]
                if champion_stat == 'attackspeed_bonus':
                    # L'AS des items s'ajoute en % à l'AS de base
                    base_as = final_stats.get('attackspeed', 0.625)
                    final_stats['attackspeed'] = base_as + (value / 100)
                else:
                    final_stats[champion_stat] = final_stats.get(champion_stat, 0) + value

        return final_stats

    def _calculate_effectiveness_scores(self, final_stats: Dict, total_cost: int) -> Dict:
        """Calcule différents scores d'efficacité."""
        scores = {}

        # Score de survie (HP + Armor + MR)
        survival_score = (
            final_stats.get('hp', 0) * 1.0 +
            final_stats.get('armor', 0) * 20 +
            final_stats.get('spellblock', 0) * 20
        )
        scores['survival'] = survival_score

        # Score de dégâts (AD + AP + AS + Crit)
        damage_score = (
            final_stats.get('attackdamage', 0) * 15 +
            final_stats.get('magicpower', 0) * 12 +
            final_stats.get('attackspeed', 0) * 500 +
            final_stats.get('critchance', 0) * 25
        )
        scores['damage'] = damage_score

        # Score d'utilité (MP + MP regen + Movement Speed)
        utility_score = (
            final_stats.get('mp', 0) * 0.8 +
            final_stats.get('mpregen', 0) * 100 +
            final_stats.get('movespeed', 0) * 3
        )
        scores['utility'] = utility_score

        # Score total
        total_score = survival_score + damage_score + utility_score
        scores['total'] = total_score

        # Efficacité coût (score par gold dépensé)
        if total_cost > 0:
            scores['cost_efficiency'] = total_score / total_cost
        else:
            scores['cost_efficiency'] = total_score

        return scores

    def _create_comparison_matrix(self, champions: List[Dict]) -> List[List[Dict]]:
        """Crée une matrice de comparaison entre tous les champions."""
        n = len(champions)
        matrix = [[{} for _ in range(n)] for _ in range(n)]

        for i in range(n):
            for j in range(n):
                if i == j:
                    matrix[i][j] = {
                        'type': 'self',
                        'advantage': 'equal',
                        'score_diff': 0
                    }
                else:
                    champ1 = champions[i]
                    champ2 = champions[j]

                    # Comparer les scores totaux
                    score1 = champ1['effectiveness_scores']['total']
                    score2 = champ2['effectiveness_scores']['total']
                    score_diff = score1 - score2

                    # Déterminer l'avantage
                    if abs(score_diff) < 500:  # Seuil d'égalité
                        advantage = 'equal'
                    elif score_diff > 0:
                        advantage = 'advantaged'
                    else:
                        advantage = 'disadvantaged'

                    # Analyser les domaines d'avantage
                    domains = {}
                    for domain in ['survival', 'damage', 'utility']:
                        s1 = champ1['effectiveness_scores'][domain]
                        s2 = champ2['effectiveness_scores'][domain]
                        domains[domain] = 'win' if s1 > s2 else 'lose' if s1 < s2 else 'equal'

                    matrix[i][j] = {
                        'type': 'comparison',
                        'advantage': advantage,
                        'score_diff': score_diff,
                        'domains': domains,
                        'cost_diff': champ1['total_cost'] - champ2['total_cost']
                    }

        return matrix

    def _create_rankings(self, champions: List[Dict]) -> Dict:
        """Crée des classements par catégorie."""
        rankings = {}

        # Classement par score total
        rankings['total'] = sorted(
            champions,
            key=lambda x: x['effectiveness_scores']['total'],
            reverse=True
        )

        # Classement par survie
        rankings['survival'] = sorted(
            champions,
            key=lambda x: x['effectiveness_scores']['survival'],
            reverse=True
        )

        # Classement par dégâts
        rankings['damage'] = sorted(
            champions,
            key=lambda x: x['effectiveness_scores']['damage'],
            reverse=True
        )

        # Classement par utilité
        rankings['utility'] = sorted(
            champions,
            key=lambda x: x['effectiveness_scores']['utility'],
            reverse=True
        )

        # Classement par efficacité coût
        rankings['cost_efficiency'] = sorted(
            champions,
            key=lambda x: x['effectiveness_scores']['cost_efficiency'],
            reverse=True
        )

        # Classement par synergie du build
        rankings['synergy'] = sorted(
            champions,
            key=lambda x: x['build_synergy'].get('total_synergy', 0) if x['build_synergy'] else 0,
            reverse=True
        )

        return rankings

    def _generate_recommendations(self, champions: List[Dict]) -> List[Dict]:
        """Génère des recommandations d'amélioration."""
        recommendations = []

        for champion_data in champions:
            champion_name = champion_data['champion']['name']
            final_stats = champion_data['final_stats']
            effectiveness = champion_data['effectiveness_scores']

            champ_recommendations = {
                'champion': champion_name,
                'improvements': [],
                'strengths': [],
                'weaknesses': []
            }

            # Identifier les forces
            if effectiveness['survival'] > 3000:
                champ_recommendations['strengths'].append("Excellente survie")
            if effectiveness['damage'] > 2500:
                champ_recommendations['strengths'].append("Très bons dégâts")
            if effectiveness['utility'] > 1500:
                champ_recommendations['strengths'].append("Bonne utilité")

            # Identifier les faiblesses et recommandations
            if effectiveness['survival'] < 1500:
                champ_recommendations['weaknesses'].append("Survie fragile")
                champ_recommendations['improvements'].append("Ajouter des items défensifs (Armure/RM/HP)")

            if effectiveness['damage'] < 1200:
                champ_recommendations['weaknesses'].append("Dégâts insuffisants")
                if final_stats.get('attackdamage', 0) > final_stats.get('magicpower', 0):
                    champ_recommendations['improvements'].append("Ajouter des items d'attaque physique")
                else:
                    champ_recommendations['improvements'].append("Ajouter des items de puissance magique")

            if final_stats.get('movespeed', 0) < 350:
                champ_recommendations['improvements'].append("Améliorer la mobilité avec des bottes")

            # Vérifier l'équilibre du build
            ad_focus = final_stats.get('attackdamage', 0) + final_stats.get('critchance', 0) * 10
            ap_focus = final_stats.get('magicpower', 0)

            if ad_focus > 0 and ap_focus > 100:
                champ_recommendations['improvements'].append("Build hybride détecté - spécialisez-vous en AD ou AP")

            recommendations.append(champ_recommendations)

        return recommendations

    def get_optimal_items_for_champion_at_level(self, champion_id: str, level: int, budget: int = 10000) -> List[Dict]:
        """Trouve les items optimaux pour un champion à un niveau donné avec un budget."""
        champion = self.champion_manager.get_champion_by_id(champion_id)
        if not champion:
            return []

        champion_at_level = calculate_champion_stats_at_level(champion, level)
        champion_tags = champion.get('tags', [])
        champion_info = champion.get('info', {})

        # Déterminer l'orientation du champion
        is_ad_focused = champion_info.get('attack', 0) > champion_info.get('magic', 0)
        is_tank = 'Tank' in champion_tags
        is_support = 'Support' in champion_tags

        # Filtrer les items par budget
        affordable_items = []
        for item in self.item_manager.items.values():
            cost = item['gold'].get('total', 0)
            if cost <= budget and cost > 0:
                affordable_items.append(item)

        # Calculer un score pour chaque item
        scored_items = []
        for item in affordable_items:
            score = self._calculate_item_score_for_champion(
                item, champion, champion_at_level, is_ad_focused, is_tank, is_support
            )
            if score > 0:
                scored_items.append({
                    'item': item,
                    'score': score,
                    'efficiency': score / max(item['gold'].get('total', 1), 1)
                })

        # Trier par efficacité
        return sorted(scored_items, key=lambda x: x['efficiency'], reverse=True)[:20]

    def _calculate_item_score_for_champion(self, item: Dict, champion: Dict, champion_at_level: Dict,
                                         is_ad_focused: bool, is_tank: bool, is_support: bool) -> float:
        """Calcule un score d'affinité entre un item et un champion."""
        score = 0.0
        item_stats = item.get('stats', {})

        # Bonus selon l'orientation du champion
        if is_ad_focused:
            score += item_stats.get('FlatPhysicalDamageMod', 0) * 2.0
            score += item_stats.get('FlatCritChanceMod', 0) * 1.5
            score += item_stats.get('FlatAttackSpeedMod', 0) * 1.2
        else:
            score += item_stats.get('FlatMagicDamageMod', 0) * 2.0
            score += item_stats.get('FlatMPPoolMod', 0) * 0.8

        if is_tank:
            score += item_stats.get('FlatHPPoolMod', 0) * 1.8
            score += item_stats.get('FlatArmorMod', 0) * 2.5
            score += item_stats.get('FlatSpellBlockMod', 0) * 2.5

        if is_support:
            score += item_stats.get('FlatMPRegenMod', 0) * 3.0
            score += item_stats.get('FlatHPRegenMod', 0) * 2.0

        # Bonus général pour la survie
        score += item_stats.get('FlatHPPoolMod', 0) * 0.5
        score += item_stats.get('FlatMovementSpeedMod', 0) * 1.0

        return score