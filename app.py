"""
LoL Team Composition Helper - Application principale
Application web pour aider à créer des compositions d'équipe optimales pour League of Legends.
"""

import streamlit as st
from src.data.champion_data import ChampionDataManager
from src.data.pro_drafts import ProDraftAnalyzer
from src.analysis.composition_analyzer import CompositionAnalyzer
from src.recommendations.pick_recommender import PickRecommender
from src.visualizations.charts import ChartGenerator

# Configuration de la page
st.set_page_config(
    page_title="LoL Team Composition Helper",
    page_icon="⚔️",
    layout="wide",
    initial_sidebar_state="expanded"
)

# CSS personnalisé pour un style moderne
st.markdown("""
    <style>
    .main {
        background-color: #0A1428;
    }
    .stApp {
        background-color: #0A1428;
    }
    h1, h2, h3 {
        color: #C89B3C;
    }
    .stSelectbox label, .stMultiSelect label {
        color: #F0E6D2;
    }
    .champion-card {
        background-color: #0E1C2F;
        padding: 15px;
        border-radius: 10px;
        border: 2px solid #C89B3C;
        margin: 10px 0;
    }
    .metric-card {
        background-color: #0E1C2F;
        padding: 10px;
        border-radius: 5px;
        border-left: 4px solid #C89B3C;
    }
    </style>
""", unsafe_allow_html=True)

# Initialisation des gestionnaires (avec cache)
@st.cache_resource
def init_managers():
    """Initialise tous les gestionnaires de données."""
    champion_manager = ChampionDataManager()
    champion_manager.load_champions()

    pro_draft_analyzer = ProDraftAnalyzer()
    composition_analyzer = CompositionAnalyzer()

    recommender = PickRecommender(
        champion_manager,
        pro_draft_analyzer,
        composition_analyzer
    )

    chart_generator = ChartGenerator()

    return champion_manager, pro_draft_analyzer, composition_analyzer, recommender, chart_generator

# Chargement des gestionnaires
with st.spinner("Chargement des données des champions..."):
    champion_manager, pro_draft_analyzer, composition_analyzer, recommender, chart_generator = init_managers()

# Initialisation de la session
if 'blue_team' not in st.session_state:
    st.session_state.blue_team = []
if 'red_team' not in st.session_state:
    st.session_state.red_team = []
if 'bans' not in st.session_state:
    st.session_state.bans = []

# En-tête
st.title("⚔️ LoL Team Composition Helper")
st.markdown("### Créez des compositions optimales basées sur les données et l'analyse stratégique")

# Sidebar pour la navigation
st.sidebar.title("Navigation")
page = st.sidebar.radio(
    "Choisir une section",
    ["🎯 Draft Assistant", "📊 Analyse de Composition", "📈 Statistiques Pro", "ℹ️ À propos"]
)

