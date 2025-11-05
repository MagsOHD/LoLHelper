"""
LoL Team Composition Helper - Application principale
Application web pour aider à créer des compositions d'équipe optimales pour League of Legends.
"""

import streamlit as st
from src.data.champion_data import ChampionDataManager
from src.data.item_data import ItemDataManager
from src.data.pro_drafts import ProDraftAnalyzer
from src.data.data_sources import DataSourcesManager, get_data_attribution_text, get_privacy_and_usage_info
from src.analysis.composition_analyzer import CompositionAnalyzer
from src.analysis.champion_item_analyzer import ChampionItemAnalyzer
from src.analysis.advanced_comparison import AdvancedChampionComparator
from src.recommendations.pick_recommender import PickRecommender
from src.visualizations.charts import ChartGenerator
from src.visualizations.stats_viewer import StatsViewer
from src.data.preset_compositions import get_preset_names, get_preset_composition

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

    item_manager = ItemDataManager()
    item_manager.load_items()

    pro_draft_analyzer = ProDraftAnalyzer()
    composition_analyzer = CompositionAnalyzer()
    champion_item_analyzer = ChampionItemAnalyzer(champion_manager, item_manager)
    advanced_comparator = AdvancedChampionComparator(champion_manager, item_manager, champion_item_analyzer)
    data_sources_manager = DataSourcesManager()

    recommender = PickRecommender(
        champion_manager,
        pro_draft_analyzer,
        composition_analyzer
    )

    chart_generator = ChartGenerator()
    stats_viewer = StatsViewer()

    return champion_manager, item_manager, pro_draft_analyzer, composition_analyzer, champion_item_analyzer, advanced_comparator, data_sources_manager, recommender, chart_generator, stats_viewer

# Chargement des gestionnaires
with st.spinner("Chargement des données des champions et items..."):
    champion_manager, item_manager, pro_draft_analyzer, composition_analyzer, champion_item_analyzer, advanced_comparator, data_sources_manager, recommender, chart_generator, stats_viewer = init_managers()

# Initialisation de la session
if 'blue_team' not in st.session_state:
    st.session_state.blue_team = []
if 'red_team' not in st.session_state:
    st.session_state.red_team = []
if 'bans' not in st.session_state:
    st.session_state.bans = []
if 'blue_recommendations' not in st.session_state:
    st.session_state.blue_recommendations = []
if 'red_recommendations' not in st.session_state:
    st.session_state.red_recommendations = []
if 'edit_mode_blue' not in st.session_state:
    st.session_state.edit_mode_blue = False
if 'edit_mode_red' not in st.session_state:
    st.session_state.edit_mode_red = False

# En-tête
st.title("⚔️ LoL Team Composition Helper")
st.markdown("### Créez des compositions optimales basées sur les données et l'analyse stratégique")

# Sidebar pour la navigation
st.sidebar.title("⚔️ LoL Team Composition Helper")
st.sidebar.markdown("*Outil d'aide à la création de compositions d'équipe optimales pour League of Legends.*")

# Statut de connexion et version
st.sidebar.markdown("---")
col1, col2 = st.sidebar.columns(2)
with col1:
    st.markdown("🟢 **Connecté**")
with col2:
    st.markdown(f"**v{champion_manager.version}**")

# Navigation avec descriptions
st.sidebar.markdown("---")
st.sidebar.markdown("### 🧭 Navigation")

page = st.sidebar.radio(
    "Choisir une section:",
    ["🎯 Draft Assistant", "📊 Analyse de Composition", "📈 Statistiques Pro", "🛡️ Stats Champions & Items", "ℹ️ À propos"],
    key="main_navigation"
)

# Aide contextuelle
help_texts = {
    "🎯 Draft Assistant": "Construisez votre équipe champion par champion avec des recommandations intelligentes",
    "📊 Analyse de Composition": "Analysez et comparez des équipes complètes avec métriques détaillées",
    "📈 Statistiques Pro": "Consultez les tendances du meta professionnel avec graphiques interactifs",
    "🛡️ Stats Champions & Items": "Explorez les statistiques des champions, items et builds optimaux",
    "ℹ️ À propos": "Informations sur l'application, sources de données et fonctionnalités"
}

if page in help_texts:
    st.sidebar.info(f"💡 {help_texts[page]}")

