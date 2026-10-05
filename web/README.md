# Compo entre amis — version web

Application web pour créer des compositions League of Legends entre amis, à partir de
ce que chacun **sait** jouer (maîtrises et parties récentes Riot) et de ce que chacun
**veut** jouer (rôles, types de personnage, champions). Chaque compo est accompagnée
d'un plan de jeu et d'un plan pour jouer contre l'équipe adverse.

## Fonctionnalités

- **Équipe** : ajoute tes amis par Riot ID (`Nom#TAG`) ; profil, rang, maîtrises et
  20 dernières parties récupérés via l'API Riot. Regroupe jusqu'à 5 joueurs en équipe.
- **Préférences** par joueur : rôles préférés (ordonnés), types de personnage voulus
  (Tank engage, Assassin, Enchanteur…), champions voulus ou à éviter.
- **Pool** : calculé automatiquement (confort = maîtrise + parties récentes, envie =
  préférences) et complétable à la main.
- **Compositions** : 9 styles de jeu (Engage, Pick, Poke & siège, Protect the carry,
  Split push, Dive, Early, Scaling, Escarmouches) et 19 thèmes fun (Yordles, Néant,
  Noxus, Full AP, Liens de lore…). Options : rôles imposés, champions verrouillés,
  bans, champions adverses, curseur « rester sur nos champions ↔ découvrir ».
- **Plan de jeu** : conditions de victoire, déroulé early/mid/late, pics de puissance,
  combos, objectifs, conseils par rôle, erreurs à éviter.
- **Matchup** : identité et plan de l'équipe adverse, comment gagner, menaces,
  face-à-face par lane, objectifs, bans conseillés.
- **Sauvegardées** : garde tes compos favorites.

## Installation

Prérequis : Python 3.11+ et Node.js 18+.

```bash
# Backend
cd web/backend
pip install -r requirements.txt
cp .env.example .env        # puis renseigne RIOT_API_KEY

# Frontend
cd ../frontend
npm install
```

### Clé API Riot

Crée une clé sur <https://developer.riotgames.com> et mets-la dans `web/backend/.env`
(`RIOT_API_KEY=RGAPI-...`). Une clé de développement **expire toutes les 24 h** ; pour
un usage durable, demande une « Personal API Key » sur le même site.
Sans clé, l'application fonctionne en mode manuel : tu saisis le pool de chaque joueur.

Règle aussi `RIOT_PLATFORM` (par défaut `euw1`).

## Lancer

Développement (deux terminaux) :

```bash
cd web/backend && uvicorn app.main:app --reload --port 8000
cd web/frontend && npm run dev     # http://localhost:5173
```

Production (un seul serveur) :

```bash
cd web/frontend && npm run build
cd ../backend && uvicorn app.main:app --host 0.0.0.0 --port 8000   # http://localhost:8000
```

Pour tester l'interface sans backend : `VITE_MOCK=1 npm run dev`.

## Tests

```bash
cd web/backend && python -m pytest tests -q
cd web/frontend && npm run typecheck
```

## Organisation

- `backend/app/engine/` : moteur de compositions (logique pure) et données des
  champions (`data/champions_meta.json`, `archetypes.json`, `themes.json`).
- `backend/app/riot/` : clients API Riot (limites de requêtes, cache des parties) et Data Dragon.
- `backend/app/routes/` : API REST (`/api/...`).
- `frontend/` : interface React + TypeScript.

Les données de jeu (rôles, traits, conseils) sont maintenues à la main dans
`champions_meta.json` : un nouveau champion reçoit des valeurs par défaut tirées de
Data Dragon jusqu'à ce qu'on ajoute sa fiche.

Projet non affilié à Riot Games.