# Page 1: Draft Assistant
if page == "🎯 Draft Assistant":
    st.header("Assistant de Draft")

    col1, col2 = st.columns(2)

    with col1:
        st.subheader("🔵 Équipe Bleue")

        # Lanes pour l'équipe bleue
        lanes = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']

        for i, lane in enumerate(lanes):
            if len(st.session_state.blue_team) > i:
                champ = champion_manager.get_champion_by_id(st.session_state.blue_team[i])
                if champ:
                    st.markdown(f"**{lane}**: {champ['name']}")
            else:
                st.markdown(f"**{lane}**: *Vide*")

        # Ajouter un champion
        if len(st.session_state.blue_team) < 5:
            current_lane = lanes[len(st.session_state.blue_team)]
            st.markdown(f"### Sélectionner pour {current_lane}")

            # Obtenir les recommandations
            if st.button("🔍 Obtenir des recommandations", key="blue_recs"):
                with st.spinner("Calcul des recommandations..."):
                    recs = recommender.recommend_picks(
                        st.session_state.blue_team,
                        st.session_state.red_team,
                        st.session_state.bans,
                        current_lane,
                        top_n=5
                    )

                    st.markdown("#### Top 5 Recommandations:")
                    for idx, rec in enumerate(recs, 1):
                        champ = rec['champion']
                        prob = rec['probability']

                        with st.expander(f"{idx}. {champ['name']} - {prob}% de probabilité"):
                            st.write(f"**Rôle**: {', '.join(champ['tags'])}")
                            st.write(f"**Score Meta**: {rec['score_breakdown']['meta']:.1f}")
                            st.write(f"**Synergie**: {rec['score_breakdown']['synergy']:.1f}")
                            st.write(f"**Counter**: {rec['score_breakdown']['counter']:.1f}")
                            st.write(f"**Composition**: {rec['score_breakdown']['composition']:.1f}")

                            if st.button(f"Choisir {champ['name']}", key=f"pick_blue_{champ['id']}"):
                                st.session_state.blue_team.append(champ['id'])
                                st.rerun()

            # Sélection manuelle
            all_champions = sorted(champion_manager.champion_list)
            selected = st.selectbox(
                "Ou choisir manuellement:",
                [""] + all_champions,
                key="blue_manual"
            )

            if selected and st.button("Ajouter à l'équipe bleue"):
                if selected not in st.session_state.blue_team:
                    st.session_state.blue_team.append(selected)
                    st.rerun()

        # Bouton pour réinitialiser
        if st.session_state.blue_team:
            if st.button("🔄 Réinitialiser équipe bleue"):
                st.session_state.blue_team = []
                st.rerun()

    with col2:
        st.subheader("🔴 Équipe Rouge")

        for i, lane in enumerate(lanes):
            if len(st.session_state.red_team) > i:
                champ = champion_manager.get_champion_by_id(st.session_state.red_team[i])
                if champ:
                    st.markdown(f"**{lane}**: {champ['name']}")
            else:
                st.markdown(f"**{lane}**: *Vide*")

        # Ajouter un champion
        if len(st.session_state.red_team) < 5:
            current_lane = lanes[len(st.session_state.red_team)]

            # Sélection manuelle pour l'équipe rouge
            all_champions = sorted(champion_manager.champion_list)
            selected = st.selectbox(
                f"Choisir pour {current_lane}:",
                [""] + all_champions,
                key="red_manual"
            )

            if selected and st.button("Ajouter à l'équipe rouge"):
                if selected not in st.session_state.red_team:
                    st.session_state.red_team.append(selected)
                    st.rerun()

        # Bouton pour réinitialiser
        if st.session_state.red_team:
            if st.button("🔄 Réinitialiser équipe rouge"):
                st.session_state.red_team = []
                st.rerun()

    # Bans
    st.markdown("---")
    st.subheader("🚫 Champions Bannis")

    col_ban1, col_ban2 = st.columns(2)

    with col_ban1:
        if st.button("💡 Suggérer des bans"):
            with st.spinner("Analyse des champions à bannir..."):
                ban_suggestions = recommender.suggest_bans(
                    st.session_state.red_team,
                    st.session_state.blue_team,
                    st.session_state.bans,
                    top_n=5
                )

                st.markdown("#### Suggestions de bans:")
                for idx, suggestion in enumerate(ban_suggestions, 1):
                    champ = suggestion['champion']
                    reasons = suggestion['reasons']

                    st.markdown(f"**{idx}. {champ['name']}**")
                    st.write(f"- Force meta: {reasons['meta_strength']:.1f}")
                    st.write(f"- Taux de ban: {reasons['popular_ban']:.1f}%")
                    st.write(f"- Menace synergie: {reasons['synergy_threat']:.1f}")

    with col_ban2:
        # Afficher les bans actuels
        if st.session_state.bans:
            st.markdown("**Bannis:**")
            for ban in st.session_state.bans:
                champ = champion_manager.get_champion_by_id(ban)
                if champ:
                    st.write(f"- {champ['name']}")

        # Ajouter un ban
        all_champions = sorted(champion_manager.champion_list)
        ban_select = st.selectbox("Bannir un champion:", [""] + all_champions, key="ban_select")

        if ban_select and st.button("Bannir"):
            if ban_select not in st.session_state.bans:
                st.session_state.bans.append(ban_select)
                st.rerun()

        if st.session_state.bans and st.button("Effacer les bans"):
            st.session_state.bans = []
            st.rerun()