# Page 1: Draft Assistant
if page == "🎯 Draft Assistant":
    st.header("Assistant de Draft")

    # Section des compositions prédéfinies
    with st.expander("📋 Compositions Prédéfinies", expanded=False):
        st.markdown("### Charger une composition prédéfinie")
        st.markdown("*Utilisez des compositions optimales pour différentes stratégies*")

        col_preset1, col_preset2, col_preset3 = st.columns([3, 1, 1])

        with col_preset1:
            preset_names = [""] + get_preset_names()
            selected_preset = st.selectbox(
                "Choisir une composition:",
                preset_names,
                key="preset_selector"
            )

        with col_preset2:
            if selected_preset and st.button("📥 Charger",  key="load_preset", use_container_width=True):
                preset = get_preset_composition(selected_preset)
                if preset:
                    st.session_state.blue_team = preset['blue_team'].copy()
                    st.session_state.blue_recommendations = []
                    st.session_state.edit_mode_blue = False
                    st.success(f"✅ '{selected_preset}' chargée!")
                    st.rerun()

        with col_preset3:
            if selected_preset:
                preset = get_preset_composition(selected_preset)
                if preset:
                    if st.button("ℹ️ Info", key="preset_info", use_container_width=True):
                        pass  # Le contenu s'affiche en dessous

        # Afficher les informations de la composition sélectionnée
        if selected_preset:
            preset = get_preset_composition(selected_preset)
            if preset:
                st.markdown(f"**📝 Description:** {preset['description']}")
                st.markdown(f"**⚔️ Stratégie:** {preset['strategy']}")
                with st.expander("👥 Champions de cette composition"):
                    for i, champ_id in enumerate(preset['blue_team']):
                        lane = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'][i]
                        st.write(f"• **{lane}**: {champ_id}")

    st.markdown("---")

    col1, col2 = st.columns(2)

    with col1:
        st.subheader("🔵 Équipe Bleue")

        # Lanes pour l'équipe bleue
        lanes = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']

        # Boutons d'action si l'équipe a des champions
        if st.session_state.blue_team:
            col_btn1, col_btn2 = st.columns(2)
            with col_btn1:
                if st.button("✏️ " + ("Terminer" if st.session_state.edit_mode_blue else "Modifier"), key="toggle_edit_blue", use_container_width=True):
                    st.session_state.edit_mode_blue = not st.session_state.edit_mode_blue
                    st.rerun()
            with col_btn2:
                if st.button("🔄 Réinitialiser", key="reset_blue_btn", use_container_width=True):
                    st.session_state.blue_team = []
                    st.session_state.blue_recommendations = []
                    st.session_state.edit_mode_blue = False
                    st.rerun()
            st.markdown("---")

        # Mode édition ou affichage normal
        if st.session_state.edit_mode_blue and st.session_state.blue_team:
            st.markdown("**✏️ Mode Édition - Modifiez les champions par lane:**")
            for i, lane in enumerate(lanes):
                if len(st.session_state.blue_team) > i:
                    champ = champion_manager.get_champion_by_id(st.session_state.blue_team[i])
                    if champ:
                        # Obtenir la liste des noms de champions
                        all_champ_names = sorted([c['name'] for c in champion_manager.champions.values()])
                        current_idx = all_champ_names.index(champ['name']) if champ['name'] in all_champ_names else 0

                        new_champ_name = st.selectbox(
                            f"**{lane}:**",
                            all_champ_names,
                            index=current_idx,
                            key=f"edit_blue_{lane}_{i}"
                        )

                        # Si changement, trouver l'ID et mettre à jour
                        if new_champ_name != champ['name']:
                            for champ_id, c in champion_manager.champions.items():
                                if c['name'] == new_champ_name:
                                    st.session_state.blue_team[i] = champ_id
                                    st.rerun()
                                    break
        else:
            # Affichage normal
            for i, lane in enumerate(lanes):
                if len(st.session_state.blue_team) > i:
                    champ = champion_manager.get_champion_by_id(st.session_state.blue_team[i])
                    if champ:
                        st.markdown(f"**{lane}**: {champ['name']}")
                else:
                    st.markdown(f"**{lane}**: *Vide*")

        st.markdown("---")

        # Ajouter un champion (seulement si pas en mode édition)
        if not st.session_state.edit_mode_blue and len(st.session_state.blue_team) < 5:
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
                    # Stocker les recommandations pour qu'elles persistent entre les reruns
                    st.session_state.blue_recommendations = recs if recs else []
                    st.rerun()

            # Afficher les recommandations stockées (en dehors du if button pour qu'elles persistent)
            if st.session_state.blue_recommendations:
                recs = st.session_state.blue_recommendations
                st.markdown("#### 🎯 Top 5 Recommandations:")

                # Afficher un aperçu en colonnes
                rec_cols = st.columns(5)
                for idx, rec in enumerate(recs):
                    champ = rec['champion']
                    prob = rec['probability']

                    with rec_cols[idx]:
                        st.markdown(f"""
                        <div style="border: 2px solid #C89B3C; border-radius: 10px; padding: 10px; text-align: center; margin: 5px;">
                            <h4>{idx+1}. {champ['name']}</h4>
                            <p><strong>{prob:.1f}%</strong> de succès</p>
                            <p><small>{', '.join(champ['tags'][:2])}</small></p>
                        </div>
                        """, unsafe_allow_html=True)

                        if st.button(f"Choisir", key=f"quick_pick_blue_{champ['id']}_{idx}"):
                            st.session_state.blue_team.append(champ['id'])
                            st.session_state.blue_recommendations = []
                            st.rerun()

                st.markdown("---")

                # Détails complets
                for idx, rec in enumerate(recs, 1):
                    champ = rec['champion']
                    prob = rec['probability']

                    with st.expander(f"📋 Détails - {champ['name']} ({prob:.1f}%)"):
                        detail_col1, detail_col2 = st.columns(2)

                        with detail_col1:
                            st.markdown("**🏷️ Informations**")
                            st.write(f"• **Rôles**: {', '.join(champ['tags'])}")
                            st.write(f"• **Probabilité**: {prob:.1f}%")

                            st.markdown("**📊 Scores Détaillés**")
                            st.write(f"• **Meta**: {rec['score_breakdown']['meta']:.1f}/25")
                            st.write(f"• **Synergie**: {rec['score_breakdown']['synergy']:.1f}/20")
                            st.write(f"• **Counter**: {rec['score_breakdown']['counter']:.1f}/25")
                            st.write(f"• **Composition**: {rec['score_breakdown']['composition']:.1f}/20")
                            st.write(f"• **Lane Fit**: {rec['score_breakdown']['lane_fit']:.1f}/10")

                        with detail_col2:
                            # Graphique de scores
                            scores = rec['score_breakdown']
                            score_names = list(scores.keys())
                            score_values = [scores[name] for name in score_names]

                            import plotly.express as px
                            import pandas as pd

                            df = pd.DataFrame({
                                'Critère': score_names,
                                'Score': score_values
                            })

                            fig = px.bar(df, x='Critère', y='Score',
                                       title=f"Scores pour {champ['name']}")
                            fig.update_layout(height=300)
                            st.plotly_chart(fig, use_container_width=True)

                        if st.button(f"✅ Sélectionner {champ['name']}", key=f"pick_blue_detailed_{champ['id']}_{idx}"):
                            st.session_state.blue_team.append(champ['id'])
                            st.session_state.blue_recommendations = []
                            st.rerun()
            elif st.session_state.get('blue_recommendations') is not None and len(st.session_state.blue_recommendations) == 0 and st.session_state.get('_just_calculated_recs'):
                st.warning("❌ Aucune recommandation disponible pour cette lane")
                st.info("💡 Cela peut arriver si tous les champions appropriés sont bannis ou déjà sélectionnés")

            # Sélection manuelle
            all_champions = sorted(champion_manager.champion_list)
            selected = st.selectbox(
                "Ou choisir manuellement:",
                [""] + all_champions,
                key="blue_manual"
            )

            if selected and st.button("Ajouter à l'équipe bleue"):
                # Trouver l'ID du champion sélectionné
                champion_id = None
                for champ_id, champ in champion_manager.champions.items():
                    if champ['name'] == selected:
                        champion_id = champ_id
                        break

                if champion_id and champion_id not in st.session_state.blue_team:
                    st.session_state.blue_team.append(champion_id)
                    st.rerun()

    with col2:
        st.subheader("🔴 Équipe Rouge")

        # Boutons d'action si l'équipe a des champions
        if st.session_state.red_team:
            col_btn1, col_btn2 = st.columns(2)
            with col_btn1:
                if st.button("✏️ " + ("Terminer" if st.session_state.edit_mode_red else "Modifier"), key="toggle_edit_red", use_container_width=True):
                    st.session_state.edit_mode_red = not st.session_state.edit_mode_red
                    st.rerun()
            with col_btn2:
                if st.button("🔄 Réinitialiser", key="reset_red_btn", use_container_width=True):
                    st.session_state.red_team = []
                    st.session_state.red_recommendations = []
                    st.session_state.edit_mode_red = False
                    st.rerun()
            st.markdown("---")

        # Mode édition ou affichage normal
        if st.session_state.edit_mode_red and st.session_state.red_team:
            st.markdown("**✏️ Mode Édition - Modifiez les champions par lane:**")
            for i, lane in enumerate(lanes):
                if len(st.session_state.red_team) > i:
                    champ = champion_manager.get_champion_by_id(st.session_state.red_team[i])
                    if champ:
                        # Obtenir la liste des noms de champions
                        all_champ_names = sorted([c['name'] for c in champion_manager.champions.values()])
                        current_idx = all_champ_names.index(champ['name']) if champ['name'] in all_champ_names else 0

                        new_champ_name = st.selectbox(
                            f"**{lane}:**",
                            all_champ_names,
                            index=current_idx,
                            key=f"edit_red_{lane}_{i}"
                        )

                        # Si changement, trouver l'ID et mettre à jour
                        if new_champ_name != champ['name']:
                            for champ_id, c in champion_manager.champions.items():
                                if c['name'] == new_champ_name:
                                    st.session_state.red_team[i] = champ_id
                                    st.rerun()
                                    break
        else:
            # Affichage normal
            for i, lane in enumerate(lanes):
                if len(st.session_state.red_team) > i:
                    champ = champion_manager.get_champion_by_id(st.session_state.red_team[i])
                    if champ:
                        st.markdown(f"**{lane}**: {champ['name']}")
                else:
                    st.markdown(f"**{lane}**: *Vide*")

        st.markdown("---")

        # Ajouter un champion (seulement si pas en mode édition)
        if not st.session_state.edit_mode_red and len(st.session_state.red_team) < 5:
            current_lane = lanes[len(st.session_state.red_team)]
            st.markdown(f"### Sélectionner pour {current_lane}")

            # Obtenir les recommandations pour l'équipe rouge
            if st.button("🔍 Obtenir des recommandations", key="red_recs"):
                with st.spinner("Calcul des recommandations..."):
                    recs = recommender.recommend_picks(
                        st.session_state.red_team,
                        st.session_state.blue_team,
                        st.session_state.bans,
                        current_lane,
                        top_n=5
                    )
                    # Stocker les recommandations pour qu'elles persistent entre les reruns
                    st.session_state.red_recommendations = recs if recs else []
                    st.rerun()

            # Afficher les recommandations stockées (en dehors du if button pour qu'elles persistent)
            if st.session_state.red_recommendations:
                recs = st.session_state.red_recommendations
                st.markdown("#### 🎯 Top 5 Recommandations:")

                # Afficher un aperçu en colonnes
                rec_cols = st.columns(5)
                for idx, rec in enumerate(recs):
                    champ = rec['champion']
                    prob = rec['probability']

                    with rec_cols[idx]:
                        st.markdown(f"""
                        <div style="border: 2px solid #C89B3C; border-radius: 10px; padding: 10px; text-align: center; margin: 5px;">
                            <h4>{idx+1}. {champ['name']}</h4>
                            <p><strong>{prob:.1f}%</strong> de succès</p>
                            <p><small>{', '.join(champ['tags'][:2])}</small></p>
                        </div>
                        """, unsafe_allow_html=True)

                        if st.button(f"Choisir", key=f"quick_pick_red_{champ['id']}_{idx}"):
                            st.session_state.red_team.append(champ['id'])
                            st.session_state.red_recommendations = []
                            st.rerun()

                st.markdown("---")

                # Détails complets
                for idx, rec in enumerate(recs, 1):
                    champ = rec['champion']
                    prob = rec['probability']

                    with st.expander(f"📋 Détails - {champ['name']} ({prob:.1f}%)"):
                        detail_col1, detail_col2 = st.columns(2)

                        with detail_col1:
                            st.markdown("**🏷️ Informations**")
                            st.write(f"• **Rôles**: {', '.join(champ['tags'])}")
                            st.write(f"• **Probabilité**: {prob:.1f}%")

                            st.markdown("**📊 Scores Détaillés**")
                            st.write(f"• **Meta**: {rec['score_breakdown']['meta']:.1f}/25")
                            st.write(f"• **Synergie**: {rec['score_breakdown']['synergy']:.1f}/20")
                            st.write(f"• **Counter**: {rec['score_breakdown']['counter']:.1f}/25")
                            st.write(f"• **Composition**: {rec['score_breakdown']['composition']:.1f}/20")
                            st.write(f"• **Lane Fit**: {rec['score_breakdown']['lane_fit']:.1f}/10")

                        with detail_col2:
                            # Graphique de scores
                            scores = rec['score_breakdown']
                            score_names = list(scores.keys())
                            score_values = [scores[name] for name in score_names]

                            import plotly.express as px
                            import pandas as pd

                            df = pd.DataFrame({
                                'Critère': score_names,
                                'Score': score_values
                            })

                            fig = px.bar(df, x='Critère', y='Score',
                                       title=f"Scores pour {champ['name']}")
                            fig.update_layout(height=300)
                            st.plotly_chart(fig, use_container_width=True)

                        if st.button(f"✅ Sélectionner {champ['name']}", key=f"pick_red_detailed_{champ['id']}_{idx}"):
                            st.session_state.red_team.append(champ['id'])
                            st.session_state.red_recommendations = []
                            st.rerun()
            elif st.session_state.get('red_recommendations') is not None and len(st.session_state.red_recommendations) == 0 and st.session_state.get('_just_calculated_recs'):
                st.warning("❌ Aucune recommandation disponible pour cette lane")
                st.info("💡 Cela peut arriver si tous les champions appropriés sont bannis ou déjà sélectionnés")

            # Sélection manuelle pour l'équipe rouge
            all_champions = sorted(champion_manager.champion_list)
            selected = st.selectbox(
                "Ou choisir manuellement:",
                [""] + all_champions,
                key="red_manual"
            )

            if selected and st.button("Ajouter à l'équipe rouge"):
                # Trouver l'ID du champion sélectionné
                champion_id = None
                for champ_id, champ in champion_manager.champions.items():
                    if champ['name'] == selected:
                        champion_id = champ_id
                        break

                if champion_id and champion_id not in st.session_state.red_team:
                    st.session_state.red_team.append(champion_id)
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

                    with st.expander(f"{idx}. {champ['name']} - Recommandé"):
                        st.write(f"- Force meta: {reasons['meta_strength']:.1f}")
                        st.write(f"- Taux de ban: {reasons['popular_ban']:.1f}%")
                        st.write(f"- Menace synergie: {reasons['synergy_threat']:.1f}")

                        if st.button(f"Bannir {champ['name']}", key=f"ban_{champ['id']}_{idx}"):
                            if champ['id'] not in st.session_state.bans:
                                st.session_state.bans.append(champ['id'])
                                st.rerun()

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
            # Trouver l'ID du champion sélectionné
            champion_id = None
            for champ_id, champ in champion_manager.champions.items():
                if champ['name'] == ban_select:
                    champion_id = champ_id
                    break

            if champion_id and champion_id not in st.session_state.bans:
                st.session_state.bans.append(champion_id)
                st.rerun()

        if st.session_state.bans and st.button("Effacer les bans"):
            st.session_state.bans = []
            st.rerun()

    # Section d'analyse et d'explications
    st.markdown("---")
    st.markdown("## 📋 Analyse et Explications")

    # Créer des onglets pour les différentes analyses
    tab1, tab2, tab3 = st.tabs([
        "🔍 Vérifier Composition Pro",
        "📖 Explication Détaillée",
        "📊 Winrate et Conseils"
    ])

    with tab1:
        st.markdown("### 🔍 Recherche de Compositions Pro Similaires")

        team_to_check = st.radio(
            "Équipe à vérifier:",
            ["Équipe Bleue", "Équipe Rouge"],
            key="team_check_radio"
        )

        if team_to_check == "Équipe Bleue" and len(st.session_state.blue_team) >= 3:
            team_composition = [
                champion_manager.get_champion_by_id(c)['name']
                for c in st.session_state.blue_team
                if champion_manager.get_champion_by_id(c)
            ]
        elif team_to_check == "Équipe Rouge" and len(st.session_state.red_team) >= 3:
            team_composition = [
                champion_manager.get_champion_by_id(c)['name']
                for c in st.session_state.red_team
                if champion_manager.get_champion_by_id(c)
            ]
        else:
            team_composition = []

        if team_composition and len(team_composition) >= 3:
            st.markdown(f"**Composition à vérifier**: {', '.join(team_composition)}")

            similarity_threshold = st.slider(
                "Seuil de similitude:",
                min_value=0.3,
                max_value=1.0,
                value=0.6,
                step=0.1,
                help="Plus élevé = plus stricte"
            )

            if st.button("🔍 Rechercher compositions similaires"):
                with st.spinner("Recherche dans les drafts pro..."):
                    similar_drafts = pro_draft_analyzer.find_similar_compositions(
                        team_composition, similarity_threshold
                    )

                    if similar_drafts:
                        st.success(f"✅ {len(similar_drafts)} composition(s) similaire(s) trouvée(s)")

                        for i, draft_info in enumerate(similar_drafts):
                            with st.expander(f"📋 Match {i+1} - Similitude: {draft_info['similarity']:.1%}"):
                                col1, col2 = st.columns(2)

                                with col1:
                                    st.markdown("**Équipe analysée:**")
                                    st.write(f"- Champions: {', '.join(draft_info['picks'])}")
                                    st.write(f"- Bans: {', '.join(draft_info['bans'])}")
                                    st.write(f"- Résultat: {'🏆 Victoire' if draft_info['won'] else '❌ Défaite'}")
                                    st.write(f"- Durée: {draft_info['duration']//60}min {draft_info['duration']%60}s")

                                with col2:
                                    st.markdown("**Équipe adverse:**")
                                    st.write(f"- Champions: {', '.join(draft_info['opponent_picks'])}")
                                    st.write(f"- Bans: {', '.join(draft_info['opponent_bans'])}")

                                st.markdown(f"**Champions en commun**: {', '.join(draft_info['common_champions'])}")

                        # Statistiques globales
                        wins = sum(1 for d in similar_drafts if d['won'])
                        winrate = (wins / len(similar_drafts)) * 100
                        avg_duration = sum(d['duration'] for d in similar_drafts) / len(similar_drafts)

                        st.markdown("### 📊 Statistiques Globales")
                        col1, col2, col3 = st.columns(3)
                        with col1:
                            st.metric("Winrate Pro", f"{winrate:.1f}%")
                        with col2:
                            st.metric("Matchs trouvés", len(similar_drafts))
                        with col3:
                            st.metric("Durée moyenne", f"{avg_duration//60:.0f}min {avg_duration%60:.0f}s")
                    else:
                        st.warning("❌ Aucune composition similaire trouvée dans les drafts pro")
                        st.info("💡 Essayez de réduire le seuil de similitude ou d'ajouter plus de champions")
        else:
            st.info("🔢 Sélectionnez au moins 3 champions dans une équipe pour rechercher des compositions pro")

    with tab2:
        st.markdown("### 📖 Explication Détaillée de la Composition")

        team_to_explain = st.radio(
            "Équipe à expliquer:",
            ["Équipe Bleue", "Équipe Rouge"],
            key="team_explain_radio"
        )

        if team_to_explain == "Équipe Bleue" and len(st.session_state.blue_team) >= 3:
            team_composition = [
                champion_manager.get_champion_by_id(c)['name']
                for c in st.session_state.blue_team
                if champion_manager.get_champion_by_id(c)
            ]
        elif team_to_explain == "Équipe Rouge" and len(st.session_state.red_team) >= 3:
            team_composition = [
                champion_manager.get_champion_by_id(c)['name']
                for c in st.session_state.red_team
                if champion_manager.get_champion_by_id(c)
            ]
        else:
            team_composition = []

        if team_composition and len(team_composition) >= 3:
            st.markdown(f"**Composition à analyser**: {', '.join(team_composition)}")

            if st.button("📖 Générer l'explication"):
                with st.spinner("Analyse de la composition..."):
                    explanation = pro_draft_analyzer.get_draft_explanation(team_composition)

                    if "error" not in explanation:
                        # Ratings avec barres de progression
                        st.markdown("### 📊 Ratings de la Composition")
                        col1, col2 = st.columns(2)

                        with col1:
                            st.markdown("**Early Game**")
                            st.progress(explanation['early_game_rating'] / 100)
                            st.caption(f"{explanation['early_game_rating']}/100")

                            st.markdown("**Team Fight**")
                            st.progress(explanation['team_fight_rating'] / 100)
                            st.caption(f"{explanation['team_fight_rating']}/100")

                        with col2:
                            st.markdown("**Late Game**")
                            st.progress(explanation['late_game_rating'] / 100)
                            st.caption(f"{explanation['late_game_rating']}/100")

                            st.markdown("**Split Push**")
                            st.progress(explanation['split_push_rating'] / 100)
                            st.caption(f"{explanation['split_push_rating']}/100")

                        # Forces et Faiblesses
                        col1, col2 = st.columns(2)

                        with col1:
                            st.markdown("### ✅ Forces")
                            if explanation['strengths']:
                                for strength in explanation['strengths']:
                                    st.success(f"• {strength}")
                            else:
                                st.info("Aucune force particulière identifiée")

                        with col2:
                            st.markdown("### ⚠️ Faiblesses")
                            if explanation['weaknesses']:
                                for weakness in explanation['weaknesses']:
                                    st.warning(f"• {weakness}")
                            else:
                                st.info("Aucune faiblesse majeure identifiée")

                        # Plan de jeu
                        if explanation['game_plan']:
                            st.markdown("### 🎯 Plan de Jeu Recommandé")
                            for plan in explanation['game_plan']:
                                st.info(f"🎮 {plan}")

                        # Power Spikes
                        if explanation['power_spikes']:
                            st.markdown("### ⚡ Power Spikes")
                            for phase, description in explanation['power_spikes'].items():
                                phase_emoji = {"early": "🌅", "mid": "☀️", "late": "🌙"}.get(phase, "⚡")
                                st.markdown(f"**{phase_emoji} {phase.title()} Game**: {description}")

                        # Champions à éviter
                        if explanation['counters_to_avoid']:
                            st.markdown("### 🚫 Champions à Éviter")
                            counter_text = ", ".join(explanation['counters_to_avoid'])
                            st.error(f"⚠️ Attention aux picks: {counter_text}")
                    else:
                        st.error(explanation['error'])
        else:
            st.info("🔢 Sélectionnez au moins 3 champions dans une équipe pour obtenir une explication")

    with tab3:
        st.markdown("### 📊 Winrate et Conseils Stratégiques")

        if len(st.session_state.blue_team) >= 3 or len(st.session_state.red_team) >= 3:
            analysis_cols = st.columns(2)

            # Équipe Bleue
            with analysis_cols[0]:
                if len(st.session_state.blue_team) >= 3:
                    st.markdown("#### 🔵 Équipe Bleue")
                    blue_composition = [
                        champion_manager.get_champion_by_id(c)['name']
                        for c in st.session_state.blue_team
                        if champion_manager.get_champion_by_id(c)
                    ]

                    if st.button("Analyser Équipe Bleue", key="analyze_blue"):
                        blue_winrate = pro_draft_analyzer.get_composition_winrate(blue_composition)
                        st.metric("Winrate Pro", f"{blue_winrate:.1f}%")

                        if blue_winrate >= 60:
                            st.success("🏆 Composition très forte!")
                            st.info("💡 Conseil: Jouez agressivement pour capitaliser")
                        elif blue_winrate >= 45:
                            st.info("⚖️ Composition équilibrée")
                            st.info("💡 Conseil: Adaptez votre style à l'adversaire")
                        else:
                            st.warning("⚠️ Composition difficile")
                            st.info("💡 Conseil: Jouez défensivement et cherchez les erreurs adverses")

            # Équipe Rouge
            with analysis_cols[1]:
                if len(st.session_state.red_team) >= 3:
                    st.markdown("#### 🔴 Équipe Rouge")
                    red_composition = [
                        champion_manager.get_champion_by_id(c)['name']
                        for c in st.session_state.red_team
                        if champion_manager.get_champion_by_id(c)
                    ]

                    if st.button("Analyser Équipe Rouge", key="analyze_red"):
                        red_winrate = pro_draft_analyzer.get_composition_winrate(red_composition)
                        st.metric("Winrate Pro", f"{red_winrate:.1f}%")

                        if red_winrate >= 60:
                            st.success("🏆 Composition très forte!")
                            st.info("💡 Conseil: Jouez agressivement pour capitaliser")
                        elif red_winrate >= 45:
                            st.info("⚖️ Composition équilibrée")
                            st.info("💡 Conseil: Adaptez votre style à l'adversaire")
                        else:
                            st.warning("⚠️ Composition difficile")
                            st.info("💡 Conseil: Jouez défensivement et cherchez les erreurs adverses")

            # Comparaison si les deux équipes sont remplies
            if len(st.session_state.blue_team) >= 3 and len(st.session_state.red_team) >= 3:
                st.markdown("---")
                st.markdown("#### ⚔️ Prédiction de Match")

                if st.button("🎯 Prédire le résultat", key="predict_match"):
                    blue_composition = [
                        champion_manager.get_champion_by_id(c)['name']
                        for c in st.session_state.blue_team
                        if champion_manager.get_champion_by_id(c)
                    ]
                    red_composition = [
                        champion_manager.get_champion_by_id(c)['name']
                        for c in st.session_state.red_team
                        if champion_manager.get_champion_by_id(c)
                    ]

                    blue_winrate = pro_draft_analyzer.get_composition_winrate(blue_composition)
                    red_winrate = pro_draft_analyzer.get_composition_winrate(red_composition)

                    # Normaliser les winrates pour une prédiction relative
                    total_wr = blue_winrate + red_winrate
                    if total_wr > 0:
                        blue_pred = (blue_winrate / total_wr) * 100
                        red_pred = (red_winrate / total_wr) * 100
                    else:
                        blue_pred = red_pred = 50.0

                    col1, col2 = st.columns(2)
                    with col1:
                        st.metric("🔵 Équipe Bleue", f"{blue_pred:.1f}%")
                    with col2:
                        st.metric("🔴 Équipe Rouge", f"{red_pred:.1f}%")

                    favorite = "Bleue" if blue_pred > red_pred else "Rouge"
                    confidence = abs(blue_pred - red_pred)

                    if confidence >= 20:
                        st.success(f"🏆 **Favori clair**: Équipe {favorite}")
                    elif confidence >= 10:
                        st.info(f"📈 **Léger avantage**: Équipe {favorite}")
                    else:
                        st.warning("⚖️ **Match très serré**: Avantage minime")
        else:
            st.info("🔢 Sélectionnez au moins 3 champions dans une équipe pour l'analyse de winrate")

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

    # Information sur les données
    with st.expander("📋 À propos des données"):
        st.markdown("""
        ### Sources des données
        **Données actuelles**: Exemples de drafts simulés pour démonstration

        **En production, ces données proviendraient de**:
        - API Riot Games pour les matchs classés
        - Données de ligues professionnelles (LCS, LEC, LCK, LPL)
        - Sites communautaires (op.gg, u.gg, lolalytics)

        **Fiabilité**: ⚠️ Données d'exemple (score: 6/10)
        """)

    # Obtenir le DataFrame des stats
    df = pro_draft_analyzer.get_stats_dataframe()

    if not df.empty:
        # Métriques générales
        total_matches = len(pro_draft_analyzer.drafts)
        total_champions = len(df)
        avg_winrate = df['Winrate'].mean()

        # Affichage des métriques
        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("🎮 Matchs analysés", total_matches)
        with col2:
            st.metric("🏆 Champions vus", total_champions)
        with col3:
            st.metric("⚖️ Winrate moyenne", f"{avg_winrate:.1f}%")
        with col4:
            most_picked = df.loc[df['Picks'].idxmax(), 'Champion']
            st.metric("👑 Plus joué", most_picked)

        st.markdown("---")

        # Contrôles et filtres
        st.markdown("### 🎛️ Filtres et Options")
        col1, col2, col3 = st.columns(3)

        with col1:
            min_picks = st.slider("Picks minimum", 0, int(df['Picks'].max()), 0,
                                help="Filtrer les champions ayant au moins X picks")
        with col2:
            sort_by = st.selectbox("Trier par", ['Winrate', 'Pickrate', 'Banrate', 'Picks'],
                                 help="Critère de tri des résultats")
        with col3:
            show_chart_type = st.selectbox("Type de graphique",
                                         ['Tableau', 'Graphique en barres', 'Scatter Plot'],
                                         help="Format d'affichage des données")

        # Filtrer et trier
        df_filtered = df[df['Picks'] >= min_picks].sort_values(sort_by, ascending=False)

        st.markdown("---")

        # Affichage principal selon le type choisi
        if show_chart_type == 'Tableau':
            st.markdown("### 📊 Tableau des Statistiques")
            st.plotly_chart(chart_generator.create_pro_stats_table(df_filtered), use_container_width=True)

        elif show_chart_type == 'Graphique en barres':
            st.markdown("### 📊 Graphique en Barres")
            bar_chart = chart_generator.create_pro_stats_bar_chart(df_filtered.head(15), sort_by)
            st.plotly_chart(bar_chart, use_container_width=True)

        elif show_chart_type == 'Scatter Plot':
            st.markdown("### 📊 Analyse Pickrate vs Winrate")
            scatter_chart = chart_generator.create_pro_stats_scatter(df_filtered)
            st.plotly_chart(scatter_chart, use_container_width=True)

        # Analyse par catégories
        st.markdown("---")
        st.markdown("### 🏆 Top Champions par Catégorie")

        # Top champions par catégorie avec design amélioré
        col_a, col_b, col_c = st.columns(3)

        with col_a:
            st.markdown("#### 🥇 Top Winrate")
            top_wr = df_filtered.nlargest(5, 'Winrate')[['Champion', 'Winrate', 'Picks']]
            for i, (_, row) in enumerate(top_wr.iterrows()):
                medal = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"][i]
                st.markdown(f"""
                <div class="champion-card">
                    {medal} **{row['Champion']}**<br/>
                    💯 {row['Winrate']:.1f}% winrate<br/>
                    🎯 {row['Picks']} picks
                </div>
                """, unsafe_allow_html=True)

        with col_b:
            st.markdown("#### 🎯 Top Pickrate")
            top_pr = df_filtered.nlargest(5, 'Pickrate')[['Champion', 'Pickrate', 'Winrate']]
            for i, (_, row) in enumerate(top_pr.iterrows()):
                medal = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"][i]
                st.markdown(f"""
                <div class="champion-card">
                    {medal} **{row['Champion']}**<br/>
                    📈 {row['Pickrate']:.1f}% pickrate<br/>
                    💯 {row['Winrate']:.1f}% winrate
                </div>
                """, unsafe_allow_html=True)

        with col_c:
            st.markdown("#### 🚫 Top Banrate")
            top_br = df_filtered.nlargest(5, 'Banrate')[['Champion', 'Banrate', 'Picks']]
            for i, (_, row) in enumerate(top_br.iterrows()):
                medal = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"][i]
                st.markdown(f"""
                <div class="champion-card">
                    {medal} **{row['Champion']}**<br/>
                    🚫 {row['Banrate']:.1f}% banrate<br/>
                    🎯 {row['Picks']} picks
                </div>
                """, unsafe_allow_html=True)

        # Insights et analyse
        st.markdown("---")
        st.markdown("### 🔍 Insights du Meta")

        insight_col1, insight_col2 = st.columns(2)

        with insight_col1:
            # Champions équilibrés
            balanced_champs = df_filtered[
                (df_filtered['Winrate'] >= 45) &
                (df_filtered['Winrate'] <= 55) &
                (df_filtered['Picks'] >= 2)
            ]

            st.markdown("#### ⚖️ Champions Équilibrés")
            st.caption(f"Champions avec 45-55% winrate et ≥2 picks ({len(balanced_champs)} trouvés)")
            for _, row in balanced_champs.head(5).iterrows():
                st.success(f"**{row['Champion']}**: {row['Winrate']:.1f}% WR, {row['Pickrate']:.1f}% PR")

        with insight_col2:
            # Champions oppressifs
            oppressive_champs = df_filtered[
                (df_filtered['Banrate'] >= 20) |
                (df_filtered['Winrate'] >= 60)
            ]

            st.markdown("#### ⚠️ Champions Problématiques")
            st.caption(f"Champions avec >60% winrate ou >20% banrate ({len(oppressive_champs)} trouvés)")
            for _, row in oppressive_champs.head(5).iterrows():
                reason = "Winrate élevé" if row['Winrate'] >= 60 else "Souvent banni"
                st.warning(f"**{row['Champion']}**: {reason} ({row['Winrate']:.1f}% WR)")

        # Tendances du meta
        st.markdown("---")
        st.markdown("### 📈 Tendances du Meta")

        # Analyse de la diversité
        diversity_score = len(df_filtered[df_filtered['Picks'] >= 1]) / len(df) * 100

        trend_col1, trend_col2 = st.columns(2)

        with trend_col1:
            st.metric("🌈 Diversité du Meta", f"{diversity_score:.1f}%",
                     help="Pourcentage de champions ayant au moins 1 pick")

            # Champions émergents (winrate élevé avec peu de picks)
            emerging = df_filtered[
                (df_filtered['Winrate'] >= 60) &
                (df_filtered['Picks'] <= 2)
            ]

            if not emerging.empty:
                st.markdown("**🚀 Champions Émergents**")
                for _, row in emerging.head(3).iterrows():
                    st.info(f"{row['Champion']}: {row['Winrate']:.1f}% WR avec {row['Picks']} picks")

        with trend_col2:
            # Meta shift (champions avec beaucoup de bans mais peu de picks)
            meta_shift = df_filtered[
                (df_filtered['Banrate'] >= 15) &
                (df_filtered['Pickrate'] <= 10)
            ]

            if not meta_shift.empty:
                st.markdown("**🔄 Shift du Meta**")
                st.caption("Champions souvent bannis mais peu joués")
                for _, row in meta_shift.head(3).iterrows():
                    st.warning(f"{row['Champion']}: {row['Banrate']:.1f}% BR, {row['Pickrate']:.1f}% PR")

    else:
        st.warning("📭 Aucune donnée de draft disponible")
        st.markdown("""
        ### Comment ajouter des données

        1. **Ajoutez des drafts** dans le fichier `data/pro_drafts.json`
        2. **Format requis**:
           ```json
           {
             "blue_team": {"picks": [...], "bans": [...]},
             "red_team": {"picks": [...], "bans": [...]},
             "winner": "blue|red",
             "match_duration": 1800
           }
           ```
        3. **Redémarrez l'application** pour voir les nouvelles données

        En production, ces données seraient automatiquement récupérées depuis les APIs des ligues professionnelles.
        """)

