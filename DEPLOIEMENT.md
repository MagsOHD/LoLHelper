# Mise en ligne sur OVH (hébergement Perso) dans `www/lolhelper`

Tout le site tient sur l'hébergement OVH, sans autre service. Il s'installe dans un
sous-dossier (`www/lolhelper/` → `https://votre-domaine/lolhelper/`) sans toucher au reste
de `www/`. Il fonctionne aussi à la racine de `www/` ou dans un autre dossier : remplacez
simplement `lolhelper` par le nom choisi.

| Partie | Où | Rôle |
|---|---|---|
| Interface + moteur de compositions | Navigateur de chaque ami | Pages, génération des compos, plans de jeu |
| `www/lolhelper/api/index.php` | OVH (PHP) | Garde la clé Riot, relaie les appels Riot, stocke les données |
| `lolhelper-data/` | OVH, à côté de `www/` (créé automatiquement) | Joueurs, équipes, compos, cache des parties, stats de méta — hors du site public |
| `api/cron/collect-meta.php` | OVH, tâche planifiée toutes les heures | Collecte des parties haut elo (Challenger/Grandmaster) pour la méta et les matchups |

La clé Riot n'est jamais envoyée aux navigateurs. L'accès est protégé par un mot de passe
partagé entre amis.

---

## 1. Clé API Riot

Sur <https://developer.riotgames.com>, demandez une **Personal API Key**
(« Register Product » → Personal) : gratuite, elle n'expire pas.
La clé de développement marche pour essayer, mais expire toutes les 24 h.
Sans clé, le site fonctionne en mode manuel (pool de champions saisi à la main).

## 2. Préparer les fichiers (sur votre PC, une seule fois)

