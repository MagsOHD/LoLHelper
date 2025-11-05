"""
Tests basiques pour vérifier le fonctionnement des modules.
"""

import sys
import os

# Ajouter le répertoire parent au path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.data.champion_data import ChampionDataManager
from src.data.pro_drafts import ProDraftAnalyzer
from src.analysis.composition_analyzer import CompositionAnalyzer

def test_champion_loading():
    """Test le chargement des champions."""
    print("Test: Chargement des champions...")
    manager = ChampionDataManager()
    champions = manager.load_champions()

    assert len(champions) > 0, "Aucun champion chargé"
    print(f"✅ {len(champions)} champions chargés avec succès")

    # Tester la récupération d'un champion spécifique
    ahri = manager.get_champion_by_id('Ahri')
    assert ahri is not None, "Champion Ahri non trouvé"
    print(f"✅ Champion trouvé: {ahri['name']}")

def test_composition_analysis():
    """Test l'analyse de composition."""
    print("\nTest: Analyse de composition...")
    manager = ChampionDataManager()
    manager.load_champions()

    analyzer = CompositionAnalyzer()

    # Créer une composition de test
    test_comp = []
    champion_ids = ['Aatrox', 'LeeSin', 'Ahri', 'Jinx', 'Thresh']

    for champ_id in champion_ids:
        champ = manager.get_champion_by_id(champ_id)
        if champ:
            test_comp.append(champ)

    if len(test_comp) == 5:
        analysis = analyzer.analyze_composition(test_comp)

        assert 'overall_score' in analysis, "Score global manquant"
        assert 'grade' in analysis, "Grade manquant"

        print(f"✅ Analyse complète - Score: {analysis['overall_score']}/100, Grade: {analysis['grade']}")
    else:
        print("⚠️ Impossible de créer une composition complète pour le test")

def test_pro_drafts():
    """Test l'analyseur de drafts pro."""
    print("\nTest: Analyse des drafts pro...")
    analyzer = ProDraftAnalyzer()

    assert len(analyzer.drafts) > 0, "Aucun draft chargé"
    print(f"✅ {len(analyzer.drafts)} drafts chargés")

    # Test des statistiques
    df = analyzer.get_stats_dataframe()
    assert not df.empty, "DataFrame vide"
    print(f"✅ Statistiques générées pour {len(df)} champions")

if __name__ == "__main__":
    print("=" * 50)
    print("Tests LoL Helper")
    print("=" * 50)

    try:
        test_champion_loading()
        test_composition_analysis()
        test_pro_drafts()

        print("\n" + "=" * 50)
        print("✅ Tous les tests sont passés avec succès!")
        print("=" * 50)

    except Exception as e:
        print(f"\n❌ Erreur lors des tests: {e}")
        import traceback
        traceback.print_exc()
