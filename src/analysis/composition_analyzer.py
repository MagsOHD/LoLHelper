"""
Module d'analyse des compositions d'équipe League of Legends.
Évalue les forces, faiblesses et équilibre d'une composition.
"""

from typing import Dict, List, Tuple
import numpy as np
from collections import Counter

class CompositionAnalyzer:
    """Analyseur de compositions d'équipe."""

    # Poids pour l'évaluation des différents aspects
    WEIGHTS = {
        'damage_physical': 0.15,
        'damage_magic': 0.15,
        'damage_true': 0.05,
        'tankiness': 0.15,
        'crowd_control': 0.15,
        'mobility': 0.10,
        'sustain': 0.10,
        'waveclear': 0.10,
        'objective_control': 0.05
    }

    # Mapping des rôles aux capacités
    ROLE_CAPABILITIES = {
        'Fighter': {
            'damage_physical': 0.7, 'damage_magic': 0.2, 'tankiness': 0.6,
            'crowd_control': 0.5, 'mobility': 0.5, 'sustain': 0.5,
            'waveclear': 0.6, 'objective_control': 0.4
        },
        'Tank': {
            'damage_physical': 0.3, 'damage_magic': 0.2, 'tankiness': 0.9,
            'crowd_control': 0.8, 'mobility': 0.3, 'sustain': 0.6,
            'waveclear': 0.4, 'objective_control': 0.5
        },
        'Mage': {
            'damage_physical': 0.1, 'damage_magic': 0.9, 'tankiness': 0.2,
            'crowd_control': 0.6, 'mobility': 0.4, 'sustain': 0.3,
            'waveclear': 0.8, 'objective_control': 0.3
        },
        'Assassin': {
            'damage_physical': 0.6, 'damage_magic': 0.5, 'tankiness': 0.3,
            'crowd_control': 0.3, 'mobility': 0.9, 'sustain': 0.2,
            'waveclear': 0.4, 'objective_control': 0.3
        },
        'Marksman': {
            'damage_physical': 0.9, 'damage_magic': 0.1, 'tankiness': 0.2,
            'crowd_control': 0.2, 'mobility': 0.5, 'sustain': 0.3,
            'waveclear': 0.7, 'objective_control': 0.8
        },
        'Support': {
            'damage_physical': 0.2, 'damage_magic': 0.3, 'tankiness': 0.5,
            'crowd_control': 0.8, 'mobility': 0.4, 'sustain': 0.7,
            'waveclear': 0.3, 'objective_control': 0.4
        }
    }

    def __init__(self):
        pass

    def analyze_composition(self, champions: List[Dict]) -> Dict:
        """
        Analyse complète d'une composition d'équipe.

        Args:
            champions: Liste des champions avec leurs informations

        Returns:
            Dictionnaire contenant l'analyse de la composition
        """
        if len(champions) != 5:
            raise ValueError("Une composition doit contenir exactement 5 champions")

        # Calculer les scores pour chaque aspect
        scores = self._calculate_composition_scores(champions)

        # Identifier les forces et faiblesses
        strengths, weaknesses = self._identify_strengths_weaknesses(scores)

        # Analyser l'équilibre des dégâts
        damage_balance = self._analyze_damage_balance(scores)

        # Analyser la composition par phase de jeu
        game_phases = self._analyze_game_phases(champions)

        # Score global
        overall_score = self._calculate_overall_score(scores)

        return {
            'scores': scores,
            'strengths': strengths,
            'weaknesses': weaknesses,
            'damage_balance': damage_balance,
            'game_phases': game_phases,
            'overall_score': overall_score,
            'grade': self._get_grade(overall_score)
        }

    def _calculate_composition_scores(self, champions: List[Dict]) -> Dict[str, float]:
        """Calcule les scores pour chaque aspect de la composition."""
        scores = {
            'damage_physical': 0,
            'damage_magic': 0,
            'damage_true': 0,
            'tankiness': 0,
            'crowd_control': 0,
            'mobility': 0,
            'sustain': 0,
            'waveclear': 0,
            'objective_control': 0
        }

        for champion in champions:
            # Obtenir les rôles du champion
            roles = champion.get('tags', [])

            for role in roles:
                if role in self.ROLE_CAPABILITIES:
                    capabilities = self.ROLE_CAPABILITIES[role]
                    for capability, value in capabilities.items():
                        scores[capability] += value

        # Normaliser les scores (moyenne sur 5 champions)
        for key in scores:
            scores[key] = min(scores[key] / 5, 1.0)

        return scores

    def _identify_strengths_weaknesses(self, scores: Dict[str, float]) -> Tuple[List[str], List[str]]:
        """Identifie les forces et faiblesses de la composition."""
        strengths = []
        weaknesses = []

        for aspect, score in scores.items():
            if score >= 0.7:
                strengths.append(aspect)
            elif score <= 0.3:
                weaknesses.append(aspect)

        return strengths, weaknesses

    def _analyze_damage_balance(self, scores: Dict[str, float]) -> Dict:
        """Analyse l'équilibre des types de dégâts."""
        physical = scores['damage_physical']
        magic = scores['damage_magic']
        total_damage = physical + magic

        if total_damage == 0:
            return {
                'balance': 'poor',
                'recommendation': 'Composition manque de dégâts',
                'physical_percent': 0,
                'magic_percent': 0
            }

        physical_percent = (physical / total_damage) * 100
        magic_percent = (magic / total_damage) * 100

        # Équilibre idéal: 40-60% pour chaque type
        balance_score = 1 - abs(physical_percent - magic_percent) / 100

        if balance_score >= 0.8:
            balance = 'excellent'
            recommendation = 'Composition bien équilibrée en dégâts'
        elif balance_score >= 0.6:
            balance = 'good'
            recommendation = 'Bon équilibre des dégâts'
        elif balance_score >= 0.4:
            balance = 'fair'
            if physical_percent > magic_percent:
                recommendation = 'Un peu trop de dégâts physiques'
            else:
                recommendation = 'Un peu trop de dégâts magiques'
        else:
            balance = 'poor'
            if physical_percent > magic_percent:
                recommendation = 'Trop de dégâts physiques - vulnérable aux tanks'
            else:
                recommendation = 'Trop de dégâts magiques - difficile contre MR'

        return {
            'balance': balance,
            'recommendation': recommendation,
            'physical_percent': round(physical_percent, 1),
            'magic_percent': round(magic_percent, 1),
            'balance_score': round(balance_score, 2)
        }

    def _analyze_game_phases(self, champions: List[Dict]) -> Dict:
        """Analyse la force de la composition par phase de jeu."""
        # Basé sur les stats de base des champions
        early_game = 0
        mid_game = 0
        late_game = 0

        for champion in champions:
            stats = champion.get('stats', {})
            info = champion.get('info', {})

            # Early game: basé sur les dégâts de base et la difficulté
            base_attack = stats.get('attackdamage', 50)
            difficulty = info.get('difficulty', 5)

            # Champions simples sont souvent forts early
            early_game += (base_attack / 70) * (1 - difficulty / 20)

            # Mid game: équilibre de tous les aspects
            mid_game += (info.get('attack', 5) + info.get('defense', 5) + info.get('magic', 5)) / 15

            # Late game: basé sur le scaling
            attack_per_level = stats.get('attackdamageperlevel', 3)
            late_game += (attack_per_level / 5) * (info.get('attack', 5) / 10)

        # Normaliser
        early_game = min(early_game / 5, 1.0)
        mid_game = min(mid_game / 5, 1.0)
        late_game = min(late_game / 5, 1.0)

        return {
            'early_game': round(early_game, 2),
            'mid_game': round(mid_game, 2),
            'late_game': round(late_game, 2),
            'power_spike': self._get_power_spike(early_game, mid_game, late_game)
        }

    def _get_power_spike(self, early: float, mid: float, late: float) -> str:
        """Détermine quand la composition est la plus forte."""
        max_value = max(early, mid, late)

        if max_value == early:
            return 'early'
        elif max_value == mid:
            return 'mid'
        else:
            return 'late'

    def _calculate_overall_score(self, scores: Dict[str, float]) -> float:
        """Calcule le score global de la composition."""
        overall = 0

        for aspect, score in scores.items():
            weight = self.WEIGHTS.get(aspect, 0)
            overall += score * weight

        return round(overall * 100, 1)

    def _get_grade(self, score: float) -> str:
        """Convertit un score en grade."""
        if score >= 90:
            return 'S'
        elif score >= 80:
            return 'A'
        elif score >= 70:
            return 'B'
        elif score >= 60:
            return 'C'
        elif score >= 50:
            return 'D'
        else:
            return 'F'

    def compare_compositions(self, comp1: List[Dict], comp2: List[Dict]) -> Dict:
        """Compare deux compositions d'équipe."""
        analysis1 = self.analyze_composition(comp1)
        analysis2 = self.analyze_composition(comp2)

        # Comparaison aspect par aspect
        comparison = {}
        for aspect in analysis1['scores']:
            score1 = analysis1['scores'][aspect]
            score2 = analysis2['scores'][aspect]
            diff = score1 - score2

            comparison[aspect] = {
                'team1': round(score1, 2),
                'team2': round(score2, 2),
                'advantage': 'team1' if diff > 0.1 else 'team2' if diff < -0.1 else 'equal',
                'difference': round(abs(diff), 2)
            }

        return {
            'team1_analysis': analysis1,
            'team2_analysis': analysis2,
            'comparison': comparison,
            'predicted_winner': 'team1' if analysis1['overall_score'] > analysis2['overall_score'] else 'team2',
            'win_probability': self._calculate_win_probability(analysis1['overall_score'], analysis2['overall_score'])
        }

    def _calculate_win_probability(self, score1: float, score2: float) -> Dict[str, float]:
        """Calcule la probabilité de victoire basée sur les scores."""
        total = score1 + score2

        if total == 0:
            team1_prob = 50.0
            team2_prob = 50.0
        else:
            team1_prob = (score1 / total) * 100
            team2_prob = (score2 / total) * 100

        return {
            'team1': round(team1_prob, 1),
            'team2': round(team2_prob, 1)
        }
