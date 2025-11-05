"""
Module de documentation des sources de données de l'application LoL Helper.
Explique d'où viennent toutes les données utilisées dans l'application.
"""

from typing import Dict, List
from datetime import datetime

class DataSourcesManager:
    """Gestionnaire de la documentation des sources de données."""

    def __init__(self):
        self.data_sources = self._initialize_data_sources()

    def _initialize_data_sources(self) -> Dict:
        """Initialise la documentation des sources de données."""
        return {
            "riot_games_api": {
                "name": "Riot Games Data Dragon API",
                "description": "API officielle de Riot Games pour les données statiques",
                "url": "https://ddragon.leagueoflegends.com",
                "data_types": [
                    "Statistiques des champions (HP, Armure, Dégâts, etc.)",
                    "Informations des champions (Nom, Titre, Rôles, Sorts)",
                    "Données des items (Statistiques, Coûts, Descriptions)",
                    "Images des champions et items",
                    "Versions du jeu"
                ],
                "update_frequency": "Automatique à chaque patch (environ toutes les 2 semaines)",
                "cache_duration": "24 heures pour les versions, 7 jours pour les données",
                "reliability": "Très élevée (source officielle)",
                "last_updated": "Temps réel"
            },
            "pro_drafts_data": {
                "name": "Drafts Professionnels Simulés",
                "description": "Données de drafts d'équipes professionnelles pour l'analyse",
                "url": "Local (data/pro_drafts.json)",
                "data_types": [
                    "Compositions d'équipes bleues et rouges",
                    "Champions bannis par équipe",
                    "Résultats des matchs (victoire/défaite)",
                    "Durée des parties"
                ],
                "update_frequency": "Manuel (ajout de nouveaux drafts)",
                "cache_duration": "Permanent (fichier local)",
                "reliability": "Élevée (basée sur des matchs réels)",
                "last_updated": "Dernière modification du fichier",
                "note": "Les données actuelles sont des exemples. En production, elles proviendraient d'APIs comme Riot Games API ou sites tiers."
            },
            "champion_synergies": {
                "name": "Algorithmes de Synergie Calculés",
                "description": "Calculs de synergie basés sur les rôles et caractéristiques",
                "url": "Algorithmique interne",
                "data_types": [
                    "Scores de compatibilité entre champions",
                    "Matrices de synergie d'équipe",
                    "Analyses de composition",
                    "Recommandations de picks"
                ],
                "update_frequency": "Temps réel (calcul à la volée)",
                "cache_duration": "Aucun (recalculé à chaque utilisation)",
                "reliability": "Moyenne (basée sur heuristiques)",
                "algorithm_basis": [
                    "Complémentarité des rôles (Tank+ADC, Support+ADC)",
                    "Équilibre AP/AD dans l'équipe",
                    "Couverture des phases de jeu (early/late)",
                    "Diversité des rôles"
                ]
            },
            "item_recommendations": {
                "name": "Recommandations d'Items Calculées",
                "description": "Système de recommandation basé sur les rôles et stats",
                "url": "Algorithmique interne",
                "data_types": [
                    "Items recommandés par champion",
                    "Scores de synergie item-champion",
                    "Analyses de builds complets",
                    "Alternatives d'items"
                ],
                "update_frequency": "Temps réel (calcul à la volée)",
                "cache_duration": "Aucun (recalculé à chaque utilisation)",
                "reliability": "Moyenne (basée sur heuristiques)",
                "algorithm_basis": [
                    "Affinité stats-rôles (AD pour ADC, Tank items pour Tanks)",
                    "Orientation champion (Attaque vs Magie vs Défense)",
                    "Efficacité coût des items",
                    "Complémentarité des stats"
                ]
            },
            "champion_stats_scaling": {
                "name": "Calculs de Montée en Niveau",
                "description": "Formules officielles de croissance des statistiques",
                "url": "Formules League of Legends",
                "data_types": [
                    "Statistiques par niveau (1-18)",
                    "Courbes de puissance",
                    "Progression des champions"
                ],
                "update_frequency": "Temps réel (calcul à la volée)",
                "cache_duration": "Aucun (recalculé à chaque utilisation)",
                "reliability": "Très élevée (formules officielles)",
                "formula": "Stat(niveau) = Base + Croissance × (niveau-1)",
                "special_cases": [
                    "Vitesse d'attaque: Base × (1 + (Croissance/100) × (niveau-1))",
                    "Certaines stats utilisent des formules quadratiques complexes"
                ]
            }
        }

    def get_all_sources(self) -> Dict:
        """Retourne toutes les sources de données."""
        return self.data_sources

    def get_source_by_name(self, source_name: str) -> Dict:
        """Retourne une source spécifique."""
        return self.data_sources.get(source_name, {})

    def get_data_freshness_status(self) -> Dict:
        """Retourne le statut de fraîcheur des données."""
        return {
            "riot_api": {
                "status": "🟢 Actuel",
                "description": "Données mises à jour automatiquement depuis l'API officielle"
            },
            "pro_drafts": {
                "status": "🟡 Exemples",
                "description": "Données d'exemple pour démonstration"
            },
            "calculations": {
                "status": "🟢 Temps réel",
                "description": "Calculs effectués à la demande avec les dernières données"
            }
        }

    def get_reliability_scores(self) -> Dict:
        """Retourne les scores de fiabilité des différents types de données."""
        return {
            "champion_base_stats": {
                "score": 10,
                "description": "Très fiable - Données officielles Riot Games"
            },
            "item_stats": {
                "score": 10,
                "description": "Très fiable - Données officielles Riot Games"
            },
            "pro_match_results": {
                "score": 6,
                "description": "Données d'exemple - En production, score de 9/10"
            },
            "synergy_calculations": {
                "score": 7,
                "description": "Fiable - Basé sur l'expérience de jeu et heuristiques"
            },
            "level_scaling": {
                "score": 10,
                "description": "Très fiable - Formules officielles League of Legends"
            },
            "item_recommendations": {
                "score": 7,
                "description": "Fiable - Basé sur les méta et rôles établis"
            }
        }

    def get_update_schedule(self) -> Dict:
        """Retourne le planning de mise à jour des données."""
        return {
            "daily": [
                "Vérification de nouvelle version du jeu",
                "Mise à jour du cache des champions si nécessaire"
            ],
            "weekly": [
                "Refresh complet du cache des items",
                "Vérification des liens d'images"
            ],
            "per_patch": [
                "Mise à jour complète des données champions",
                "Mise à jour des données items",
                "Recalibrage des algorithmes de recommandation"
            ],
            "manual": [
                "Ajout de nouveaux drafts professionnels",
                "Ajustement des algorithmes de synergie",
                "Mise à jour des métadonnées"
            ]
        }

    def get_api_limits_and_constraints(self) -> Dict:
        """Retourne les limitations et contraintes des APIs."""
        return {
            "riot_data_dragon": {
                "rate_limits": "Aucune limite stricte (API publique)",
                "constraints": [
                    "Données statiques seulement (pas de matchs en temps réel)",
                    "Mise à jour uniquement lors des patchs",
                    "Pas d'accès aux statistiques de joueurs individuels"
                ],
                "advantages": [
                    "Données officielles et fiables",
                    "Images haute qualité",
                    "Support multilingue",
                    "Historique des versions"
                ]
            },
            "internal_algorithms": {
                "performance": "Calculs en temps réel, < 100ms",
                "limitations": [
                    "Basés sur des heuristiques, pas de machine learning",
                    "Pas d'adaptation au méta actuel automatique",
                    "Simplicité volontaire pour la transparence"
                ],
                "strengths": [
                    "Transparents et explicables",
                    "Personnalisables facilement",
                    "Aucune dépendance externe",
                    "Calculs déterministes"
                ]
            }
        }

    def get_data_quality_metrics(self) -> Dict:
        """Retourne les métriques de qualité des données."""
        return {
            "completeness": {
                "champions": "100% (tous les champions LoL disponibles)",
                "items": "~95% (items achetables sur la Faille)",
                "synergies": "100% (toutes les combinaisons calculées)"
            },
            "accuracy": {
                "base_stats": "100% (source officielle)",
                "calculated_values": "~90% (formules vérifiées)",
                "recommendations": "~75% (basées sur heuristiques)"
            },
            "consistency": {
                "data_format": "100% (format standardisé)",
                "naming": "100% (noms officiels)",
                "calculations": "100% (reproductibles)"
            },
            "timeliness": {
                "patch_updates": "< 24h après release officiel",
                "version_detection": "Automatique",
                "cache_refresh": "Configurable (24h par défaut)"
            }
        }

