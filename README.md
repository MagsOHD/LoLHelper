# LoL Team Composition Helper

Un outil d'aide à la création de compositions d'équipe pour League of Legends, basé sur les statistiques, les drafts professionnels et l'analyse prédictive.

## Fonctionnalités

- **Analyse de compositions** : Évaluation des forces et faiblesses d'une composition
- **Recommandations intelligentes** : Suggestions de picks basées sur les probabilités et les synergies
- **Statistiques détaillées** : Graphiques et données sur les champions et leurs performances
- **Analyse de draft** : Prédictions basées sur les drafts professionnels existants
- **Interface moderne** : Interface web intuitive et responsive

## Technologies

- **Python 3.9+** : Langage principal
- **Streamlit** : Framework web pour l'interface utilisateur
- **Pandas** : Manipulation et analyse de données
- **Plotly** : Visualisations interactives
- **Riot Games API** : Données des champions et statistiques

## Installation

```bash
# Cloner le repository
git clone https://github.com/MagsOHD/LoLHelper.git
cd LoLHelper

# Créer un environnement virtuel
python -m venv venv
source venv/bin/activate  # Sur Windows: venv\Scripts\activate

# Installer les dépendances
pip install -r requirements.txt
```

## Utilisation

```bash
# Lancer l'application
streamlit run app.py
```

L'application sera accessible à l'adresse `http://localhost:8501`

## Structure du projet

```
LoLHelper/
├── app.py                  # Point d'entrée de l'application
├── src/
│   ├── data/              # Récupération et gestion des données
│   ├── analysis/          # Modules d'analyse des compositions
│   ├── recommendations/   # Système de recommandations
│   └── visualizations/    # Graphiques et visualisations
├── data/                  # Données locales et cache
└── tests/                 # Tests unitaires
```

## Configuration

Créez un fichier `.env` à la racine du projet pour configurer l'API Riot Games (optionnel):

```
RIOT_API_KEY=votre_clé_api
```

## Licence

MIT
