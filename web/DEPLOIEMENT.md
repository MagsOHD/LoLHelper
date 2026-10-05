# Mise en ligne sur OVH (hébergement Perso)

Tout le site tient sur l'hébergement OVH, sans autre service :

| Partie | Où elle tourne | Rôle |
|---|---|---|
| Interface + moteur de compositions | Navigateur de chaque ami | Pages, génération des compos, plans de jeu |
| `api/index.php` | OVH (PHP) | Garde la clé Riot, relaie les appels Riot, stocke joueurs/équipes/compos |
| Dossier `lolhelper-data/` | OVH, à côté de `www/` (hors du site public) | Données partagées et cache des parties |

La clé Riot n'est jamais envoyée aux navigateurs. L'accès est protégé par un mot de passe
partagé entre amis.

---

## 1. Clé API Riot

Sur <https://developer.riotgames.com>, demandez une **Personal API Key**
(« Register Product » → Personal) : gratuite, elle n'expire pas.
La clé de développement marche pour essayer, mais expire toutes les 24 h.
Sans clé, le site fonctionne en mode manuel (pool de champions saisi à la main).

## 2. Préparer les fichiers (sur votre PC)

Prérequis : Node.js 18+ (<https://nodejs.org>).

1. Copiez `web/frontend/public/api/config.example.php` en
   `web/frontend/public/api/config.php` et remplissez-le :
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
2. Compilez :
   ```bash
   cd web/frontend
   npm install
   npm run build
   ```
   Le site prêt à envoyer est dans `web/frontend/dist/`
   (`index.html`, `config.js`, `.htaccess`, `assets/`, `api/`…).

## 3. Version de PHP chez OVH

Espace client OVHcloud → *Web Cloud* → *Hébergements* → votre hébergement →
*Informations générales* → **Version PHP globale** : choisissez **8.1 ou plus récent**
(8.3 recommandé).

## 4. Envoyer le site avec FileZilla

1. Installez FileZilla (client) : <https://filezilla-project.org>.
2. Connexion : hôte `ftp.cluster100.hosting.ovh.net`, utilisateur `fullstj`,
   votre mot de passe FTP, port `21`.
   Mot de passe oublié : espace client → Hébergements → onglet *FTP - SSH*.
3. Activez **Serveur → Forcer l'affichage des fichiers cachés**
   (sinon les fichiers `.htaccess` ne partent pas, et `api/` ne serait pas protégé).
4. Ouvrez le dossier `www/` côté serveur. S'il contient déjà un site, téléchargez-en
   une copie d'abord.
5. Envoyez **le contenu** de `web/frontend/dist/` dans `www/`.

Le site doit être à la racine de `www/` (ou d'un sous-domaine), pas dans un sous-dossier.

## 5. Activer le HTTPS

Espace client → Hébergements → *Informations générales* → **Certificat SSL** → activer
(Let's Encrypt, gratuit). Le mot de passe circule ainsi chiffré.

## 6. Tester

1. Ouvrez `https://votre-domaine/api/index.php?r=meta` : vous devez voir un texte qui
   commence par `{"riot_configured":true` et contient `"storage_ok":true`.
2. Ouvrez `https://votre-domaine` (ordinateur ou téléphone) → écran **Accès réservé** →
   mot de passe. Il est retenu sur chaque appareil.
3. Ajoutez un ami par son Riot ID : la synchronisation récupère rang, maîtrises et
   parties (quelques secondes la première fois, plus rapide ensuite grâce au cache).

| Symptôme | Cause probable |
|---|---|
| `riot_configured:false` | `api/config.php` absent ou clé vide (refaites l'étape 2 puis renvoyez `api/config.php`) |
| `storage_ok:false` | Droits d'écriture : vérifiez que le dossier `lolhelper-data` (à côté de `www/`) peut être créé |
| Page blanche, erreur 500 | Version PHP trop ancienne (étape 3) |
| Page 404 en rechargeant une page | `.htaccess` non envoyé (fichiers cachés) |
| « Clé API Riot invalide ou expirée » | Clé expirée : mettez à jour `api/config.php` et renvoyez-le |
| `https://votre-domaine/api/config.php` affiche quelque chose | `api/.htaccess` non envoyé : renvoyez-le (fichiers cachés) |

## 7. Mettre à jour et sauvegarder

- **Mise à jour** : `npm run build` puis renvoyez le contenu de `dist/` dans `www/`
  (votre `config.php` est recopié automatiquement depuis `public/api/`).
- **Sauvegarde** : téléchargez par FTP le dossier `lolhelper-data/` (situé à côté de `www/`).
  Il contient `players.json`, `teams.json`, `saved.json` et le cache des parties.
