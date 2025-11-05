"""
Module de visualisation des statistiques des items et champions.
Créé des graphiques et interfaces pour analyser les données.
"""

import streamlit as st
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import pandas as pd
from typing import Dict, List, Optional

class StatsViewer:
    """Gestionnaire des visualisations de statistiques."""

    def __init__(self):
        self.colors = {
            'primary': '#C89B3C',
            'secondary': '#0E1C2F',
            'background': '#0A1428',
            'text': '#F0E6D2',
            'success': '#00FF88',
            'warning': '#FFB800',
            'danger': '#FF4444'
        }

    def create_item_stats_chart(self, item: Dict) -> go.Figure:
        """Crée un graphique radar pour les statistiques d'un item."""
        stats = item.get('stats', {})
        if not stats:
            return go.Figure()

        # Mapper les noms de stats pour l'affichage
        stat_mapping = {
            'FlatHPPoolMod': 'Points de Vie',
            'FlatMPPoolMod': 'Points de Mana',
            'FlatArmorMod': 'Armure',
            'FlatSpellBlockMod': 'Résistance Magique',
            'FlatPhysicalDamageMod': 'Dégâts d\'Attaque',
            'FlatMagicDamageMod': 'Puissance',
            'FlatCritChanceMod': 'Chance de Critique',
            'FlatAttackSpeedMod': 'Vitesse d\'Attaque',
            'FlatMovementSpeedMod': 'Vitesse de Déplacement',
            'PercentLifeStealMod': 'Vol de Vie',
            'FlatEnergyRegenMod': 'Régénération d\'Énergie',
            'FlatHPRegenMod': 'Régénération de Vie',
            'FlatMPRegenMod': 'Régénération de Mana'
        }

        categories = []
        values = []

        for stat, value in stats.items():
            display_name = stat_mapping.get(stat, stat)
            categories.append(display_name)
            values.append(value)

        fig = go.Figure()

        fig.add_trace(go.Scatterpolar(
            r=values,
            theta=categories,
            fill='toself',
            name=item['name'],
            line_color=self.colors['primary'],
            fillcolor=f"rgba(200, 155, 60, 0.3)"
        ))

        fig.update_layout(
            polar=dict(
                radialaxis=dict(
                    visible=True,
                    color=self.colors['text'],
                    gridcolor=self.colors['secondary']
                ),
                angularaxis=dict(
                    color=self.colors['text']
                )
            ),
            showlegend=True,
            title=f"Statistiques de {item['name']}",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text']
        )

        return fig

    def create_champion_stats_chart(self, champion: Dict) -> go.Figure:
        """Crée un graphique radar pour les statistiques d'un champion."""
        stats = champion.get('stats', {})
        info = champion.get('info', {})

        if not stats and not info:
            return go.Figure()

        # Utiliser les stats d'info pour le radar (plus visuelles)
        categories = ['Attaque', 'Défense', 'Magie', 'Difficulté']
        values = [
            info.get('attack', 0),
            info.get('defense', 0),
            info.get('magic', 0),
            info.get('difficulty', 0)
        ]

        fig = go.Figure()

        fig.add_trace(go.Scatterpolar(
            r=values,
            theta=categories,
            fill='toself',
            name=champion['name'],
            line_color=self.colors['primary'],
            fillcolor=f"rgba(200, 155, 60, 0.3)"
        ))

        fig.update_layout(
            polar=dict(
                radialaxis=dict(
                    visible=True,
                    range=[0, 10],
                    color=self.colors['text'],
                    gridcolor=self.colors['secondary']
                ),
                angularaxis=dict(
                    color=self.colors['text']
                )
            ),
            showlegend=True,
            title=f"Profil de {champion['name']}",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text']
        )

        return fig

    def create_champion_base_stats_chart(self, champion: Dict) -> go.Figure:
        """Crée un graphique en barres pour les statistiques de base d'un champion."""
        stats = champion.get('stats', {})
        if not stats:
            return go.Figure()

        # Sélectionner les stats les plus importantes
        important_stats = {
            'hp': 'Points de Vie',
            'mp': 'Points de Mana',
            'armor': 'Armure',
            'spellblock': 'Résistance Magique',
            'attackdamage': 'Dégâts d\'Attaque',
            'attackspeed': 'Vitesse d\'Attaque',
            'movespeed': 'Vitesse de Déplacement'
        }

        categories = []
        values = []

        for stat, display_name in important_stats.items():
            if stat in stats:
                categories.append(display_name)
                values.append(stats[stat])

        fig = go.Figure(data=[
            go.Bar(
                x=categories,
                y=values,
                marker_color=self.colors['primary'],
                text=values,
                textposition='auto',
            )
        ])

        fig.update_layout(
            title=f"Statistiques de base - {champion['name']}",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text'],
            xaxis=dict(color=self.colors['text']),
            yaxis=dict(color=self.colors['text'])
        )

        return fig

    def create_items_comparison_chart(self, items: List[Dict], stat: str) -> go.Figure:
        """Compare plusieurs items sur une statistique donnée."""
        if not items:
            return go.Figure()

        names = []
        values = []
        costs = []

        for item in items:
            stats = item.get('stats', {})
            if stat in stats:
                names.append(item['name'])
                values.append(stats[stat])
                costs.append(item['gold'].get('total', 0))

        if not names:
            return go.Figure()

        # Créer un graphique scatter pour montrer la relation valeur/coût
        fig = go.Figure()

        fig.add_trace(go.Scatter(
            x=costs,
            y=values,
            mode='markers+text',
            text=names,
            textposition="top center",
            marker=dict(
                size=12,
                color=self.colors['primary'],
                line=dict(width=2, color=self.colors['secondary'])
            ),
            name=stat
        ))

        fig.update_layout(
            title=f"Comparaison d'items - {stat}",
            title_font_color=self.colors['primary'],
            xaxis_title="Coût (Gold)",
            yaxis_title=f"Valeur de {stat}",
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text'],
            xaxis=dict(color=self.colors['text'], gridcolor=self.colors['secondary']),
            yaxis=dict(color=self.colors['text'], gridcolor=self.colors['secondary'])
        )

        return fig

    def create_build_path_diagram(self, build_path: Dict) -> go.Figure:
        """Crée un diagramme du chemin de construction d'un item."""
        if not build_path:
            return go.Figure()

        fig = go.Figure()

        # Item principal au centre
        main_item = build_path['item']
        fig.add_trace(go.Scatter(
            x=[0],
            y=[0],
            mode='markers+text',
            text=[main_item['name']],
            textposition="middle center",
            marker=dict(
                size=50,
                color=self.colors['primary'],
                line=dict(width=3, color=self.colors['text'])
            ),
            name="Item Principal"
        ))

        # Composants (à gauche)
        components = build_path.get('components', [])
        for i, component in enumerate(components):
            y_pos = (i - len(components)/2 + 0.5) * 0.5
            fig.add_trace(go.Scatter(
                x=[-1],
                y=[y_pos],
                mode='markers+text',
                text=[component['name']],
                textposition="middle center",
                marker=dict(
                    size=30,
                    color=self.colors['secondary'],
                    line=dict(width=2, color=self.colors['text'])
                ),
                name="Composant"
            ))

            # Ligne vers l'item principal
            fig.add_shape(
                type="line",
                x0=-1, y0=y_pos,
                x1=0, y1=0,
                line=dict(color=self.colors['text'], width=2)
            )

        # Items construits (à droite)
        builds_into = build_path.get('builds_into', [])
        for i, upgrade in enumerate(builds_into):
            y_pos = (i - len(builds_into)/2 + 0.5) * 0.5
            fig.add_trace(go.Scatter(
                x=[1],
                y=[y_pos],
                mode='markers+text',
                text=[upgrade['name']],
                textposition="middle center",
                marker=dict(
                    size=30,
                    color=self.colors['warning'],
                    line=dict(width=2, color=self.colors['text'])
                ),
                name="Amélioration"
            ))

            # Ligne depuis l'item principal
            fig.add_shape(
                type="line",
                x0=0, y0=0,
                x1=1, y1=y_pos,
                line=dict(color=self.colors['text'], width=2)
            )

        fig.update_layout(
            title=f"Chemin de construction - {main_item['name']}",
            title_font_color=self.colors['primary'],
            showlegend=False,
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            xaxis=dict(
                showgrid=False,
                showticklabels=False,
                zeroline=False,
                range=[-1.5, 1.5]
            ),
            yaxis=dict(
                showgrid=False,
                showticklabels=False,
                zeroline=False,
                scaleanchor="x",
                scaleratio=1
            ),
            font_color=self.colors['text']
        )

        return fig

    def create_item_efficiency_chart(self, items_with_efficiency: List[Dict]) -> go.Figure:
        """Crée un graphique de l'efficacité des items."""
        if not items_with_efficiency:
            return go.Figure()

        # Prendre les 20 meilleurs items pour éviter la surcharge
        top_items = items_with_efficiency[:20]

        names = [item['item']['name'] for item in top_items]
        efficiencies = [item['efficiency'] for item in top_items]
        scores = [item['score'] for item in top_items]

        fig = go.Figure(data=[
            go.Bar(
                x=names,
                y=efficiencies,
                marker_color=self.colors['primary'],
                text=[f"{eff:.2f}" for eff in efficiencies],
                textposition='auto',
                name="Efficacité"
            )
        ])

        fig.update_layout(
            title="Efficacité des Items (Score par Gold)",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text'],
            xaxis=dict(
                color=self.colors['text'],
                tickangle=45
            ),
            yaxis=dict(
                color=self.colors['text'],
                title="Efficacité (Stats/Gold)"
            )
        )

        return fig

    def create_champions_comparison_radar(self, champions: List[Dict]) -> go.Figure:
        """Crée un graphique radar pour comparer plusieurs champions."""
        if not champions or len(champions) < 2:
            return go.Figure()

        fig = go.Figure()

        # Couleurs pour chaque champion
        colors = [
            '#C89B3C', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
            '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE'
        ]

        categories = ['Attaque', 'Défense', 'Magie', 'Difficulté']

        for i, champion in enumerate(champions):
            info = champion.get('info', {})
            values = [
                info.get('attack', 0),
                info.get('defense', 0),
                info.get('magic', 0),
                info.get('difficulty', 0)
            ]

            color = colors[i % len(colors)]

            fig.add_trace(go.Scatterpolar(
                r=values,
                theta=categories,
                fill='toself',
                name=champion['name'],
                line_color=color,
                fillcolor=f"rgba({self._hex_to_rgb(color)}, 0.2)"
            ))

        fig.update_layout(
            polar=dict(
                radialaxis=dict(
                    visible=True,
                    range=[0, 10],
                    color=self.colors['text'],
                    gridcolor=self.colors['secondary']
                ),
                angularaxis=dict(
                    color=self.colors['text']
                )
            ),
            showlegend=True,
            title="Comparaison des Profils de Champions",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text']
        )

        return fig

    def create_champions_base_stats_comparison(self, champions: List[Dict]) -> go.Figure:
        """Compare les statistiques de base de plusieurs champions."""
        if not champions or len(champions) < 2:
            return go.Figure()

        # Statistiques importantes à comparer
        important_stats = {
            'hp': 'Points de Vie',
            'mp': 'Points de Mana',
            'armor': 'Armure',
            'spellblock': 'Résistance Magique',
            'attackdamage': 'Dégâts d\'Attaque',
            'attackspeed': 'Vitesse d\'Attaque',
            'movespeed': 'Vitesse de Déplacement'
        }

        # Couleurs pour chaque champion
        colors = ['#C89B3C', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4']

        fig = go.Figure()

        # Créer une barre pour chaque champion
        for i, champion in enumerate(champions):
            stats = champion.get('stats', {})
            values = []
            stat_names = []

            for stat, display_name in important_stats.items():
                if stat in stats:
                    stat_names.append(display_name)
                    values.append(stats[stat])

            if values:
                fig.add_trace(go.Bar(
                    x=stat_names,
                    y=values,
                    name=champion['name'],
                    marker_color=colors[i % len(colors)],
                    text=values,
                    textposition='auto',
                ))

        fig.update_layout(
            title="Comparaison des Statistiques de Base",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text'],
            xaxis=dict(color=self.colors['text']),
            yaxis=dict(color=self.colors['text']),
            barmode='group'
        )

        return fig

    def create_champions_roles_distribution(self, champions: List[Dict]) -> go.Figure:
        """Crée un graphique de distribution des rôles des champions."""
        if not champions:
            return go.Figure()

        # Compter les rôles
        role_count = {}
        champion_roles = {}

        for champion in champions:
            champion_roles[champion['name']] = champion.get('tags', [])
            for role in champion.get('tags', []):
                role_count[role] = role_count.get(role, 0) + 1

        # Créer le graphique en secteurs
        fig = go.Figure(data=[go.Pie(
            labels=list(role_count.keys()),
            values=list(role_count.values()),
            hole=0.3,
            marker_colors=[self.colors['primary'], self.colors['warning'],
                          self.colors['success'], self.colors['danger'],
                          '#9B59B6', '#E67E22', '#1ABC9C']
        )])

        fig.update_layout(
            title="Distribution des Rôles",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text']
        )

        return fig

    def create_team_synergy_heatmap(self, champions: List[Dict], synergy_matrix: List[List[float]]) -> go.Figure:
        """Crée une heatmap des synergies entre champions d'une équipe."""
        if not champions or not synergy_matrix:
            return go.Figure()

        champion_names = [champ['name'] for champ in champions]

        fig = go.Figure(data=go.Heatmap(
            z=synergy_matrix,
            x=champion_names,
            y=champion_names,
            colorscale='RdYlGn',
            colorbar=dict(title="Score de Synergie"),
            text=[[f"{val:.1f}" for val in row] for row in synergy_matrix],
            texttemplate="%{text}",
            textfont={"size": 12}
        ))

        fig.update_layout(
            title="Matrice de Synergie entre Champions",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text'],
            xaxis=dict(color=self.colors['text']),
            yaxis=dict(color=self.colors['text'])
        )

        return fig

    def create_team_composition_analysis(self, champions: List[Dict], analysis: Dict) -> go.Figure:
        """Crée un graphique d'analyse de composition d'équipe."""
        if not champions or not analysis:
            return go.Figure()

        # Catégories d'analyse
        categories = list(analysis.keys())
        values = list(analysis.values())

        fig = go.Figure()

        fig.add_trace(go.Bar(
            x=categories,
            y=values,
            marker_color=[
                self.colors['success'] if v >= 70 else
                self.colors['warning'] if v >= 50 else
                self.colors['danger'] for v in values
            ],
            text=[f"{v:.1f}%" for v in values],
            textposition='auto',
        ))

        fig.update_layout(
            title=f"Analyse de Composition - {len(champions)} Champions",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text'],
            xaxis=dict(
                color=self.colors['text'],
                tickangle=45
            ),
            yaxis=dict(
                color=self.colors['text'],
                title="Score (%)",
                range=[0, 100]
            )
        )

        return fig

    def _hex_to_rgb(self, hex_color: str) -> str:
        """Convertit une couleur hex en RGB pour l'opacité."""
        hex_color = hex_color.lstrip('#')
        rgb = tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
        return f"{rgb[0]}, {rgb[1]}, {rgb[2]}"

    def create_champion_power_curve(self, power_curve: Dict, champion_name: str) -> go.Figure:
        """Crée un graphique de courbe de puissance d'un champion par niveau."""
        if not power_curve or 'levels' not in power_curve:
            return go.Figure()

        fig = go.Figure()

        # Couleurs pour différentes stats
        stat_colors = {
            'hp': '#00FF88',
            'damage': '#FF6B6B',
            'armor': '#FFB800',
            'magic_resist': '#4ECDC4',
            'attack_speed': '#C89B3C'
        }

        # Ajouter chaque courbe
        for stat_name, values in power_curve.items():
            if stat_name == 'levels':
                continue

            display_name = {
                'hp': 'Points de Vie',
                'damage': 'Dégâts d\'Attaque',
                'armor': 'Armure',
                'magic_resist': 'Résistance Magique',
                'attack_speed': 'Vitesse d\'Attaque'
            }.get(stat_name, stat_name)

            fig.add_trace(go.Scatter(
                x=power_curve['levels'],
                y=values,
                mode='lines+markers',
                name=display_name,
                line=dict(color=stat_colors.get(stat_name, self.colors['primary']), width=3),
                marker=dict(size=6)
            ))

        fig.update_layout(
            title=f"Courbe de Puissance - {champion_name}",
            title_font_color=self.colors['primary'],
            xaxis=dict(
                title="Niveau",
                color=self.colors['text'],
                gridcolor=self.colors['secondary'],
                range=[1, 18]
            ),
            yaxis=dict(
                title="Valeur des Statistiques",
                color=self.colors['text'],
                gridcolor=self.colors['secondary']
            ),
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text'],
            legend=dict(
                bgcolor='rgba(14, 28, 47, 0.8)',
                bordercolor=self.colors['text'],
                borderwidth=1
            )
        )

        return fig

    def create_champions_comparison_at_level(self, champions: List[Dict], level: int) -> go.Figure:
        """Compare les statistiques de base de champions à un niveau spécifique."""
        if not champions or len(champions) < 2:
            return go.Figure()

        from src.data.champion_data import calculate_champion_stats_at_level

        # Calculer les stats au niveau donné
        champions_at_level = []
        for champion in champions:
            champ_at_level = calculate_champion_stats_at_level(champion, level)
            champions_at_level.append(champ_at_level)

        # Utiliser la fonction existante avec les nouveaux stats
        return self.create_champions_base_stats_comparison(champions_at_level)

    def create_advanced_comparison_chart(self, comparison_results: Dict) -> go.Figure:
        """Crée un graphique radar pour la comparaison avancée champions+items."""
        if not comparison_results or not comparison_results.get('champions'):
            return go.Figure()

        fig = go.Figure()
        colors = ['#C89B3C', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4']

        categories = ['Survie', 'Dégâts', 'Utilité', 'Efficacité Coût']

        for i, champion_data in enumerate(comparison_results['champions']):
            champion_name = champion_data['champion']['name']
            effectiveness = champion_data['effectiveness_scores']

            # Normaliser les scores pour l'affichage radar
            values = [
                min(effectiveness['survival'] / 50, 100),  # Normaliser à 100 max
                min(effectiveness['damage'] / 40, 100),
                min(effectiveness['utility'] / 25, 100),
                min(effectiveness['cost_efficiency'] * 10, 100)
            ]

            color = colors[i % len(colors)]

            fig.add_trace(go.Scatterpolar(
                r=values,
                theta=categories,
                fill='toself',
                name=f"{champion_name} (Niv.{comparison_results['level']})",
                line_color=color,
                fillcolor=f"rgba({self._hex_to_rgb(color)}, 0.2)"
            ))

        fig.update_layout(
            polar=dict(
                radialaxis=dict(
                    visible=True,
                    range=[0, 100],
                    color=self.colors['text'],
                    gridcolor=self.colors['secondary']
                ),
                angularaxis=dict(
                    color=self.colors['text']
                )
            ),
            showlegend=True,
            title=f"Comparaison Avancée Champions + Items (Niveau {comparison_results['level']})",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text']
        )

        return fig

    def create_effectiveness_breakdown_chart(self, champion_data: Dict) -> go.Figure:
        """Crée un graphique en barres pour décomposer l'efficacité d'un champion."""
        if not champion_data or 'effectiveness_scores' not in champion_data:
            return go.Figure()

        effectiveness = champion_data['effectiveness_scores']
        champion_name = champion_data['champion']['name']

        categories = ['Survie', 'Dégâts', 'Utilité']
        values = [
            effectiveness['survival'],
            effectiveness['damage'],
            effectiveness['utility']
        ]
        colors = [self.colors['success'], self.colors['danger'], self.colors['warning']]

        fig = go.Figure(data=[
            go.Bar(
                x=categories,
                y=values,
                marker_color=colors,
                text=[f"{v:.0f}" for v in values],
                textposition='auto',
            )
        ])

        fig.update_layout(
            title=f"Décomposition de l'Efficacité - {champion_name}",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text'],
            xaxis=dict(color=self.colors['text']),
            yaxis=dict(
                color=self.colors['text'],
                title="Score d'Efficacité"
            )
        )

        return fig

    def create_final_stats_comparison(self, comparison_results: Dict) -> go.Figure:
        """Compare les statistiques finales de tous les champions."""
        if not comparison_results or not comparison_results.get('champions'):
            return go.Figure()

        fig = go.Figure()
        colors = ['#C89B3C', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4']

        # Stats importantes à comparer
        important_stats = {
            'hp': 'Points de Vie',
            'attackdamage': 'Dégâts d\'Attaque',
            'magicpower': 'Puissance Magique',
            'armor': 'Armure',
            'spellblock': 'Résistance Magique',
            'attackspeed': 'Vitesse d\'Attaque',
            'movespeed': 'Vitesse de Déplacement'
        }

        # Créer une barre pour chaque champion
        for i, champion_data in enumerate(comparison_results['champions']):
            champion_name = champion_data['champion']['name']
            final_stats = champion_data['final_stats']

            values = []
            stat_names = []

            for stat, display_name in important_stats.items():
                if stat in final_stats:
                    stat_names.append(display_name)
                    values.append(final_stats[stat])

            if values:
                fig.add_trace(go.Bar(
                    x=stat_names,
                    y=values,
                    name=champion_name,
                    marker_color=colors[i % len(colors)],
                    text=[f"{v:.0f}" for v in values],
                    textposition='auto',
                ))

        fig.update_layout(
            title=f"Statistiques Finales (Champion + Items, Niveau {comparison_results['level']})",
            title_font_color=self.colors['primary'],
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text'],
            xaxis=dict(color=self.colors['text']),
            yaxis=dict(color=self.colors['text']),
            barmode='group'
        )

        return fig

    def create_cost_efficiency_chart(self, comparison_results: Dict) -> go.Figure:
        """Crée un graphique scatter coût vs efficacité."""
        if not comparison_results or not comparison_results.get('champions'):
            return go.Figure()

        costs = []
        efficiencies = []
        names = []
        colors_list = []
        colors = ['#C89B3C', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4']

        for i, champion_data in enumerate(comparison_results['champions']):
            champion_name = champion_data['champion']['name']
            total_cost = champion_data['total_cost']
            efficiency = champion_data['effectiveness_scores']['total']

            costs.append(total_cost)
            efficiencies.append(efficiency)
            names.append(champion_name)
            colors_list.append(colors[i % len(colors)])

        fig = go.Figure()

        fig.add_trace(go.Scatter(
            x=costs,
            y=efficiencies,
            mode='markers+text',
            text=names,
            textposition="top center",
            marker=dict(
                size=15,
                color=colors_list,
                line=dict(width=2, color=self.colors['text'])
            ),
            name="Champions"
        ))

        fig.update_layout(
            title=f"Coût vs Efficacité (Niveau {comparison_results['level']})",
            title_font_color=self.colors['primary'],
            xaxis=dict(
                title="Coût Total des Items (Gold)",
                color=self.colors['text'],
                gridcolor=self.colors['secondary']
            ),
            yaxis=dict(
                title="Score d'Efficacité Total",
                color=self.colors['text'],
                gridcolor=self.colors['secondary']
            ),
            paper_bgcolor=self.colors['background'],
            plot_bgcolor=self.colors['background'],
            font_color=self.colors['text']
        )

        return fig