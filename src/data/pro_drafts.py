"""
Module pour gérer et analyser les drafts professionnels de League of Legends.
"""

import json
import os
from typing import Dict, List, Tuple, Optional
from collections import defaultdict, Counter
import pandas as pd

class ProDraftAnalyzer:
    """Analyseur de drafts professionnels."""

    def __init__(self, data_file: str = 'data/pro_drafts.json'):
        self.data_file = data_file
        self.drafts: List[Dict] = []
        self.champion_stats: Dict = defaultdict(lambda: {
            'picks': 0,
            'bans': 0,
            'wins': 0,
            'losses': 0,
            'with_champions': Counter(),  # Champions joués avec
            'against_champions': Counter(),  # Champions joués contre
            'lane_distribution': Counter()
        })
        self.synergies: Dict = defaultdict(lambda: defaultdict(int))
        self.counters: Dict = defaultdict(lambda: defaultdict(int))

        self._load_drafts()
        self._analyze_drafts()

    def _load_drafts(self):
        """Charge les drafts depuis le fichier JSON."""
        if os.path.exists(self.data_file):
            try:
                with open(self.data_file, 'r', encoding='utf-8') as f:
                    self.drafts = json.load(f)
            except Exception as e:
                print(f"Erreur lors du chargement des drafts: {e}")
                self.drafts = []
        else:
            # Créer des données d'exemple pour démonstration
            self.drafts = self._generate_sample_drafts()
            self._save_drafts()

    def _save_drafts(self):
        """Sauvegarde les drafts dans le fichier JSON."""
        os.makedirs(os.path.dirname(self.data_file), exist_ok=True)
        try:
            with open(self.data_file, 'w', encoding='utf-8') as f:
                json.dump(self.drafts, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Erreur lors de la sauvegarde des drafts: {e}")

    def _generate_sample_drafts(self) -> List[Dict]:
        """Génère des drafts d'exemple pour démonstration."""
        # Quelques compositions populaires basées sur le meta actuel
        sample_drafts = [
            {
                'blue_team': {
                    'picks': ['Aatrox', 'LeeSin', 'Ahri', 'Jinx', 'Thresh'],
                    'bans': ['Zed', 'Yasuo', 'Darius', 'Blitzcrank', 'MasterYi']
                },
                'red_team': {
                    'picks': ['Garen', 'Jarvan IV', 'Syndra', 'Caitlyn', 'Lulu'],
                    'bans': ['Katarina', 'Fizz', 'Vayne', 'Pyke', 'Hecarim']
                },
                'winner': 'blue',
                'match_duration': 1800
            },
            {
                'blue_team': {
                    'picks': ['Ornn', 'Graves', 'Viktor', 'Aphelios', 'Nautilus'],
                    'bans': ['Akali', 'Sylas', 'Kalista', 'Renata Glasc', 'Nidalee']
                },
                'red_team': {
                    'picks': ['Renekton', 'Viego', 'Orianna', 'Ezreal', 'Rakan'],
                    'bans': ['Zeri', 'Yuumi', 'Kaisa', 'LeBlanc', 'KSante']
                },
                'winner': 'red',
                'match_duration': 2100
            }
        ]
        return sample_drafts

    def _analyze_drafts(self):
        """Analyse tous les drafts pour extraire des statistiques."""
        for draft in self.drafts:
            blue_picks = draft['blue_team']['picks']
            red_picks = draft['red_team']['picks']
            blue_bans = draft['blue_team']['bans']
            red_bans = draft['red_team']['bans']
            winner = draft['winner']

            # Analyser les picks de la blue team
            for i, champ in enumerate(blue_picks):
                self.champion_stats[champ]['picks'] += 1
                lane = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'][i]
                self.champion_stats[champ]['lane_distribution'][lane] += 1

                if winner == 'blue':
                    self.champion_stats[champ]['wins'] += 1
                else:
                    self.champion_stats[champ]['losses'] += 1

                # Synergies (champions de la même équipe)
                for other_champ in blue_picks:
                    if other_champ != champ:
                        self.champion_stats[champ]['with_champions'][other_champ] += 1
                        self.synergies[champ][other_champ] += 1

                # Matchups (champions adverses)
                for enemy_champ in red_picks:
                    self.champion_stats[champ]['against_champions'][enemy_champ] += 1
                    if winner == 'blue':
                        self.counters[champ][enemy_champ] += 1

            # Analyser les picks de la red team
            for i, champ in enumerate(red_picks):
                self.champion_stats[champ]['picks'] += 1
                lane = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'][i]
                self.champion_stats[champ]['lane_distribution'][lane] += 1

                if winner == 'red':
                    self.champion_stats[champ]['wins'] += 1
                else:
                    self.champion_stats[champ]['losses'] += 1

                # Synergies
                for other_champ in red_picks:
                    if other_champ != champ:
                        self.champion_stats[champ]['with_champions'][other_champ] += 1
                        self.synergies[champ][other_champ] += 1

                # Matchups
                for enemy_champ in blue_picks:
                    self.champion_stats[champ]['against_champions'][enemy_champ] += 1
                    if winner == 'red':
                        self.counters[champ][enemy_champ] += 1

            # Bans
            for champ in blue_bans + red_bans:
                self.champion_stats[champ]['bans'] += 1

    def get_champion_winrate(self, champion: str) -> float:
        """Calcule le winrate d'un champion dans les drafts pro."""
        stats = self.champion_stats.get(champion, {})
        wins = stats.get('wins', 0)
        losses = stats.get('losses', 0)
        total = wins + losses

        return (wins / total * 100) if total > 0 else 0.0

    def get_champion_pickrate(self, champion: str) -> float:
        """Calcule le pickrate d'un champion."""
        stats = self.champion_stats.get(champion, {})
        picks = stats.get('picks', 0)
        total_games = len(self.drafts)

        return (picks / total_games * 100) if total_games > 0 else 0.0

    def get_champion_banrate(self, champion: str) -> float:
        """Calcule le banrate d'un champion."""
        stats = self.champion_stats.get(champion, {})
        bans = stats.get('bans', 0)
        total_games = len(self.drafts)

        return (bans / total_games * 100) if total_games > 0 else 0.0

    def get_best_synergies(self, champion: str, top_n: int = 5) -> List[Tuple[str, float]]:
        """Récupère les meilleures synergies pour un champion."""
        if champion not in self.synergies:
            return []

        synergies = self.synergies[champion]
        sorted_synergies = sorted(synergies.items(), key=lambda x: x[1], reverse=True)

        # Calculer le score de synergie (normalisé)
        result = []
        for other_champ, count in sorted_synergies[:top_n]:
            # Score basé sur le nombre de fois joués ensemble et winrate
            score = count / len(self.drafts) * 100
            result.append((other_champ, score))

        return result

    def get_counters(self, champion: str, top_n: int = 5) -> List[Tuple[str, float]]:
        """Récupère les meilleurs counters d'un champion."""
        if champion not in self.counters:
            return []

        counters = self.counters[champion]
        sorted_counters = sorted(counters.items(), key=lambda x: x[1], reverse=True)

        return sorted_counters[:top_n]

    def get_lane_preference(self, champion: str) -> Dict[str, float]:
        """Obtient la distribution de lanes pour un champion."""
        stats = self.champion_stats.get(champion, {})
        lane_dist = stats.get('lane_distribution', {})

        total = sum(lane_dist.values())
        if total == 0:
            return {}

        return {
            lane: (count / total * 100)
            for lane, count in lane_dist.items()
        }

    def add_draft(self, draft: Dict):
        """Ajoute un nouveau draft à la base de données."""
        self.drafts.append(draft)
        self._save_drafts()
        self._analyze_drafts()  # Réanalyser

    def get_stats_dataframe(self) -> pd.DataFrame:
        """Convertit les statistiques en DataFrame pandas."""
        data = []
        for champion, stats in self.champion_stats.items():
            wins = stats.get('wins', 0)
            losses = stats.get('losses', 0)
            total = wins + losses

            data.append({
                'Champion': champion,
                'Picks': stats.get('picks', 0),
                'Bans': stats.get('bans', 0),
                'Wins': wins,
                'Losses': losses,
                'Winrate': (wins / total * 100) if total > 0 else 0,
                'Pickrate': (stats.get('picks', 0) / len(self.drafts) * 100) if self.drafts else 0,
                'Banrate': (stats.get('bans', 0) / len(self.drafts) * 100) if self.drafts else 0
            })

        return pd.DataFrame(data)

    def find_similar_compositions(self, team_composition: List[str], similarity_threshold: float = 0.6) -> List[Dict]:
        """
        Trouve des compositions pro similaires à celle donnée.

        Args:
            team_composition: Liste des noms de champions de l'équipe
            similarity_threshold: Seuil de similitude (0-1)

        Returns:
            Liste des drafts similaires avec scores de similitude
        """
        if not team_composition:
            return []

        similar_drafts = []

        for draft in self.drafts:
            # Vérifier les deux équipes du draft
            for team_key in ['blue_team', 'red_team']:
                team_picks = draft[team_key]['picks']

                # Calculer la similitude (champions en commun / total champions)
                common_champions = set(team_composition) & set(team_picks)
                similarity = len(common_champions) / max(len(team_composition), len(team_picks))

                if similarity >= similarity_threshold:
                    draft_info = {
                        'draft': draft,
                        'team': team_key,
                        'picks': team_picks,
                        'bans': draft[team_key]['bans'],
                        'opponent_picks': draft['red_team' if team_key == 'blue_team' else 'blue_team']['picks'],
                        'opponent_bans': draft['red_team' if team_key == 'blue_team' else 'blue_team']['bans'],
                        'similarity': similarity,
                        'won': draft['winner'] == team_key.split('_')[0],
                        'duration': draft['match_duration'],
                        'common_champions': list(common_champions)
                    }
                    similar_drafts.append(draft_info)

        # Trier par similitude décroissante
        similar_drafts.sort(key=lambda x: x['similarity'], reverse=True)
        return similar_drafts[:5]  # Top 5

    def get_draft_explanation(self, team_composition: List[str]) -> Dict:
        """
        Génère une explication détaillée d'une composition.

        Args:
            team_composition: Liste des noms de champions

        Returns:
            Dictionnaire avec l'analyse de la composition
        """
        if len(team_composition) < 3:
            return {"error": "Au moins 3 champions nécessaires pour l'analyse"}

        explanation = {
            "strengths": [],
            "weaknesses": [],
            "game_plan": [],
            "counters_to_avoid": [],
            "power_spikes": {},
            "team_fight_rating": 0,
            "split_push_rating": 0,
            "early_game_rating": 0,
            "late_game_rating": 0
        }

        # Analyser les champions individuels
        champion_roles = {}
        damage_types = {"physical": 0, "magical": 0, "mixed": 0}

        for champ_name in team_composition:
            # Simuler une analyse basée sur des données connues
            if champ_name in ["Aatrox", "Jax", "Renekton", "Gnar"]:
                champion_roles["top_laner"] = champ_name
                if champ_name in ["Aatrox", "Renekton"]:
                    explanation["early_game_rating"] += 20
                if champ_name in ["Jax", "Gnar"]:
                    explanation["late_game_rating"] += 20

            elif champ_name in ["Graves", "Viego", "LeeSin", "Kindred"]:
                champion_roles["jungler"] = champ_name
                if champ_name in ["LeeSin", "Graves"]:
                    explanation["early_game_rating"] += 25
                if champ_name in ["Viego", "Kindred"]:
                    explanation["team_fight_rating"] += 20

            elif champ_name in ["Viktor", "Orianna", "Ahri", "LeBlanc"]:
                champion_roles["mid_laner"] = champ_name
                damage_types["magical"] += 1
                if champ_name in ["LeBlanc", "Ahri"]:
                    explanation["split_push_rating"] += 15
                if champ_name in ["Viktor", "Orianna"]:
                    explanation["team_fight_rating"] += 25

            elif champ_name in ["Jinx", "Kaisa", "Caitlyn", "Ezreal", "Aphelios"]:
                champion_roles["adc"] = champ_name
                damage_types["physical"] += 1
                explanation["late_game_rating"] += 25
                if champ_name in ["Ezreal"]:
                    explanation["early_game_rating"] += 15

            elif champ_name in ["Thresh", "Nautilus", "Braum", "Lulu", "Renata Glasc"]:
                champion_roles["support"] = champ_name
                if champ_name in ["Thresh", "Nautilus", "Braum"]:
                    explanation["team_fight_rating"] += 20
                if champ_name in ["Lulu", "Renata Glasc"]:
                    explanation["late_game_rating"] += 15

        # Analyser les forces
        if explanation["team_fight_rating"] >= 40:
            explanation["strengths"].append("Excellent potentiel en team fight")
            explanation["game_plan"].append("Chercher des combats groupés en mid/late game")

        if explanation["early_game_rating"] >= 40:
            explanation["strengths"].append("Forte pression early game")
            explanation["game_plan"].append("Contrôler les objectifs early et snowball")

        if explanation["late_game_rating"] >= 40:
            explanation["strengths"].append("Scaling exceptionnel en late game")
            explanation["game_plan"].append("Farmer et attendre les items de fin de partie")

        # Analyser les faiblesses
        if explanation["early_game_rating"] < 20:
            explanation["weaknesses"].append("Vulnérable en early game")
            explanation["counters_to_avoid"].extend(["LeeSin", "Graves", "Renekton"])

        if explanation["late_game_rating"] < 20:
            explanation["weaknesses"].append("Faible scaling en late game")

        if damage_types["magical"] == 0:
            explanation["weaknesses"].append("Manque de dégâts magiques")
        elif damage_types["physical"] == 0:
            explanation["weaknesses"].append("Manque de dégâts physiques")

        # Power spikes
        if explanation["early_game_rating"] >= 30:
            explanation["power_spikes"]["early"] = "Niveaux 1-6 et premiers items"
        if explanation["team_fight_rating"] >= 30:
            explanation["power_spikes"]["mid"] = "Items core et niveau 11-13"
        if explanation["late_game_rating"] >= 30:
            explanation["power_spikes"]["late"] = "Items complets et niveau 16+"

        # Normaliser les ratings (0-100)
        for rating in ["team_fight_rating", "split_push_rating", "early_game_rating", "late_game_rating"]:
            explanation[rating] = min(100, explanation[rating])

        return explanation

    def get_composition_winrate(self, team_composition: List[str]) -> float:
        """
        Calcule le winrate d'une composition basé sur les drafts pro.

        Args:
            team_composition: Liste des noms de champions

        Returns:
            Winrate en pourcentage (0-100)
        """
        similar_drafts = self.find_similar_compositions(team_composition, 0.4)

        if not similar_drafts:
            return 50.0  # Winrate neutre si aucune donnée

        wins = sum(1 for draft in similar_drafts if draft['won'])
        total = len(similar_drafts)

        return (wins / total) * 100 if total > 0 else 50.0
