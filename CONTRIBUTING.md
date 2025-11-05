# Contributing to LoL Helper

Merci de votre intérêt pour contribuer au projet LoL Helper !

## Comment contribuer

### Rapporter des bugs

Si vous trouvez un bug, veuillez créer une issue avec:
- Une description claire du problème
- Les étapes pour reproduire le bug
- Le comportement attendu vs le comportement actuel
- Votre environnement (OS, version de Python, etc.)

### Suggérer des fonctionnalités

Les suggestions de nouvelles fonctionnalités sont les bienvenues ! Créez une issue avec:
- Une description détaillée de la fonctionnalité
- Pourquoi cette fonctionnalité serait utile
- Des exemples d'utilisation si possible

### Contribuer du code

1. **Fork le projet**
2. **Créer une branche** pour votre fonctionnalité (`git checkout -b feature/AmazingFeature`)
3. **Commit vos changements** (`git commit -m 'Add some AmazingFeature'`)
4. **Push vers la branche** (`git push origin feature/AmazingFeature`)
5. **Ouvrir une Pull Request**

### Standards de code

- Suivre les conventions PEP 8 pour Python
- Ajouter des docstrings pour les fonctions et classes
- Commenter le code complexe
- Ajouter des tests pour les nouvelles fonctionnalités

### Structure du projet

```
LoLHelper/
├── src/
│   ├── data/              # Modules de récupération de données
│   ├── analysis/          # Modules d'analyse
│   ├── recommendations/   # Système de recommandations
│   └── visualizations/    # Graphiques et visualisations
├── tests/                 # Tests unitaires
├── data/                  # Données et cache
└── app.py                 # Application Streamlit principale
```

### Ajouter des données de drafts

Pour enrichir la base de données de drafts professionnels, modifiez `data/pro_drafts.json`:

```json
{
  "blue_team": {
    "picks": ["Champion1", "Champion2", "Champion3", "Champion4", "Champion5"],
    "bans": ["BannedChamp1", "BannedChamp2", "BannedChamp3", "BannedChamp4", "BannedChamp5"]
  },
  "red_team": {
    "picks": ["Champion6", "Champion7", "Champion8", "Champion9", "Champion10"],
    "bans": ["BannedChamp6", "BannedChamp7", "BannedChamp8", "BannedChamp9", "BannedChamp10"]
  },
  "winner": "blue",
  "match_duration": 1800
}
```

## Questions ?

N'hésitez pas à ouvrir une issue pour toute question !

## Code of Conduct

Soyez respectueux et constructif dans vos interactions avec la communauté.