# Page 4: Stats Champions & Items
elif page == "🛡️ Stats Champions & Items":
    st.header("Statistiques des Champions et Items")

    tab1, tab2, tab3, tab4, tab5 = st.tabs([
        "📊 Stats Champions",
        "🔍 Comparaison Champions",
        "⚔️ Stats Items",
        "🔗 Champions & Items",
        "🏆 Comparaison Avancée"
    ])

    with tab1:
        st.subheader("Analyse des Champions")

        # Contrôles principaux
        col1, col2 = st.columns([2, 1])

        with col1:
            # Sélection du champion
            champion_names = sorted([champ['name'] for champ in champion_manager.champions.values()])
            selected_champion_name = st.selectbox("Choisir un champion:", champion_names)

        with col2:
            # Slider de niveau
            champion_level = st.slider(
                "Niveau du champion:",
                min_value=1,
                max_value=18,
                value=1,
                help="Ajuste les statistiques du champion selon son niveau"
            )

        if selected_champion_name:
            # Trouver le champion par nom
            selected_champion = None
            for champ in champion_manager.champions.values():
                if champ['name'] == selected_champion_name:
                    selected_champion = champ
                    break

            if selected_champion:
                # Calculer les stats au niveau choisi
                from src.data.champion_data import calculate_champion_stats_at_level, get_champion_power_curve

                champion_at_level = calculate_champion_stats_at_level(selected_champion, champion_level)

                col1, col2 = st.columns(2)

                with col1:
                    # Informations de base
                    st.markdown(f"### {selected_champion['name']} (Niveau {champion_level})")
                    st.markdown(f"**Titre**: {selected_champion['title']}")
                    st.markdown(f"**Rôles**: {', '.join(selected_champion['tags'])}")

                    # Graphique radar du profil (utilise les stats d'info, pas affectées par le niveau)
                    radar_chart = stats_viewer.create_champion_stats_chart(selected_champion)
                    st.plotly_chart(radar_chart, use_container_width=True)

                with col2:
                    # Image du champion (si disponible)
                    if 'image' in selected_champion:
                        try:
                            st.image(selected_champion['image'], width=200)
                        except:
                            st.write("Image non disponible")

                    # Sorts et passif
                    st.markdown("**Sorts:**")
                    for spell in selected_champion.get('spells', []):
                        st.write(f"- {spell}")

                    st.markdown(f"**Passif**: {selected_champion.get('passive', 'Non disponible')}")

                # Statistiques de base
                st.markdown(f"### Statistiques de Base (Niveau {champion_level})")
                base_stats_chart = stats_viewer.create_champion_base_stats_chart(champion_at_level)
                st.plotly_chart(base_stats_chart, use_container_width=True)

                # Courbe de puissance
                st.markdown("### Courbe de Puissance")
                power_curve = get_champion_power_curve(selected_champion)
                if power_curve:
                    power_chart = stats_viewer.create_champion_power_curve(power_curve, selected_champion['name'])
                    st.plotly_chart(power_chart, use_container_width=True)

                    # Indicateur de niveau actuel
                    st.info(f"📍 Niveau actuel sélectionné: **{champion_level}**. Utilisez le slider pour voir l'évolution des stats.")

                # Items recommandés pour ce champion
                st.markdown("### Items Recommandés")
                recommended_items = champion_item_analyzer.get_recommended_items_for_champion(selected_champion['id'])

                if recommended_items:
                    cols = st.columns(3)
                    for i, item_data in enumerate(recommended_items[:6]):
                        with cols[i % 3]:
                            item = item_data['item']
                            st.markdown(f"**{item['name']}**")
                            st.write(f"Synergie: {item_data['synergy_score']:.1f}")
                            st.write(f"Coût: {item['gold'].get('total', 0)} gold")
                            if item_data['reason']:
                                st.caption(item_data['reason'])

    with tab2:
        st.subheader("Comparaison de Champions")

        # Contrôles globaux
        col1, col2 = st.columns([2, 1])

        with col1:
            # Mode de comparaison
            comparison_mode = st.radio(
                "Mode de comparaison:",
                ["Comparer 2-5 Champions", "Analyser une Équipe Complète"],
                horizontal=True
            )

        with col2:
            # Slider de niveau pour la comparaison
            comparison_level = st.slider(
                "Niveau pour la comparaison:",
                min_value=1,
                max_value=18,
                value=6,
                help="Niveau auquel comparer les statistiques des champions"
            )

        if comparison_mode == "Comparer 2-5 Champions":
            st.markdown("### Sélectionner les Champions à Comparer")

            # Sélection multiple de champions
            champion_names = sorted([champ['name'] for champ in champion_manager.champions.values()])
            selected_champions_names = st.multiselect(
                "Choisir 2 à 5 champions:",
                champion_names,
                max_selections=5,
                help="Sélectionnez entre 2 et 5 champions pour les comparer"
            )

            if len(selected_champions_names) >= 2:
                # Récupérer les objets champions
                selected_champions = []
                for name in selected_champions_names:
                    for champ in champion_manager.champions.values():
                        if champ['name'] == name:
                            selected_champions.append(champ)
                            break

                if len(selected_champions) >= 2:
                    # Calculer les stats au niveau choisi pour tous les champions
                    from src.data.champion_data import calculate_champion_stats_at_level

                    champions_at_level = []
                    for champion in selected_champions:
                        champ_at_level = calculate_champion_stats_at_level(champion, comparison_level)
                        champions_at_level.append(champ_at_level)

                    # Afficher les informations de base
                    st.markdown(f"### Champions Sélectionnés (Niveau {comparison_level})")
                    cols = st.columns(len(selected_champions))

                    for i, champion in enumerate(selected_champions):
                        with cols[i]:
                            st.markdown(f"**{champion['name']}**")
                            st.write(f"Rôles: {', '.join(champion['tags'])}")
                            if 'image' in champion:
                                try:
                                    st.image(champion['image'], width=100)
                                except:
                                    pass

                    # Graphiques de comparaison
                    st.markdown("### Comparaison des Profils")
                    comparison_radar = stats_viewer.create_champions_comparison_radar(selected_champions)
                    st.plotly_chart(comparison_radar, use_container_width=True)

                    st.markdown(f"### Comparaison des Statistiques de Base (Niveau {comparison_level})")
                    stats_comparison = stats_viewer.create_champions_base_stats_comparison(champions_at_level)
                    st.plotly_chart(stats_comparison, use_container_width=True)

                    # Distribution des rôles
                    st.markdown("### Distribution des Rôles")
                    roles_distribution = stats_viewer.create_champions_roles_distribution(selected_champions)
                    st.plotly_chart(roles_distribution, use_container_width=True)

                    # Matrice de synergie si plus de 2 champions
                    if len(selected_champions) > 2:
                        st.markdown("### Matrice de Synergie")
                        synergy_matrix = champion_item_analyzer.calculate_team_synergy_matrix(selected_champions)
                        if synergy_matrix:
                            synergy_heatmap = stats_viewer.create_team_synergy_heatmap(selected_champions, synergy_matrix)
                            st.plotly_chart(synergy_heatmap, use_container_width=True)

            elif len(selected_champions_names) == 1:
                st.info("Veuillez sélectionner au moins 2 champions pour une comparaison.")
            else:
                st.info("Sélectionnez des champions dans la liste ci-dessus pour commencer la comparaison.")

        else:  # Analyser une Équipe Complète
            st.markdown("### Analyser une Composition d'Équipe")

            # Sélection de 5 champions pour une équipe
            champion_names = sorted([champ['name'] for champ in champion_manager.champions.values()])

            # Interface pour créer une équipe
            st.markdown("**Construire votre équipe:**")
            cols = st.columns(5)
            lane_names = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']
            team_composition = []

            for i, lane in enumerate(lane_names):
                with cols[i]:
                    selected = st.selectbox(
                        f"{lane}:",
                        [""] + champion_names,
                        key=f"team_comp_{lane}"
                    )
                    if selected:
                        # Trouver le champion
                        for champ in champion_manager.champions.values():
                            if champ['name'] == selected:
                                team_composition.append(champ)
                                break

            if len(team_composition) >= 2:
                st.markdown(f"### Analyse de l'Équipe (Niveau {comparison_level})")

                # Calculer les stats de l'équipe au niveau choisi
                team_at_level = []
                for champion in team_composition:
                    champ_at_level = calculate_champion_stats_at_level(champion, comparison_level)
                    team_at_level.append(champ_at_level)

                # Graphiques de l'équipe
                col1, col2 = st.columns(2)

                with col1:
                    # Radar de comparaison
                    team_radar = stats_viewer.create_champions_comparison_radar(team_composition)
                    st.plotly_chart(team_radar, use_container_width=True)

                with col2:
                    # Distribution des rôles
                    roles_dist = stats_viewer.create_champions_roles_distribution(team_composition)
                    st.plotly_chart(roles_dist, use_container_width=True)

                # Analyse de composition
                if len(team_composition) >= 3:
                    composition_analysis = champion_item_analyzer.analyze_team_composition(team_composition)
                    if composition_analysis:
                        analysis_chart = stats_viewer.create_team_composition_analysis(team_composition, composition_analysis)
                        st.plotly_chart(analysis_chart, use_container_width=True)

                        # Tableau détaillé d'analyse
                        st.markdown("### Analyse Détaillée")
                        analysis_df = []
                        for aspect, score in composition_analysis.items():
                            grade = "🟢 Excellent" if score >= 80 else "🟡 Bon" if score >= 60 else "🟠 Moyen" if score >= 40 else "🔴 Faible"
                            analysis_df.append({
                                'Aspect': aspect,
                                'Score': f"{score:.1f}%",
                                'Évaluation': grade
                            })

                        import pandas as pd
                        df = pd.DataFrame(analysis_df)
                        st.dataframe(df, use_container_width=True)

                # Matrice de synergie
                if len(team_composition) >= 2:
                    st.markdown("### Matrice de Synergie de l'Équipe")
                    synergy_matrix = champion_item_analyzer.calculate_team_synergy_matrix(team_composition)
                    if synergy_matrix:
                        synergy_heatmap = stats_viewer.create_team_synergy_heatmap(team_composition, synergy_matrix)
                        st.plotly_chart(synergy_heatmap, use_container_width=True)

                        # Score moyen de synergie
                        total_synergy = 0
                        count = 0
                        for i in range(len(synergy_matrix)):
                            for j in range(len(synergy_matrix[i])):
                                if i != j:
                                    total_synergy += synergy_matrix[i][j]
                                    count += 1

                        if count > 0:
                            avg_synergy = total_synergy / count
                            synergy_grade = "S" if avg_synergy >= 80 else "A" if avg_synergy >= 70 else "B" if avg_synergy >= 60 else "C" if avg_synergy >= 50 else "D"

                            col1, col2, col3 = st.columns(3)
                            with col1:
                                st.metric("Synergie Moyenne", f"{avg_synergy:.1f}%")
                            with col2:
                                st.metric("Note de Synergie", synergy_grade)
                            with col3:
                                st.metric("Champions dans l'équipe", len(team_composition))

            else:
                st.info("Ajoutez au moins 2 champions à votre équipe pour voir l'analyse.")

    with tab3:
        st.subheader("Analyse des Items")

        # Options de filtrage
        col1, col2 = st.columns(2)

        with col1:
            search_term = st.text_input("Rechercher un item:")
            if search_term:
                items_list = item_manager.search_items(search_term)
            else:
                items_list = list(item_manager.items.values())

        with col2:
            # Filtrer par catégorie
            all_tags = item_manager.get_all_tags()
            selected_tag = st.selectbox("Filtrer par catégorie:", ["Toutes"] + all_tags)

            if selected_tag != "Toutes":
                items_list = item_manager.get_items_by_tag(selected_tag)

        # Sélection de l'item
        if items_list:
            item_names = [item['name'] for item in items_list]
            selected_item_name = st.selectbox("Choisir un item:", item_names)

            selected_item = None
            for item in items_list:
                if item['name'] == selected_item_name:
                    selected_item = item
                    break

            if selected_item:
                col1, col2 = st.columns(2)

                with col1:
                    # Informations de base
                    st.markdown(f"### {selected_item['name']}")
                    if selected_item.get('plaintext'):
                        st.markdown(f"*{selected_item['plaintext']}*")

                    # Coût
                    gold_info = selected_item.get('gold', {})
                    if gold_info:
                        st.markdown(f"**Coût total**: {gold_info.get('total', 0)} gold")
                        if gold_info.get('base', 0) > 0:
                            st.markdown(f"**Coût de base**: {gold_info.get('base', 0)} gold")

                    # Catégories
                    if selected_item.get('tags'):
                        st.markdown(f"**Catégories**: {', '.join(selected_item['tags'])}")

                with col2:
                    # Image de l'item
                    if 'image' in selected_item:
                        try:
                            st.image(selected_item['image'], width=100)
                        except:
                            st.write("Image non disponible")

                # Graphique des statistiques
                if selected_item.get('stats'):
                    st.markdown("### Statistiques de l'Item")
                    item_stats_chart = stats_viewer.create_item_stats_chart(selected_item)
                    st.plotly_chart(item_stats_chart, use_container_width=True)

                # Chemin de construction
                build_path = item_manager.get_item_build_path(selected_item['id'])
                if build_path.get('components') or build_path.get('builds_into'):
                    st.markdown("### Chemin de Construction")
                    build_diagram = stats_viewer.create_build_path_diagram(build_path)
                    st.plotly_chart(build_diagram, use_container_width=True)

                # Champions qui utilisent cet item
                st.markdown("### Champions Recommandés")
                champions_using = champion_item_analyzer.get_champions_using_item(selected_item['id'])

                if champions_using:
                    cols = st.columns(4)
                    for i, champion_data in enumerate(champions_using[:8]):
                        with cols[i % 4]:
                            champion = champion_data['champion']
                            st.markdown(f"**{champion['name']}**")
                            st.write(f"Synergie: {champion_data['synergy_score']:.1f}")
                            st.caption(f"Position dans le build: {champion_data['build_position']}")

    with tab4:
        st.subheader("Analyse Champion-Item")

        # Sélection du champion
        champion_names = sorted([champ['name'] for champ in champion_manager.champions.values()])
        selected_champion_name = st.selectbox("Champion:", champion_names, key="tab4_champion")

        selected_champion = None
        for champ in champion_manager.champions.values():
            if champ['name'] == selected_champion_name:
                selected_champion = champ
                break

        if selected_champion:
            # Sélection multiple d'items pour analyser un build
            st.markdown("### Construire un Build")

            # Recherche d'items
            item_search = st.text_input("Rechercher des items:", key="build_search")
            if item_search:
                available_items = item_manager.search_items(item_search)
            else:
                available_items = list(item_manager.items.values())[:50]  # Limiter pour les performances

            item_names = [f"{item['name']} ({item['gold'].get('total', 0)} gold)" for item in available_items]
            selected_items = st.multiselect("Sélectionner jusqu'à 6 items:", item_names, max_selections=6)

            if selected_items:
                # Extraire les IDs des items sélectionnés
                selected_item_ids = []
                for selected_name in selected_items:
                    item_name = selected_name.split(" (")[0]
                    for item in available_items:
                        if item['name'] == item_name:
                            selected_item_ids.append(item['id'])
                            break

                # Analyser le build
                if selected_item_ids:
                    st.markdown("### Analyse du Build")
                    build_analysis = champion_item_analyzer.analyze_build_synergy(selected_item_ids, selected_champion['id'])

                    if build_analysis:
                        # Métriques principales
                        col1, col2, col3, col4 = st.columns(4)

                        with col1:
                            st.metric("Note du Build", build_analysis['build_rating'])

                        with col2:
                            st.metric("Synergie Totale", f"{build_analysis['total_synergy']:.1f}")

                        with col3:
                            st.metric("Synergie Moyenne", f"{build_analysis['average_synergy']:.1f}")

                        with col4:
                            st.metric("Coût Total", f"{build_analysis['total_cost']} gold")

                        # Détails des items
                        st.markdown("### Détail des Items")
                        for item_data in build_analysis['items']:
                            with st.expander(f"{item_data['item']['name']} - Synergie: {item_data['synergy_score']:.1f}"):
                                col_a, col_b = st.columns(2)

                                with col_a:
                                    st.write(f"**Coût**: {item_data['item']['gold'].get('total', 0)} gold")
                                    if item_data['item'].get('plaintext'):
                                        st.write(f"**Description**: {item_data['item']['plaintext']}")

                                with col_b:
                                    st.write(f"**Raison**: {item_data['reason']}")
                                    stats = item_data['item'].get('stats', {})
                                    if stats:
                                        st.write("**Statistiques**:")
                                        for stat, value in stats.items():
                                            if value > 0:
                                                st.write(f"  - {stat}: +{value}")

                        # Statistiques totales du build
                        if build_analysis['total_stats']:
                            st.markdown("### Statistiques Totales du Build")
                            stats_df = []
                            for stat, value in build_analysis['total_stats'].items():
                                if value > 0:
                                    stats_df.append({'Statistique': stat, 'Valeur': f"+{value}"})

                            if stats_df:
                                import pandas as pd
                                df = pd.DataFrame(stats_df)
                                st.dataframe(df, use_container_width=True)

    with tab5:
        st.subheader("🏆 Comparaison Avancée Champions + Items")
        st.markdown("Comparez jusqu'à 4 champions avec leurs builds complets à un niveau donné.")

        # Contrôles principaux
        col1, col2 = st.columns([2, 1])

        with col1:
            st.markdown("### Configuration de la Comparaison")

        with col2:
            # Niveau de comparaison
            advanced_level = st.slider(
                "Niveau de comparaison:",
                min_value=1,
                max_value=18,
                value=11,
                help="Niveau auquel comparer tous les champions avec leurs items"
            )

        # Configuration des champions et builds
        st.markdown("### Champions et Builds")

        num_champions = st.selectbox(
            "Nombre de champions à comparer:",
            [2, 3, 4],
            index=1,  # 3 par défaut
            help="Sélectionnez le nombre de champions à inclure dans la comparaison"
        )

        # Configuration pour chaque champion
        champion_configs = []
        champion_names = sorted([champ['name'] for champ in champion_manager.champions.values()])

        cols = st.columns(num_champions)

        for i in range(num_champions):
            with cols[i]:
                st.markdown(f"#### Champion {i+1}")

                # Sélection du champion
                selected_champ = st.selectbox(
                    f"Champion:",
                    champion_names,
                    key=f"advanced_champ_{i}",
                    index=i % len(champion_names)
                )

                # Trouver l'ID du champion
                champion_id = None
                for champ in champion_manager.champions.values():
                    if champ['name'] == selected_champ:
                        champion_id = champ['id']
                        break

                if champion_id:
                    # Sélection des items
                    st.markdown("**Build:**")

                    # Recherche d'items
                    item_search = st.text_input(f"Rechercher items:", key=f"item_search_{i}")
                    if item_search:
                        available_items = item_manager.search_items(item_search)
                    else:
                        available_items = list(item_manager.items.values())[:30]  # Top 30 items

                    item_options = [f"{item['name']} ({item['gold'].get('total', 0)}g)" for item in available_items]

                    selected_items = st.multiselect(
                        f"Items (max 6):",
                        item_options,
                        key=f"advanced_items_{i}",
                        max_selections=6,
                        help="Sélectionnez jusqu'à 6 items pour ce champion"
                    )

                    # Extraire les IDs des items
                    item_ids = []
                    for selected_item in selected_items:
                        item_name = selected_item.split(" (")[0]
                        for item in available_items:
                            if item['name'] == item_name:
                                item_ids.append(item['id'])
                                break

                    champion_configs.append({
                        'champion_id': champion_id,
                        'item_ids': item_ids
                    })

                    # Aperçu du coût total
                    total_cost = sum(
                        item_manager.get_item_by_id(item_id)['gold'].get('total', 0)
                        for item_id in item_ids
                        if item_manager.get_item_by_id(item_id)
                    )
                    st.caption(f"💰 Coût total: {total_cost} gold")

        # Lancer la comparaison
        if len(champion_configs) >= 2 and st.button("🔍 Analyser la Comparaison", use_container_width=True):
            # Filtrer les configs valides
            valid_configs = [config for config in champion_configs if config['champion_id']]

            if len(valid_configs) >= 2:
                with st.spinner("Analyse en cours..."):
                    # Effectuer la comparaison avancée
                    comparison_results = advanced_comparator.compare_champions_with_builds(
                        valid_configs, advanced_level
                    )

                    if comparison_results:
                        st.success("✅ Analyse terminée !")

                        # Affichage des résultats
                        st.markdown("---")
                        st.markdown("## 📊 Résultats de l'Analyse")

                        # Graphique radar principal
                        st.markdown("### Comparaison Globale")
                        advanced_radar = stats_viewer.create_advanced_comparison_chart(comparison_results)
                        st.plotly_chart(advanced_radar, use_container_width=True)

                        # Statistiques finales détaillées
                        col1, col2 = st.columns(2)

                        with col1:
                            st.markdown("### Statistiques Finales")
                            final_stats_chart = stats_viewer.create_final_stats_comparison(comparison_results)
                            st.plotly_chart(final_stats_chart, use_container_width=True)

                        with col2:
                            st.markdown("### Coût vs Efficacité")
                            cost_efficiency_chart = stats_viewer.create_cost_efficiency_chart(comparison_results)
                            st.plotly_chart(cost_efficiency_chart, use_container_width=True)

                        # Classements
                        st.markdown("### 🏆 Classements")
                        rankings = comparison_results.get('rankings', {})

                        ranking_cols = st.columns(3)

                        with ranking_cols[0]:
                            st.markdown("**🔥 Top Dégâts**")
                            for i, champ_data in enumerate(rankings.get('damage', [])[:3]):
                                medal = ["🥇", "🥈", "🥉"][i]
                                st.write(f"{medal} {champ_data['champion']['name']}")

                        with ranking_cols[1]:
                            st.markdown("**🛡️ Top Survie**")
                            for i, champ_data in enumerate(rankings.get('survival', [])[:3]):
                                medal = ["🥇", "🥈", "🥉"][i]
                                st.write(f"{medal} {champ_data['champion']['name']}")

                        with ranking_cols[2]:
                            st.markdown("**💰 Top Efficacité**")
                            for i, champ_data in enumerate(rankings.get('cost_efficiency', [])[:3]):
                                medal = ["🥇", "🥈", "🥉"][i]
                                st.write(f"{medal} {champ_data['champion']['name']}")

                        # Détails par champion
                        st.markdown("### 📋 Analyse Détaillée par Champion")

                        for i, champion_data in enumerate(comparison_results['champions']):
                            champion_name = champion_data['champion']['name']

                            with st.expander(f"📊 {champion_name} - Analyse Complète"):
                                detail_col1, detail_col2 = st.columns(2)

                                with detail_col1:
                                    # Graphique de décomposition
                                    breakdown_chart = stats_viewer.create_effectiveness_breakdown_chart(champion_data)
                                    st.plotly_chart(breakdown_chart, use_container_width=True)

                                    # Items utilisés
                                    st.markdown("**🎯 Items du Build:**")
                                    for item in champion_data['items']:
                                        if item:
                                            st.write(f"• {item['name']} ({item['gold'].get('total', 0)}g)")

                                with detail_col2:
                                    # Métriques
                                    effectiveness = champion_data['effectiveness_scores']
                                    st.metric("Score Total", f"{effectiveness['total']:.0f}")
                                    st.metric("Efficacité/Coût", f"{effectiveness['cost_efficiency']:.2f}")

                                    # Synergie du build
                                    build_synergy = champion_data.get('build_synergy', {})
                                    if build_synergy:
                                        st.metric("Note du Build", build_synergy.get('build_rating', 'N/A'))

                        # Recommandations d'amélioration
                        st.markdown("### 💡 Recommandations")
                        recommendations = comparison_results.get('recommendations', [])

                        for rec in recommendations:
                            champion_name = rec['champion']
                            with st.expander(f"💡 Conseils pour {champion_name}"):
                                if rec['strengths']:
                                    st.markdown("**✅ Forces:**")
                                    for strength in rec['strengths']:
                                        st.success(strength)

                                if rec['weaknesses']:
                                    st.markdown("**⚠️ Faiblesses:**")
                                    for weakness in rec['weaknesses']:
                                        st.warning(weakness)

                                if rec['improvements']:
                                    st.markdown("**🔧 Améliorations suggérées:**")
                                    for improvement in rec['improvements']:
                                        st.info(improvement)

                    else:
                        st.error("❌ Erreur lors de l'analyse")
            else:
                st.warning("⚠️ Veuillez configurer au moins 2 champions valides")

        # Section d'aide
        with st.expander("❓ Comment utiliser la Comparaison Avancée"):
            st.markdown("""
            ### Guide d'utilisation

            1. **Choisissez le niveau** : Sélectionnez le niveau auquel comparer (recommandé: 6-11)
            2. **Configurez les champions** : Pour chaque champion:
               - Sélectionnez le champion
               - Choisissez jusqu'à 6 items
               - Vérifiez le coût total
            3. **Lancez l'analyse** : Cliquez sur "Analyser la Comparaison"
            4. **Interprétez les résultats** :
               - **Radar** : Vue d'ensemble des forces/faiblesses
               - **Stats finales** : Comparaison détaillée des statistiques
               - **Coût/Efficacité** : Rapport qualité-prix des builds
               - **Classements** : Qui excelle dans chaque domaine

            ### Scores d'efficacité
            - **Survie** : HP + Armure + Résistance Magique
            - **Dégâts** : AD + AP + Vitesse d'Attaque + Critique
            - **Utilité** : Mana + Régénération + Vitesse de Déplacement

            ### Conseils
            - Testez différents niveaux pour voir l'évolution
            - Comparez des builds budget vs builds chers
            - Équilibrez les 3 domaines selon votre style de jeu
            """)