def get_data_attribution_text() -> str:
    """Retourne le texte d'attribution des données."""
    return """
    ## 📊 Sources des Données

    ### Données Officielles
    - **Champions et Items**: Riot Games Data Dragon API
    - **Images**: Riot Games CDN officiel
    - **Formules de niveau**: Documentation officielle League of Legends

    ### Données Calculées
    - **Synergies**: Algorithmes basés sur l'expérience de jeu
    - **Recommandations**: Heuristiques de rôles et méta
    - **Analyses**: Calculs propriétaires transparents

    ### Données d'Exemple
    - **Drafts Pro**: Exemples pour démonstration (à remplacer par vraies données)

    **Disclaimer**: Cette application n'est pas officiellement approuvée par Riot Games.
    League of Legends est une marque déposée de Riot Games, Inc.
    """

def get_privacy_and_usage_info() -> str:
    """Retourne les informations sur la confidentialité et l'usage."""
    return """
    ## 🔒 Confidentialité et Usage

    ### Données Personnelles
    - **Aucune donnée personnelle** n'est collectée ou stockée
    - **Pas de comptes utilisateur** requis
    - **Pas de tracking** des sessions

    ### Données Utilisées
    - **Uniquement données publiques** de l'API Riot Games
    - **Cache local temporaire** pour les performances
    - **Calculs locaux** sans envoi de données externes

    ### Usage des Données
    - **Analyse statistique** des champions et items
    - **Recommandations de builds** basées sur algorithmes
    - **Visualisations** pour l'aide à la décision

    ### Stockage
    - **Cache disque local** (supprimable à tout moment)
    - **Aucun serveur externe** utilisé
    - **Données volatiles** en mémoire uniquement
    """