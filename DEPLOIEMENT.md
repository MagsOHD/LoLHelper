# Mise en ligne sur OVH (hébergement Perso) dans `www/lolhelper`

Tout le site tient sur l'hébergement OVH, sans autre service. Il s'installe dans un
sous-dossier (`www/lolhelper/` → `https://votre-domaine/lolhelper/`) sans toucher au reste
de `www/`. Il fonctionne aussi à la racine de `www/` ou dans un autre dossier : remplacez
simplement `lolhelper` par le nom choisi.

| Partie | Où | Rôle |
|---|---|---|
| Interface + moteur de compositions | Navigateur de chaque ami | Pages, génération des compos, plans de jeu |
| `www/lolhelper/api/index.php` | OVH (PHP) | Garde la clé Riot, relaie les appels Riot, stocke les données |
| `lolhelper-data/` | OVH, à côté de `www/` (créé automatiquement) | Joueurs, équipes, compos, cache des parties — hors du site public |

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

## 7. Mettre à jour et sauvegarder

- **Mise à jour** : `npm run build`, puis renvoyez le contenu de `dist/` dans
  `www/lolhelper/` en écrasant les anciens fichiers (FileZilla demande : *Écraser*).
  Vous pouvez ensuite supprimer les anciens fichiers de `www/lolhelper/assets/` qui ne sont
  plus dans `dist/assets/` (sans conséquence si vous les laissez).
  Les données (`lolhelper-data/`) ne sont jamais touchées par une mise à jour.
- **Sauvegarde** : téléchargez de temps en temps le dossier `lolhelper-data/` (à côté de
  `www/`) : `players.json`, `teams.json`, `saved.json` et le cache des parties.