# Page 5: À propos
else:
    st.header("À propos")

    # Section principale avec onglets
    tab1, tab2, tab3, tab4 = st.tabs([
        "🎯 Présentation",
        "📊 Sources de Données",
        "🔒 Confidentialité",
        "🛠️ Technique"
    ])

    with tab1:
        st.markdown("""
        ## LoL Team Composition Helper

        ### 🎯 Objectif
        Cet outil aide les équipes League of Legends à créer des compositions optimales en se basant sur:
        - Les statistiques officielles des champions et items
        - Les données de drafts professionnels
        - L'analyse algorithmique des synergies
        - Les métriques d'efficacité par niveau

        ### 📊 Fonctionnalités Complètes

        **🎯 Draft Assistant**
        - Recommandations intelligentes de picks basées sur l'équipe actuelle
        - Suggestions de bans stratégiques contre l'équipe adverse
        - Calcul des probabilités de victoire en temps réel
        - Analyse des counters et synergies

        **📈 Analyse de Composition**
        - Évaluation automatique des forces et faiblesses d'équipe
        - Graphiques radar interactifs pour visualiser l'équilibre
        - Analyse par phase de jeu (early/mid/late game)
        - Comparaison directe entre deux équipes complètes

        **📈 Statistiques Pro**
        - Données basées sur les drafts de ligues professionnelles
        - Winrates, pickrates, banrates par champion
        - Tendances et shifts du meta en temps réel
        - Identification des champions émergents et problématiques

        **🛡️ Stats Champions & Items**
        - Analyse détaillée des statistiques par niveau (1-18)
        - Visualisation interactive des builds d'items
        - Recommandations personnalisées champion-item
        - Comparaison avancée avec métriques d'efficacité
        - Calculs de synergie et optimisation des builds

        ### 🎮 Guide d'utilisation

        1. **Commencez par le Draft Assistant** pour construire votre équipe avec des recommandations intelligentes
        2. **Utilisez l'Analyse de Composition** pour évaluer et comparer vos équipes
        3. **Consultez les Statistiques Pro** pour suivre le meta actuel
        4. **Explorez Stats Champions & Items** pour optimiser vos builds et comparaisons

        ### 🏆 Avantages

        ✅ **Données officielles** de Riot Games
        ✅ **Calculs transparents** et explicables
        ✅ **Interface intuitive** et responsive
        ✅ **Analyses avancées** avec métriques d'efficacité
        ✅ **Temps réel** - aucune latence dans les calculs
        ✅ **Gratuit et open-source**

        ---

        *Créé avec ❤️ pour la communauté League of Legends*
        """)

    with tab2:
        # Utiliser les données du gestionnaire de sources
        data_sources_manager = DataSourcesManager()

        st.markdown("## 📊 Sources des Données")

        # Aperçu de la fraîcheur des données
        st.markdown("### 🕒 État Actuel des Données")
        freshness_status = data_sources_manager.get_data_freshness_status()

        col1, col2, col3 = st.columns(3)
        with col1:
            st.markdown(f"""
            **API Riot Games**
            {freshness_status['riot_api']['status']}
            {freshness_status['riot_api']['description']}
            """)

        with col2:
            st.markdown(f"""
            **Drafts Pro**
            {freshness_status['pro_drafts']['status']}
            {freshness_status['pro_drafts']['description']}
            """)

        with col3:
            st.markdown(f"""
            **Calculs**
            {freshness_status['calculations']['status']}
            {freshness_status['calculations']['description']}
            """)

        st.markdown("---")

        # Sources détaillées
        st.markdown("### 🗂️ Sources Détaillées")
        all_sources = data_sources_manager.get_all_sources()

        for source_key, source_info in all_sources.items():
            with st.expander(f"📋 {source_info['name']}"):
                st.markdown(f"**Description**: {source_info['description']}")
                st.markdown(f"**URL**: {source_info['url']}")

                st.markdown("**Types de données**:")
                for data_type in source_info['data_types']:
                    st.write(f"• {data_type}")

                col_a, col_b = st.columns(2)
                with col_a:
                    st.markdown(f"**Fréquence**: {source_info['update_frequency']}")
                    st.markdown(f"**Cache**: {source_info['cache_duration']}")

                with col_b:
                    st.markdown(f"**Fiabilité**: {source_info['reliability']}")
                    st.markdown(f"**Dernière MAJ**: {source_info['last_updated']}")

                if 'algorithm_basis' in source_info:
                    st.markdown("**Base algorithmique**:")
                    for basis in source_info['algorithm_basis']:
                        st.write(f"• {basis}")

        # Scores de fiabilité
        st.markdown("---")
        st.markdown("### 🎯 Scores de Fiabilité")
        reliability_scores = data_sources_manager.get_reliability_scores()

        for data_type, score_info in reliability_scores.items():
            score = score_info['score']
            description = score_info['description']

            # Couleur selon le score
            if score >= 9:
                color = "🟢"
            elif score >= 7:
                color = "🟡"
            else:
                color = "🟠"

            st.markdown(f"{color} **{data_type.replace('_', ' ').title()}**: {score}/10 - {description}")

    with tab3:
        st.markdown(get_privacy_and_usage_info())

        st.markdown("---")

        st.markdown("### 🔗 Liens et Attributions")
        st.markdown("""
        **Données officielles**:
        - [Riot Games Data Dragon](https://ddragon.leagueoflegends.com) - API officielle
        - [Documentation LoL](https://developer.riotgames.com) - Formules et spécifications

        **Disclaimer légal**:
        Cette application n'est pas officiellement approuvée par Riot Games.
        League of Legends est une marque déposée de Riot Games, Inc.

        **Politique de données**:
        - Aucune donnée personnelle collectée
        - Pas de tracking utilisateur
        - Cache local uniquement
        - Code open-source disponible
        """)

    with tab4:
        st.markdown("""
        ### 🛠️ Technologies Utilisées

        **Backend & Calculs**
        - **Python 3.9+** - Langage principal
        - **Pandas** - Manipulation et analyse de données
        - **NumPy** - Calculs numériques et matrices
        - **Requests** - Communication avec APIs

        **Interface & Visualisations**
        - **Streamlit** - Framework web interactif
        - **Plotly** - Graphiques et visualisations avancées
        - **CSS personnalisé** - Design thématique League of Legends

        **Gestion des Données**
        - **Diskcache** - Cache local haute performance
        - **JSON** - Format de stockage des configurations
        - **Riot Games Data Dragon API** - Source officielle

        ### 📈 Architecture

        ```
        LoLHelper/
        ├── app.py                 # Interface principale Streamlit
        ├── src/
        │   ├── data/             # Gestionnaires de données
        │   │   ├── champion_data.py
        │   │   ├── item_data.py
        │   │   ├── pro_drafts.py
        │   │   └── data_sources.py
        │   ├── analysis/         # Moteurs d'analyse
        │   │   ├── composition_analyzer.py
        │   │   ├── champion_item_analyzer.py
        │   │   └── advanced_comparison.py
        │   ├── recommendations/  # Système de recommandations
        │   └── visualizations/   # Graphiques et charts
        ├── data/                 # Cache et données locales
        └── requirements.txt      # Dépendances Python
        ```

        ### ⚡ Performance

        - **Cache intelligent** - Données mises en cache pour éviter les appels API répétés
        - **Calculs optimisés** - Algorithmes < 100ms pour la plupart des opérations
        - **Interface responsive** - Adaptée aux écrans desktop et mobile
        - **Mise à jour automatique** - Détection des nouvelles versions du jeu

        ### 🔧 Configuration

        Les paramètres peuvent être ajustés via:
        - Variables d'environnement (`.env`)
        - Configuration des algorithmes dans le code
        - Données de drafts personnalisées (`data/pro_drafts.json`)

        ### 📊 Métriques de Session
        """)

        # Afficher les statistiques techniques
        col1, col2 = st.columns(2)

        with col1:
            st.metric("Champions chargés", len(champion_manager.champions))
            st.metric("Items disponibles", len(item_manager.items))

        with col2:
            st.metric("Drafts analysés", len(pro_draft_analyzer.drafts))
            st.metric("Version du jeu", champion_manager.version)

        # Métriques de qualité des données
        st.markdown("#### 📋 Qualité des Données")
        quality_metrics = data_sources_manager.get_data_quality_metrics()

        st.json(quality_metrics)

# Footer
st.sidebar.markdown("---")
st.sidebar.markdown("### Statistiques de session")
st.sidebar.write(f"Champions chargés: {len(champion_manager.champions)}")
st.sidebar.write(f"Items chargés: {len(item_manager.items)}")
st.sidebar.write(f"Drafts analysés: {len(pro_draft_analyzer.drafts)}")
st.sidebar.write(f"Version du jeu: {champion_manager.version}")