# Page 2: Analyse de Composition
elif page == "📊 Analyse de Composition":
    st.header("Analyse de Composition")

    # Choisir quelle équipe analyser
    team_choice = st.radio("Analyser:", ["Équipe Bleue", "Équipe Rouge", "Comparer les deux"])

    if team_choice == "Équipe Bleue":
        if len(st.session_state.blue_team) == 5:
            champions = [champion_manager.get_champion_by_id(c) for c in st.session_state.blue_team]

            if all(champions):
                analysis = composition_analyzer.analyze_composition(champions)

                # Afficher le score global
                col1, col2, col3 = st.columns(3)
                with col1:
                    st.metric("Score Global", f"{analysis['overall_score']}/100")
                with col2:
                    st.metric("Grade", analysis['grade'])
                with col3:
                    power_spike = analysis['game_phases']['power_spike']
                    st.metric("Power Spike", power_spike.upper())

                # Graphiques
                st.plotly_chart(chart_generator.create_composition_radar(analysis), use_container_width=True)

                col_a, col_b = st.columns(2)
                with col_a:
                    st.plotly_chart(chart_generator.create_damage_distribution(analysis), use_container_width=True)
                with col_b:
                    st.plotly_chart(chart_generator.create_game_phase_chart(analysis), use_container_width=True)

                # Forces et faiblesses
                col_f, col_w = st.columns(2)
                with col_f:
                    st.markdown("### ✅ Forces")
                    for strength in analysis['strengths']:
                        st.success(strength.replace('_', ' ').title())

                with col_w:
                    st.markdown("### ⚠️ Faiblesses")
                    for weakness in analysis['weaknesses']:
                        st.warning(weakness.replace('_', ' ').title())
        else:
            st.info("L'équipe bleue doit avoir 5 champions pour être analysée.")

    elif team_choice == "Équipe Rouge":
        if len(st.session_state.red_team) == 5:
            champions = [champion_manager.get_champion_by_id(c) for c in st.session_state.red_team]

            if all(champions):
                analysis = composition_analyzer.analyze_composition(champions)

                # Même affichage que pour l'équipe bleue
                col1, col2, col3 = st.columns(3)
                with col1:
                    st.metric("Score Global", f"{analysis['overall_score']}/100")
                with col2:
                    st.metric("Grade", analysis['grade'])
                with col3:
                    power_spike = analysis['game_phases']['power_spike']
                    st.metric("Power Spike", power_spike.upper())

                st.plotly_chart(chart_generator.create_composition_radar(analysis), use_container_width=True)

                col_a, col_b = st.columns(2)
                with col_a:
                    st.plotly_chart(chart_generator.create_damage_distribution(analysis), use_container_width=True)
                with col_b:
                    st.plotly_chart(chart_generator.create_game_phase_chart(analysis), use_container_width=True)
        else:
            st.info("L'équipe rouge doit avoir 5 champions pour être analysée.")

    else:  # Comparer les deux
        if len(st.session_state.blue_team) == 5 and len(st.session_state.red_team) == 5:
            blue_champions = [champion_manager.get_champion_by_id(c) for c in st.session_state.blue_team]
            red_champions = [champion_manager.get_champion_by_id(c) for c in st.session_state.red_team]

            if all(blue_champions) and all(red_champions):
                comparison = composition_analyzer.compare_compositions(blue_champions, red_champions)

                # Probabilité de victoire
                st.plotly_chart(
                    chart_generator.create_win_probability_gauge(comparison['win_probability']),
                    use_container_width=True
                )

                # Comparaison radar
                st.plotly_chart(
                    chart_generator.create_comparison_radar(
                        comparison['team1_analysis'],
                        comparison['team2_analysis']
                    ),
                    use_container_width=True
                )

                # Vainqueur prédit
                winner = "🔵 Équipe Bleue" if comparison['predicted_winner'] == 'team1' else "🔴 Équipe Rouge"
                st.success(f"**Vainqueur prédit:** {winner}")

                # Tableau de comparaison
                st.markdown("### Comparaison détaillée")
                comp_data = []
                for aspect, values in comparison['comparison'].items():
                    comp_data.append({
                        'Aspect': aspect.replace('_', ' ').title(),
                        'Équipe Bleue': f"{values['team1']*100:.1f}%",
                        'Équipe Rouge': f"{values['team2']*100:.1f}%",
                        'Avantage': values['advantage']
                    })

                import pandas as pd
                df = pd.DataFrame(comp_data)
                st.dataframe(df, use_container_width=True)
        else:
            st.info("Les deux équipes doivent avoir 5 champions pour être comparées.")

