"""
Système de recommandation de picks pour League of Legends.
Suggère des champions basés sur la composition, l'équipe adverse, et les statistiques.
"""

from typing import Dict, List, Tuple, Optional
import numpy as np
from collections import defaultdict

class PickRecommender:
    """Système de recommandation de picks."""

    def __init__(self, champion_manager, pro_draft_analyzer, composition_analyzer):
        """
        Args:
            champion_manager: ChampionDataManager instance
            pro_draft_analyzer: ProDraftAnalyzer instance
            composition_analyzer: CompositionAnalyzer instance
        """
        self.champion_manager = champion_manager
        self.pro_draft_analyzer = pro_draft_analyzer
        self.composition_analyzer = composition_analyzer

    def recommend_picks(
        self,
        ally_picks: List[str],
        enemy_picks: List[str],
        banned_champions: List[str],
        lane: str,
        top_n: int = 10
    ) -> List[Dict]:
        """
        Recommande des champions pour un pick.

        Args:
            ally_picks: Champions déjà pickés par l'équipe alliée
            enemy_picks: Champions pickés par l'équipe ennemie
            banned_champions: Champions bannis
            lane: Lane pour laquelle recommander ('TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT')
            top_n: Nombre de recommandations à retourner

        Returns:
            Liste de recommandations avec scores et probabilités
        """
        # Récupérer tous les champions disponibles pour cette lane
        from src.data.champion_data import get_champions_for_lane
        available_champions = get_champions_for_lane(lane, self.champion_manager)

        # Filtrer les champions déjà pickés ou bannis
        all_unavailable = set(ally_picks + enemy_picks + banned_champions)
        available_champions = [
            champ for champ in available_champions
            if champ['id'] not in all_unavailable
        ]

        if not available_champions:
            return []

        # Calculer les scores pour chaque champion
        recommendations = []

        for champion in available_champions:
            score_breakdown = self._calculate_pick_score(
                champion,
                ally_picks,
                enemy_picks,
                lane
            )

            total_score = sum(score_breakdown.values())

            recommendations.append({
                'champion': champion,
                'score': total_score,
                'score_breakdown': score_breakdown,
                'probability': 0  # Sera calculé après
            })

        # Trier par score
        recommendations.sort(key=lambda x: x['score'], reverse=True)

        # Calculer les probabilités (softmax)
        recommendations = self._calculate_probabilities(recommendations)

        return recommendations[:top_n]

    def _calculate_pick_score(
        self,
        champion: Dict,
        ally_picks: List[str],
        enemy_picks: List[str],
        lane: str
    ) -> Dict[str, float]:
        """Calcule le score détaillé pour un champion."""

        champion_id = champion['id']

        # 1. Score de meta (basé sur les stats pro)
        meta_score = self._get_meta_score(champion_id)

        # 2. Score de synergie avec l'équipe alliée
        synergy_score = self._get_synergy_score(champion_id, ally_picks)

        # 3. Score de counter contre l'équipe ennemie
        counter_score = self._get_counter_score(champion_id, enemy_picks)

        # 4. Score de composition (équilibre de l'équipe)
        composition_score = self._get_composition_score(champion, ally_picks)

        # 5. Score de lane preference
        lane_score = self._get_lane_score(champion_id, lane)

        return {
            'meta': meta_score * 0.25,
            'synergy': synergy_score * 0.20,
            'counter': counter_score * 0.25,
            'composition': composition_score * 0.20,
            'lane_fit': lane_score * 0.10
        }

    def _get_meta_score(self, champion_id: str) -> float:
        """Score basé sur la popularité et le winrate dans le meta pro."""
        # Winrate dans les drafts pro
        winrate = self.pro_draft_analyzer.get_champion_winrate(champion_id)

        # Pickrate
        pickrate = self.pro_draft_analyzer.get_champion_pickrate(champion_id)

        # Banrate (un champion souvent ban est fort)
        banrate = self.pro_draft_analyzer.get_champion_banrate(champion_id)

        # Score combiné (normalisé sur 100)
        meta_score = (
            (winrate * 0.5) +
            (min(pickrate, 50) * 0.3) +  # Cap à 50% pour éviter les biais
            (min(banrate, 30) * 0.2)      # Cap à 30%
        )

        return min(meta_score, 100)

    def _get_synergy_score(self, champion_id: str, ally_picks: List[str]) -> float:
        """Score de synergie avec les alliés."""
        if not ally_picks:
            return 50  # Score neutre si pas d'alliés

        synergy_scores = []

        for ally in ally_picks:
            # Récupérer les synergies des drafts pro
            synergies = self.pro_draft_analyzer.get_best_synergies(champion_id)
            synergy_dict = dict(synergies)

            if ally in synergy_dict:
                synergy_scores.append(synergy_dict[ally])
            else:
                synergy_scores.append(10)  # Score de base

        # Moyenne des synergies
        avg_synergy = np.mean(synergy_scores) if synergy_scores else 50

        return min(avg_synergy * 2, 100)  # Amplifier et normaliser

    def _get_counter_score(self, champion_id: str, enemy_picks: List[str]) -> float:
        """Score de counter contre les ennemis."""
        if not enemy_picks:
            return 50  # Score neutre

        counter_scores = []

        for enemy in enemy_picks:
            # Récupérer les counters des drafts pro
            counters = self.pro_draft_analyzer.get_counters(champion_id)
            counter_dict = dict(counters)

            if enemy in counter_dict:
                # Ce champion counter cet ennemi
                counter_scores.append(min(counter_dict[enemy] * 10, 100))
            else:
                counter_scores.append(40)  # Score de base

        return np.mean(counter_scores) if counter_scores else 50

    def _get_composition_score(self, champion: Dict, ally_picks: List[str]) -> float:
        """Score basé sur l'amélioration de la composition."""
        if not ally_picks:
            return 70  # Score de base

        try:
            # Récupérer les données complètes des alliés
            ally_champions = []
            for ally_id in ally_picks:
                ally_champ = self.champion_manager.get_champion_by_id(ally_id)
                if ally_champ:
                    ally_champions.append(ally_champ)

            if not ally_champions:
                return 70

            # Analyser la composition actuelle
            current_comp = ally_champions.copy()
            current_analysis = self.composition_analyzer.analyze_composition(
                current_comp + [champion] * (5 - len(current_comp))  # Remplir avec le champion candidat
            )

            # Score basé sur l'équilibre des dégâts et les faiblesses
            damage_balance = current_analysis['damage_balance']['balance_score']
            overall_score = current_analysis['overall_score']

            # Pénalité si on ajoute trop du même type de dégâts
            champion_tags = set(champion.get('tags', []))

            if 'Mage' in champion_tags and current_analysis['scores']['damage_magic'] > 0.7:
                damage_balance *= 0.7
            elif 'Marksman' in champion_tags and current_analysis['scores']['damage_physical'] > 0.7:
                damage_balance *= 0.7

            return (damage_balance * 50) + (overall_score / 2)

        except Exception as e:
            print(f"Erreur dans _get_composition_score: {e}")
            return 50

    def _get_lane_score(self, champion_id: str, lane: str) -> float:
        """Score basé sur l'adéquation à la lane."""
        lane_prefs = self.pro_draft_analyzer.get_lane_preference(champion_id)

        if not lane_prefs:
            return 50  # Score neutre si pas de données

        # Score pour la lane demandée
        lane_score = lane_prefs.get(lane, 0)

        # Si le champion est souvent joué dans cette lane, bon score
        return min(lane_score * 2, 100)

    def _calculate_probabilities(self, recommendations: List[Dict]) -> List[Dict]:
        """Calcule les probabilités de pick en utilisant softmax."""
        if not recommendations:
            return []

        scores = np.array([rec['score'] for rec in recommendations])

        # Softmax avec température pour avoir des probabilités plus lisibles
        temperature = 10
        exp_scores = np.exp(scores / temperature)
        probabilities = exp_scores / np.sum(exp_scores)

        # Assigner les probabilités
        for i, rec in enumerate(recommendations):
            rec['probability'] = round(probabilities[i] * 100, 2)

        return recommendations

    def suggest_bans(
        self,
        enemy_picks: List[str],
        ally_picks: List[str],
        already_banned: List[str],
        top_n: int = 5
    ) -> List[Dict]:
        """
        Suggère des champions à bannir.

        Returns:
            Liste de suggestions de bans avec justifications
        """
        all_champions = self.champion_manager.champions

        # Filtrer les champions déjà pickés ou bannis
        unavailable = set(enemy_picks + ally_picks + already_banned)
        available_to_ban = [
            champ for champ_id, champ in all_champions.items()
            if champ_id not in unavailable
        ]

        ban_recommendations = []

        for champion in available_to_ban:
            champion_id = champion['id']

            # Score de ban basé sur plusieurs facteurs
            meta_strength = self._get_meta_score(champion_id)
            banrate = self.pro_draft_analyzer.get_champion_banrate(champion_id)

            # Si l'ennemi a déjà pick, bannir les synergies
            synergy_threat = 0
            if enemy_picks:
                for enemy in enemy_picks:
                    synergies = self.pro_draft_analyzer.get_best_synergies(enemy)
                    synergy_dict = dict(synergies)
                    if champion_id in synergy_dict:
                        synergy_threat += synergy_dict[champion_id]

            # Score total de menace
            ban_score = (
                meta_strength * 0.4 +
                banrate * 0.3 +
                min(synergy_threat, 100) * 0.3
            )

            ban_recommendations.append({
                'champion': champion,
                'ban_score': ban_score,
                'reasons': {
                    'meta_strength': round(meta_strength, 1),
                    'popular_ban': round(banrate, 1),
                    'synergy_threat': round(synergy_threat, 1)
                }
            })

        # Trier par score de ban
        ban_recommendations.sort(key=lambda x: x['ban_score'], reverse=True)

        return ban_recommendations[:top_n]
