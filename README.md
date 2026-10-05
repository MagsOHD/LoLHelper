# Compo entre amis

Application web pour créer des compositions League of Legends entre amis, à partir de
ce que chacun **sait** jouer (maîtrises et parties récentes Riot) et de ce que chacun
**veut** jouer (rôles, types de personnage, champions). Chaque compo est accompagnée
d'un plan de jeu et d'un plan pour jouer contre l'équipe adverse.

Tout tient sur un hébergement web classique (Apache + PHP, par exemple OVH « Perso ») :
l'interface et le moteur de compositions tournent dans le navigateur, un petit script
PHP garde la clé Riot et stocke les données partagées.

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
- **Plan de jeu**, **Matchup** et **compositions sauvegardées**.
- Accès protégé par un mot de passe partagé, utilisable sur téléphone.

## Mise en ligne

Voir [`DEPLOIEMENT.md`](DEPLOIEMENT.md) (OVH : compilation, `config.php`, envoi FTP).
L'appli fonctionne à la racine du site comme dans un sous-dossier (ex. `www/lolhelper/`).

## Développement

Prérequis : Node.js 18+ (et PHP 8.1+ pour faire tourner l'API en local).

```bash
npm install
```

- **Interface seule, données fictives** (pas besoin de PHP) : `VITE_MOCK=1 npm run dev`
  (sous Windows cmd : `set VITE_MOCK=1 && npm run dev`) puis <http://localhost:5173>.
- **Avec l'API PHP** : copie `public/api/config.example.php` en `public/api/config.php`
  (clé Riot, mot de passe), puis dans deux terminaux :
  ```bash
  php -S localhost:8000 -t public   # API PHP
  npm run dev                        # interface, http://localhost:5173
  ```
  Les données locales sont écrites dans `lolhelper-data/`, à côté de `public/` (ignoré par git).

## Tests

```bash
npm test                    # moteur (comparé aux résultats de référence) + couche de données
npm run typecheck
bash php-tests/run.sh       # API PHP (avec un faux serveur Riot)
```

## Organisation

- `src/engine/` : moteur de compositions (logique pure) et données des champions
  (`data/champions_meta.json`, `archetypes.json`, `themes.json`).
- `src/api/` : couche de données (règles métier, synchronisation Riot depuis le
  navigateur avec respect des limites de requêtes, Data Dragon).
- `src/pages/`, `src/components/` : interface React.
- `public/api/` : API PHP (stockage JSON + relais Riot), copiée telle quelle dans `dist/`.

Les données de jeu (rôles, traits, conseils) sont maintenues à la main dans
`champions_meta.json` : un nouveau champion reçoit des valeurs par défaut tirées de
Data Dragon jusqu'à ce qu'on ajoute sa fiche.

Projet non affilié à Riot Games.