# Page 3: Statistiques Pro
elif page == "📈 Statistiques Pro":
    st.header("Statistiques des Drafts Professionnels")

    # Obtenir le DataFrame des stats
    df = pro_draft_analyzer.get_stats_dataframe()

    if not df.empty:
        # Filtres
        col1, col2 = st.columns(2)
        with col1:
            min_picks = st.slider("Picks minimum", 0, int(df['Picks'].max()), 0)
        with col2:
            sort_by = st.selectbox("Trier par", ['Winrate', 'Pickrate', 'Banrate', 'Picks'])

        # Filtrer et trier
        df_filtered = df[df['Picks'] >= min_picks].sort_values(sort_by, ascending=False)

        # Afficher le tableau
        st.plotly_chart(chart_generator.create_pro_stats_table(df_filtered), use_container_width=True)

        # Top champions par catégorie
        col_a, col_b, col_c = st.columns(3)

        with col_a:
            st.markdown("### 🏆 Top Winrate")
            top_wr = df_filtered.nlargest(5, 'Winrate')[['Champion', 'Winrate']]
            for _, row in top_wr.iterrows():
                st.write(f"**{row['Champion']}**: {row['Winrate']:.1f}%")

        with col_b:
            st.markdown("### 🎯 Top Pickrate")
            top_pr = df_filtered.nlargest(5, 'Pickrate')[['Champion', 'Pickrate']]
            for _, row in top_pr.iterrows():
                st.write(f"**{row['Champion']}**: {row['Pickrate']:.1f}%")

        with col_c:
            st.markdown("### 🚫 Top Banrate")
            top_br = df_filtered.nlargest(5, 'Banrate')[['Champion', 'Banrate']]
            for _, row in top_br.iterrows():
                st.write(f"**{row['Champion']}**: {row['Banrate']:.1f}%")
    else:
        st.info("Aucune donnée de draft disponible. Ajoutez des drafts dans data/pro_drafts.json")

# Page 4: À propos
else:
    st.header("À propos")

    st.markdown("""
    ## LoL Team Composition Helper

    ### 🎯 Objectif
    Cet outil aide les équipes League of Legends à créer des compositions optimales en se basant sur:
    - Les statistiques des champions
    - Les drafts professionnels existants
    - L'analyse des synergies et counters
    - Les probabilités de victoire

    ### 📊 Fonctionnalités

    **Draft Assistant**
    - Recommandations intelligentes de picks
    - Suggestions de bans stratégiques
    - Calcul des probabilités basé sur le meta

    **Analyse de Composition**
    - Évaluation des forces et faiblesses
    - Graphiques radar interactifs
    - Analyse par phase de jeu
    - Comparaison d'équipes

    **Statistiques Pro**
    - Données basées sur les drafts professionnels
    - Winrates, pickrates, banrates
    - Tendances du meta

    ### 🛠️ Technologies
    - **Python** pour le backend
    - **Streamlit** pour l'interface web
    - **Plotly** pour les visualisations
    - **Riot Games Data Dragon** pour les données champions

    ### 📝 Comment utiliser

    1. **Draft Assistant**: Construisez vos compositions champion par champion avec des recommandations intelligentes
    2. **Analyse**: Évaluez vos compositions et comparez-les avec l'adversaire
    3. **Stats Pro**: Consultez les tendances du meta professionnel

    ### 🔄 Mise à jour des données
    Les données des champions sont automatiquement mises en cache et se mettent à jour toutes les 24h.

    ---

    Créé avec ❤️ pour la communauté League of Legends
    """)

# Footer
st.sidebar.markdown("---")
st.sidebar.markdown("### Statistiques de session")
st.sidebar.write(f"Champions chargés: {len(champion_manager.champions)}")
st.sidebar.write(f"Drafts analysés: {len(pro_draft_analyzer.drafts)}")
st.sidebar.write(f"Version du jeu: {champion_manager.version}")