Prérequis : Node.js 18+ (<https://nodejs.org>) et le code du dépôt.

1. Copiez `public/api/config.example.php` en `public/api/config.php` et remplissez-le :
   ```php
   return [
       'riot_api_key' => 'RGAPI-xxxxxxxx',
       'riot_platform' => 'euw1',
       'app_password' => 'un-mot-de-passe-entre-amis',
       'cors_origins' => [],
       'data_dir' => null,
   ];
   ```
   Ce fichier n'est pas versionné dans git ; il est recopié à chaque compilation.
2. Compilez, à la racine du dépôt :
   ```bash
   npm install
   npm run build
   ```
   Le site prêt à envoyer est dans `dist/` :
   `index.html`, `config.js`, `favicon.svg`, `.htaccess`, `assets/`, `api/`.

## 3. Version de PHP chez OVH

Espace client OVHcloud → *Web Cloud* → *Hébergements* → votre hébergement →
*Informations générales* → **Version PHP globale** : **8.1 ou plus récent** (8.3 recommandé).

## 4. Envoyer le site avec FileZilla

1. Installez FileZilla (client) : <https://filezilla-project.org>.
2. Connexion : hôte `ftp.cluster100.hosting.ovh.net`, utilisateur `fullstj`,
   votre mot de passe FTP, port `21`.
   Mot de passe oublié : espace client → Hébergements → onglet *FTP - SSH*.
3. Menu **Serveur → Forcer l'affichage des fichiers cachés** : indispensable, sinon les
   fichiers `.htaccess` ne partent pas et le dossier `api/` ne serait pas protégé.
4. Côté serveur (à droite), ouvrez `www/`, créez le dossier **`lolhelper`** (clic droit →
   *Créer un dossier*) et entrez dedans.
5. Côté PC (à gauche), ouvrez le dossier `dist/`, sélectionnez **tout son contenu**
   (y compris `.htaccess`) et glissez-le dans `www/lolhelper/`.

Le reste de `www/` n'est pas modifié.

## 5. Activer le HTTPS

Espace client → Hébergements → *Informations générales* → **Certificat SSL** → activer
(Let's Encrypt, gratuit), si ce n'est pas déjà fait.

## 6. Tester

1. Ouvrez `https://votre-domaine/lolhelper/api/index.php?r=meta` : le texte doit contenir
   `"riot_configured":true` et `"storage_ok":true`.
2. Ouvrez `https://votre-domaine/lolhelper/` (ordinateur ou téléphone) → écran
   **Accès réservé** → mot de passe (retenu ensuite sur chaque appareil).
3. Ajoutez un ami par son Riot ID : la synchronisation récupère rang, maîtrises et parties
   (quelques secondes la première fois, plus rapide ensuite grâce au cache).
4. Vérification de sécurité : `https://votre-domaine/lolhelper/api/config.php` doit
   afficher une erreur **403 Forbidden**.

Les adresses des pages ressemblent à `.../lolhelper/#/compositions` : c'est normal, et
c'est ce qui permet à l'appli de marcher dans un sous-dossier sans configuration.

| Symptôme | Cause probable |
|---|---|
| `riot_configured:false` | `api/config.php` absent ou clé vide : refaites l'étape 2 et renvoyez `dist/api/config.php` |
| `storage_ok:false` | Le dossier `lolhelper-data` n'a pas pu être créé à côté de `www/` : contactez-moi avec le message |
| Page blanche ou erreur 500 | Version PHP trop ancienne (étape 3) |
| `api/config.php` ne renvoie pas 403 | `.htaccess` non envoyés : refaites l'étape 4 avec les fichiers cachés affichés |
| « Clé API Riot invalide ou expirée » | Clé expirée : mettez à jour `public/api/config.php`, recompilez, renvoyez `api/config.php` |

## 7. Collecte de la méta (bouton et/ou tâche planifiée)

La méta (taux de victoire par champion et par rôle, bans, duels de lane) est calculée **par niveau**
(Fer, Bronze, Argent, Or, Platine, Émeraude, Diamant, Master+) à partir de parties classées solo de
votre serveur, récupérées avec votre clé Riot. Pour chaque niveau, le site garde les 500 dernières
parties du patch (`meta_games_per_tier`) : les plus récentes remplacent les plus anciennes.
Il faut une clé Riot configurée (étape 1). Les données sont communes à tous les joueurs du site :
une seule collecte sert tout le monde, et elles restent sur le serveur (les deux derniers patchs).
L'onglet **Méta** du site les affiche par niveau ; les compositions et la draft utilisent le niveau
le plus proche du rang de vos joueurs (modifiable sur la page Méta).

### Lancer la collecte depuis le site (bouton)

1. Dans `api/config.php`, ajoutez un mot de passe administrateur, différent du mot de passe
   partagé entre amis, long et difficile à deviner (le nombre d'essais n'est pas limité) :
   ```php
   'admin_password' => 'un-long-mot-de-passe-admin',
   ```
   puis renvoyez `api/config.php` par FTP. Seul ce fichier compte : le site ne lit aucun fichier
   `.env`. Accents et espaces autour du mot de passe ne posent pas de problème.
2. Onglet **Méta** → « Mettre à jour la méta » → mot de passe administrateur → **Lancer**.
   Les passes (45 s chacune) s'enchaînent tant que l'onglet reste ouvert, jusqu'à « Arrêter » ou
   jusqu'à ce que toutes les parties récentes soient collectées.

### Ou automatiquement (tâche planifiée OVH)

Pour que la méta se mette à jour toute seule, sans laisser d'onglet ouvert :

Espace client OVH → *Web Cloud* → *Hébergements* → votre hébergement → onglet
**Tâches planifiées - Cron** → **Ajouter une planification** :

| Champ | Valeur |
|---|---|
| Commande à exécuter | `www/lolhelper/api/cron/collect-meta.php` |
| Langage | PHP 8.1 ou plus récent (le même qu'à l'étape 3) |
| Activation | Activée |
| Fréquence | Toutes les heures (le script ne travaille qu'entre 4 h et 15 h et s'arrête aussitôt en dehors) |
| Alerte e-mail | au choix (utile les premiers jours) |

La collecte automatique ne tourne qu'entre **4 h et 15 h** (heure de Paris, `meta_hours`), à
**une requête toutes les 4 secondes** (`meta_rate` = 0,25), et ne dépasse jamais 60 % de la limite
de la clé : elle cède la place aux synchronisations de vos amis et attend quand Riot demande de
patienter. Sur une journée, cela fait environ 9 900 requêtes, de quoi remplir les 8 niveaux en un
à deux jours. Avant cela, l'appli fonctionne normalement avec les niveaux déjà remplis. Le bas de
page affiche ensuite « Méta : patch … · Or · N parties ».

Réglages optionnels dans `api/config.php` (voir `config.example.php`) : `meta_tiers`,
`meta_games_per_tier`, `meta_hours`, `timezone`, `meta_rate`, `meta_time_budget`, `meta_enabled`.
**Si votre `config.php` vient d'une ancienne version**, supprimez les lignes `meta_rate`,
`meta_time_budget` et `meta_tiers` pour profiter des nouvelles valeurs par défaut (`'meta_rate' =>
'auto'` en particulier garde l'ancien rythme rapide). Les parties déjà collectées sont conservées
et rangées dans le niveau Master+.

Si votre nom de domaine pointe directement sur `www/lolhelper/` (et non sur `www/`), renseignez
`'data_dir'` avec un chemin absolu dans `config.php`, pour que le site et la tâche planifiée
utilisent le même dossier de données.

| Symptôme | Cause probable |
|---|---|
| Pas de ligne « Méta » en bas de page après une journée | Tâche planifiée absente ou désactivée, ou clé Riot manquante/expirée (voir les journaux de la tâche dans l'espace OVH) |
| Les journaux indiquent « clé invalide » | Clé de développement expirée : passez à une Personal API Key |

## 8. Draft en direct et programme compagnon

Le bouton **Draft** d'un joueur ou d'une équipe (page Équipe) ouvre la draft en direct :
picks et bans saisis par n'importe quel ami sont partagés, et l'appli conseille 3 à 5 champions
à chaque ami qui n'a pas encore pické, des bans, et lit les forces et faiblesses de l'équipe adverse.
Rien à configurer côté OVH : ça fonctionne dès l'envoi du site (étape 4).

Pour remplir la draft automatiquement, chaque ami peut lancer sur son PC Windows le
**programme compagnon** (lecture seule du client League, rien à installer) :

1. Sur la page Draft, section « Programme compagnon (Windows) », téléchargez
   `Lancer-LoLHelper-Draft.bat` et `lolhelper-draft.ps1` dans un même dossier
   (ils sont aussi dans le dépôt, dossier `companion/`, avec un mode d'emploi détaillé).
2. Double-cliquez sur `Lancer-LoLHelper-Draft.bat`. Au premier lancement, indiquez l'adresse du
   site (`https://votre-domaine/lolhelper`) et le mot de passe partagé.
3. Laissez la fenêtre ouverte pendant vos parties : pendant la sélection des champions, la page
   Draft se remplit toute seule (badge « Client »).

Le compte League du PC doit correspondre à un joueur déjà ajouté sur le site (même Riot ID)
et synchronisé avec la clé Riot (un joueur créé en mode manuel, sans clé, n'est pas reconnu).
Le programme n'envoie que les champions et les rôles ; l'identité des adversaires n'est jamais
lue ni envoyée (Riot la masque pendant la draft). Une fois la partie lancée, le bouton
« Détecter la partie » de la page Draft récupère l'équipe adverse via l'API Riot officielle.

## 9. Mettre à jour et sauvegarder

- **Mise à jour** : `npm run build`, puis renvoyez le contenu de `dist/` dans
  `www/lolhelper/` en écrasant les anciens fichiers (FileZilla demande : *Écraser*).
  Vous pouvez ensuite supprimer les anciens fichiers de `www/lolhelper/assets/` qui ne sont
  plus dans `dist/assets/` (sans conséquence si vous les laissez).
  Les données (`lolhelper-data/`) ne sont jamais touchées par une mise à jour.
- **Sauvegarde** : téléchargez de temps en temps le dossier `lolhelper-data/` (à côté de
  `www/`) : `players.json`, `teams.json`, `saved.json` et le cache des parties.
