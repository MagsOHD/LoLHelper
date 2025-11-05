"""
Module de visualisations pour les statistiques et analyses LoL.
Crée des graphiques interactifs avec Plotly.
"""

import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
import pandas as pd
from typing import Dict, List

class ChartGenerator:
    """Générateur de graphiques pour les analyses LoL."""

    # Couleurs du thème LoL
    COLORS = {
        'primary': '#0A1428',
        'secondary': '#0E1C2F',
        'accent': '#C89B3C',
        'blue': '#005A82',
        'red': '#C9071F',
        'success': '#00A651',
        'warning': '#FF9900',
        'text': '#F0E6D2'
    }

    def __init__(self):
        # Template de style pour tous les graphiques
        self.template = self._create_custom_template()

    def _create_custom_template(self) -> dict:
        """Crée un template personnalisé pour les graphiques."""
        return {
            'layout': {
                'paper_bgcolor': self.COLORS['primary'],
                'plot_bgcolor': self.COLORS['secondary'],
                'font': {'color': self.COLORS['text'], 'family': 'Arial'},
                'title': {'font': {'size': 20, 'color': self.COLORS['accent']}},
                'xaxis': {
                    'gridcolor': '#1E2328',
                    'linecolor': '#1E2328'
                },
                'yaxis': {
                    'gridcolor': '#1E2328',
                    'linecolor': '#1E2328'
                }
            }
        }

    def create_composition_radar(self, analysis: Dict) -> go.Figure:
        """Crée un radar chart de la composition."""
        scores = analysis['scores']

        categories = [
            'Dégâts Physiques',
            'Dégâts Magiques',
            'Résistance',
            'Contrôle de foule',
            'Mobilité',
            'Sustain',
            'Waveclear',
            'Contrôle objectifs'
        ]

        values = [
            scores['damage_physical'] * 100,
            scores['damage_magic'] * 100,
            scores['tankiness'] * 100,
            scores['crowd_control'] * 100,
            scores['mobility'] * 100,
            scores['sustain'] * 100,
            scores['waveclear'] * 100,
            scores['objective_control'] * 100
        ]

        fig = go.Figure()

        fig.add_trace(go.Scatterpolar(
            r=values,
            theta=categories,
            fill='toself',
            fillcolor=self.COLORS['blue'],
            line=dict(color=self.COLORS['accent'], width=2),
            opacity=0.7,
            name='Composition'
        ))

        fig.update_layout(
            polar=dict(
                bgcolor=self.COLORS['secondary'],
                radialaxis=dict(
                    visible=True,
                    range=[0, 100],
                    gridcolor='#1E2328',
                    tickfont=dict(color=self.COLORS['text'])
                ),
                angularaxis=dict(
                    gridcolor='#1E2328',
                    tickfont=dict(color=self.COLORS['text'])
                )
            ),
            paper_bgcolor=self.COLORS['primary'],
            font=dict(color=self.COLORS['text']),
            title="Analyse de la Composition",
            title_font=dict(size=20, color=self.COLORS['accent']),
            showlegend=False,
            height=500
        )

        return fig

    def create_comparison_radar(self, comp1_analysis: Dict, comp2_analysis: Dict) -> go.Figure:
        """Crée un radar chart comparant deux compositions."""
        categories = [
            'Dégâts Physiques',
            'Dégâts Magiques',
            'Résistance',
            'Contrôle de foule',
            'Mobilité',
            'Sustain',
            'Waveclear',
            'Objectifs'
        ]

        scores1 = comp1_analysis['scores']
        scores2 = comp2_analysis['scores']

        values1 = [
            scores1['damage_physical'] * 100,
            scores1['damage_magic'] * 100,
            scores1['tankiness'] * 100,
            scores1['crowd_control'] * 100,
            scores1['mobility'] * 100,
            scores1['sustain'] * 100,
            scores1['waveclear'] * 100,
            scores1['objective_control'] * 100
        ]

        values2 = [
            scores2['damage_physical'] * 100,
            scores2['damage_magic'] * 100,
            scores2['tankiness'] * 100,
            scores2['crowd_control'] * 100,
            scores2['mobility'] * 100,
            scores2['sustain'] * 100,
            scores2['waveclear'] * 100,
            scores2['objective_control'] * 100
        ]

        fig = go.Figure()

        fig.add_trace(go.Scatterpolar(
            r=values1,
            theta=categories,
            fill='toself',
            fillcolor=self.COLORS['blue'],
            line=dict(color=self.COLORS['blue'], width=2),
            opacity=0.6,
            name='Équipe Bleue'
        ))

        fig.add_trace(go.Scatterpolar(
            r=values2,
            theta=categories,
            fill='toself',
            fillcolor=self.COLORS['red'],
            line=dict(color=self.COLORS['red'], width=2),
            opacity=0.6,
            name='Équipe Rouge'
        ))

        fig.update_layout(
            polar=dict(
                bgcolor=self.COLORS['secondary'],
                radialaxis=dict(
                    visible=True,
                    range=[0, 100],
                    gridcolor='#1E2328',
                    tickfont=dict(color=self.COLORS['text'])
                ),
                angularaxis=dict(
                    gridcolor='#1E2328',
                    tickfont=dict(color=self.COLORS['text'])
                )
            ),
            paper_bgcolor=self.COLORS['primary'],
            font=dict(color=self.COLORS['text']),
            title="Comparaison des Compositions",
            title_font=dict(size=20, color=self.COLORS['accent']),
            showlegend=True,
            legend=dict(
                bgcolor=self.COLORS['secondary'],
                bordercolor=self.COLORS['accent'],
                borderwidth=1
            ),
            height=500
        )

        return fig

    def create_game_phase_chart(self, analysis: Dict) -> go.Figure:
        """Crée un graphique de force par phase de jeu."""
        phases = analysis['game_phases']

        categories = ['Early Game', 'Mid Game', 'Late Game']
        values = [
            phases['early_game'] * 100,
            phases['mid_game'] * 100,
            phases['late_game'] * 100
        ]

        colors = [self.COLORS['warning'] if v == max(values) else self.COLORS['blue'] for v in values]

        fig = go.Figure()

        fig.add_trace(go.Bar(
            x=categories,
            y=values,
            marker=dict(
                color=colors,
                line=dict(color=self.COLORS['accent'], width=2)
            ),
            text=[f"{v:.1f}%" for v in values],
            textposition='outside',
            textfont=dict(color=self.COLORS['text'])
        ))

        fig.update_layout(
            paper_bgcolor=self.COLORS['primary'],
            plot_bgcolor=self.COLORS['secondary'],
            font=dict(color=self.COLORS['text']),
            title="Force par Phase de Jeu",
            title_font=dict(size=20, color=self.COLORS['accent']),
            yaxis=dict(
                title="Puissance (%)",
                range=[0, 110],
                gridcolor='#1E2328',
                titlefont=dict(color=self.COLORS['text'])
            ),
            xaxis=dict(
                titlefont=dict(color=self.COLORS['text'])
            ),
            showlegend=False,
            height=400
        )

        return fig

    def create_damage_distribution(self, analysis: Dict) -> go.Figure:
        """Crée un graphique de distribution des dégâts."""
        damage_balance = analysis['damage_balance']

        labels = ['Dégâts Physiques', 'Dégâts Magiques']
        values = [
            damage_balance['physical_percent'],
            damage_balance['magic_percent']
        ]

        colors = [self.COLORS['red'], self.COLORS['blue']]

        fig = go.Figure(data=[go.Pie(
            labels=labels,
            values=values,
            marker=dict(colors=colors, line=dict(color=self.COLORS['accent'], width=2)),
            textfont=dict(size=14, color=self.COLORS['text']),
            hole=0.4
        )])

        fig.update_layout(
            paper_bgcolor=self.COLORS['primary'],
            font=dict(color=self.COLORS['text']),
            title="Distribution des Types de Dégâts",
            title_font=dict(size=20, color=self.COLORS['accent']),
            showlegend=True,
            legend=dict(
                bgcolor=self.COLORS['secondary'],
                bordercolor=self.COLORS['accent'],
                borderwidth=1
            ),
            height=400,
            annotations=[dict(
                text=damage_balance['balance'],
                x=0.5, y=0.5,
                font_size=20,
                font_color=self.COLORS['accent'],
                showarrow=False
            )]
        )

        return fig

    def create_recommendation_chart(self, recommendations: List[Dict]) -> go.Figure:
        """Crée un graphique des recommandations de picks."""
        if not recommendations:
            return go.Figure()

        # Prendre les top 8 recommandations
        top_recs = recommendations[:8]

        champions = [rec['champion']['name'] for rec in top_recs]
        probabilities = [rec['probability'] for rec in top_recs]

        # Scores détaillés
        meta_scores = [rec['score_breakdown']['meta'] for rec in top_recs]
        synergy_scores = [rec['score_breakdown']['synergy'] for rec in top_recs]
        counter_scores = [rec['score_breakdown']['counter'] for rec in top_recs]
        comp_scores = [rec['score_breakdown']['composition'] for rec in top_recs]

        fig = go.Figure()

        # Barres empilées pour montrer la composition du score
        fig.add_trace(go.Bar(
            name='Meta',
            y=champions,
            x=meta_scores,
            orientation='h',
            marker=dict(color=self.COLORS['blue']),
            text=[f"{s:.1f}" for s in meta_scores],
            textposition='inside'
        ))

        fig.add_trace(go.Bar(
            name='Synergie',
            y=champions,
            x=synergy_scores,
            orientation='h',
            marker=dict(color=self.COLORS['success']),
            text=[f"{s:.1f}" for s in synergy_scores],
            textposition='inside'
        ))

        fig.add_trace(go.Bar(
            name='Counter',
            y=champions,
            x=counter_scores,
            orientation='h',
            marker=dict(color=self.COLORS['warning']),
            text=[f"{s:.1f}" for s in counter_scores],
            textposition='inside'
        ))

        fig.add_trace(go.Bar(
            name='Composition',
            y=champions,
            x=comp_scores,
            orientation='h',
            marker=dict(color=self.COLORS['accent']),
            text=[f"{s:.1f}" for s in comp_scores],
            textposition='inside'
        ))

        fig.update_layout(
            barmode='stack',
            paper_bgcolor=self.COLORS['primary'],
            plot_bgcolor=self.COLORS['secondary'],
            font=dict(color=self.COLORS['text']),
            title="Recommandations de Picks (Score détaillé)",
            title_font=dict(size=20, color=self.COLORS['accent']),
            xaxis=dict(
                title="Score",
                gridcolor='#1E2328',
                titlefont=dict(color=self.COLORS['text'])
            ),
            yaxis=dict(
                titlefont=dict(color=self.COLORS['text'])
            ),
            legend=dict(
                bgcolor=self.COLORS['secondary'],
                bordercolor=self.COLORS['accent'],
                borderwidth=1
            ),
            height=500
        )

        return fig

    def create_win_probability_gauge(self, win_prob: Dict[str, float]) -> go.Figure:
        """Crée une jauge de probabilité de victoire."""
        team1_prob = win_prob['team1']

        fig = go.Figure(go.Indicator(
            mode="gauge+number",
            value=team1_prob,
            domain={'x': [0, 1], 'y': [0, 1]},
            title={'text': "Probabilité de Victoire (Équipe Bleue)", 'font': {'color': self.COLORS['text']}},
            number={'suffix': "%", 'font': {'color': self.COLORS['text']}},
            gauge={
                'axis': {'range': [0, 100], 'tickcolor': self.COLORS['text']},
                'bar': {'color': self.COLORS['blue']},
                'bgcolor': self.COLORS['secondary'],
                'borderwidth': 2,
                'bordercolor': self.COLORS['accent'],
                'steps': [
                    {'range': [0, 30], 'color': self.COLORS['red']},
                    {'range': [30, 45], 'color': '#8B0000'},
                    {'range': [45, 55], 'color': '#4A4A4A'},
                    {'range': [55, 70], 'color': '#004060'},
                    {'range': [70, 100], 'color': self.COLORS['blue']}
                ],
                'threshold': {
                    'line': {'color': self.COLORS['accent'], 'width': 4},
                    'thickness': 0.75,
                    'value': 50
                }
            }
        ))

        fig.update_layout(
            paper_bgcolor=self.COLORS['primary'],
            font={'color': self.COLORS['text']},
            height=300
        )

        return fig

    def create_pro_stats_table(self, df: pd.DataFrame) -> go.Figure:
        """Crée un tableau des statistiques pro."""
        # Trier par winrate
        df_sorted = df.sort_values('Winrate', ascending=False).head(15)

        fig = go.Figure(data=[go.Table(
            header=dict(
                values=list(df_sorted.columns),
                fill_color=self.COLORS['secondary'],
                align='left',
                font=dict(color=self.COLORS['accent'], size=12)
            ),
            cells=dict(
                values=[df_sorted[col] for col in df_sorted.columns],
                fill_color=self.COLORS['primary'],
                align='left',
                font=dict(color=self.COLORS['text'], size=11)
            )
        )])

        fig.update_layout(
            paper_bgcolor=self.COLORS['primary'],
            title="Top Champions - Statistiques Pro",
            title_font=dict(size=20, color=self.COLORS['accent']),
            height=500
        )

        return fig

    def create_pro_stats_bar_chart(self, df: pd.DataFrame, sort_by: str) -> go.Figure:
        """Crée un graphique en barres des statistiques pro."""
        # Trier par la métrique choisie
        df_sorted = df.sort_values(sort_by, ascending=True).tail(15)

        # Définir les couleurs selon la métrique
        color_scale = 'Viridis' if sort_by in ['Winrate', 'Pickrate'] else 'Reds'

        fig = go.Figure(data=[
            go.Bar(
                y=df_sorted['Champion'],
                x=df_sorted[sort_by],
                orientation='h',
                text=df_sorted[sort_by].round(1),
                textposition='auto',
                marker=dict(
                    color=df_sorted[sort_by],
                    colorscale=color_scale,
                    colorbar=dict(title=sort_by)
                )
            )
        ])

        fig.update_layout(
            title=f'Top 15 Champions - {sort_by}',
            title_font=dict(size=20, color=self.COLORS['accent']),
            xaxis=dict(
                title=sort_by,
                gridcolor=self.COLORS['secondary'],
                color=self.COLORS['text']
            ),
            yaxis=dict(
                title='Champions',
                gridcolor=self.COLORS['secondary'],
                color=self.COLORS['text']
            ),
            paper_bgcolor=self.COLORS['primary'],
            plot_bgcolor=self.COLORS['primary'],
            font={'color': self.COLORS['text']},
            height=600
        )

        return fig

    def create_pro_stats_scatter(self, df: pd.DataFrame) -> go.Figure:
        """Crée un scatter plot Pickrate vs Winrate."""
        # Définir la taille des points selon le nombre de picks
        sizes = [max(5, min(30, picks * 3)) for picks in df['Picks']]

        fig = go.Figure(data=[
            go.Scatter(
                x=df['Pickrate'],
                y=df['Winrate'],
                mode='markers+text',
                text=df['Champion'],
                textposition='top center',
                marker=dict(
                    size=sizes,
                    color=df['Banrate'],
                    colorscale='RdYlBu_r',
                    colorbar=dict(title='Banrate %'),
                    line=dict(width=1, color=self.COLORS['accent'])
                ),
                hovertemplate=(
                    '<b>%{text}</b><br>' +
                    'Pickrate: %{x:.1f}%<br>' +
                    'Winrate: %{y:.1f}%<br>' +
                    'Picks: %{marker.size}<br>' +
                    '<extra></extra>'
                )
            )
        ])

        # Ajouter des lignes de référence
        fig.add_hline(y=50, line_dash="dash", line_color=self.COLORS['accent'],
                     annotation_text="Winrate équilibré (50%)")
        fig.add_vline(x=df['Pickrate'].mean(), line_dash="dash", line_color=self.COLORS['secondary'],
                     annotation_text="Pickrate moyen")

        fig.update_layout(
            title='Analyse Pickrate vs Winrate (taille = picks, couleur = banrate)',
            title_font=dict(size=18, color=self.COLORS['accent']),
            xaxis=dict(
                title='Pickrate (%)',
                gridcolor=self.COLORS['secondary'],
                color=self.COLORS['text'],
                range=[-2, df['Pickrate'].max() + 5]
            ),
            yaxis=dict(
                title='Winrate (%)',
                gridcolor=self.COLORS['secondary'],
                color=self.COLORS['text'],
                range=[df['Winrate'].min() - 5, df['Winrate'].max() + 5]
            ),
            paper_bgcolor=self.COLORS['primary'],
            plot_bgcolor=self.COLORS['primary'],
            font={'color': self.COLORS['text']},
            height=600
        )

        return fig
