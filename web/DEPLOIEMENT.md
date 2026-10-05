# Mise en ligne : interface sur OVH, serveur sur Railway

L'hébergement OVH « Perso » ne sert que des fichiers statiques et du PHP : il ne
peut pas faire tourner le serveur Python. On sépare donc l'appli en deux :

| Partie | Où | Rôle |
|---|---|---|
| Interface (HTML/JS/CSS) | OVH, dossier `www/` | Ce que vous voyez dans le navigateur |
| Serveur Python + base SQLite | Railway | API Riot, moteur de compos, données |

La clé Riot reste sur Railway : elle n'est jamais envoyée aux navigateurs.
L'accès est protégé par un mot de passe partagé entre amis.

Les interfaces de Railway et d'OVH évoluent : si un intitulé a changé, cherchez
l'équivalent le plus proche.

---

## 1. Clé API Riot

Sur <https://developer.riotgames.com>, demandez une **Personal API Key**
(« Register Product » → Personal). Elle est gratuite et n'expire pas.
La clé de développement marche aussi pour essayer, mais elle expire toutes les
24 h : il faudrait la remplacer chaque jour dans Railway.

## 2. Serveur sur Railway

1. Créez un compte sur <https://railway.com> avec votre compte GitHub.
   Railway est payant à l'usage (offre « Hobby », quelques dollars par mois) : vérifiez le tarif actuel.
2. **New Project → Deploy from GitHub repo** → choisissez `MagsOHD/LoLHelper`.
3. Dans le service créé, onglet **Settings** :
   - **Source → Root Directory** : `web/backend` (Railway trouve le `Dockerfile` tout seul) ;
   - **Source → Branch** : la branche qui contient l'appli
     (`claude/lol-team-composition-tool-011CUpnwGnQdGoMzCSU3ZkdT`, ou `main` après fusion).
4. Ajoutez un **volume** au service (clic droit sur le service → *Attach volume*,
   ou bouton *+ New → Volume*) avec le chemin de montage **`/data`**.
   C'est là que vit la base SQLite : sans volume, tout est effacé à chaque redéploiement.
5. Onglet **Variables** :

   | Variable | Valeur |
   |---|---|
   | `RIOT_API_KEY` | votre clé `RGAPI-...` |
   | `RIOT_PLATFORM` | `euw1` |
   | `APP_PASSWORD` | un mot de passe à partager entre amis |
   | `CORS_ORIGINS` | l'adresse de votre site OVH, ex. `https://mon-site.fr,https://www.mon-site.fr` |

6. Onglet **Settings → Networking → Generate Domain**. Notez l'adresse obtenue,
   par exemple `https://lolhelper-production.up.railway.app`.
7. Vérifiez : ouvrez `https://<adresse-railway>/api/health` → `{"status":"ok"}`.

## 3. Interface sur OVH

### Préparer les fichiers (sur votre PC)

```bash
cd web/frontend
npm install
npm run build
```

Ouvrez ensuite `web/frontend/dist/config.js` et mettez l'adresse Railway :

```js
window.APP_CONFIG = { apiBase: "https://lolhelper-production.up.railway.app" };
```

### Envoyer les fichiers avec FileZilla

1. Installez FileZilla (client) : <https://filezilla-project.org>.
2. Connexion : hôte `ftp.cluster100.hosting.ovh.net`, utilisateur `fullstj`,
   votre mot de passe FTP, port `21`.
   Mot de passe oublié : espace client OVH → Hébergements → onglet *FTP - SSH*.
3. Activez **Serveur → Forcer l'affichage des fichiers cachés**,
   sinon le fichier `.htaccess` ne sera pas envoyé.
4. Côté serveur, ouvrez le dossier `www/`. S'il contient déjà un site,
   téléchargez-en une copie d'abord.
5. Envoyez **le contenu** de `web/frontend/dist/` dans `www/` :
   `index.html`, `config.js`, `.htaccess`, `favicon.svg` et le dossier `assets/`.

L'appli doit être à la racine du site (ou d'un sous-domaine), pas dans un sous-dossier.

### Activer le HTTPS

Espace client OVH → Hébergements → *Informations générales* → **Certificat SSL**
→ activer (Let's Encrypt, gratuit). Le mot de passe circule ainsi chiffré.

## 4. Tester

Ouvrez `https://mon-site.fr` (ordinateur ou téléphone) → écran **Accès réservé** →
entrez le mot de passe. Il est retenu sur chaque appareil.

En cas de problème :

| Symptôme | Cause probable |
|---|---|
| « Impossible de joindre le serveur » | `apiBase` incorrect dans `config.js`, ou `CORS_ORIGINS` ne contient pas l'adresse exacte du site (avec `https://`, et la version `www.` si vous l'utilisez) |
| Page blanche ou 404 en rechargeant une page | `.htaccess` non envoyé (fichiers cachés) |
| « Clé API Riot invalide ou expirée » | Clé expirée : mettez-la à jour dans Railway → Variables |
| Joueurs disparus après un redéploiement | Volume non monté sur `/data` |

## 5. Mettre à jour

- **Serveur** : chaque `git push` sur la branche choisie redéploie Railway automatiquement.
- **Interface** : relancez `npm run build`, remettez votre adresse dans `dist/config.js`,
  puis renvoyez le contenu de `dist/` par FTP.
