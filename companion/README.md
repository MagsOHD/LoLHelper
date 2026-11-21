# LoLHelper – compagnon « Draft en direct » (Windows)

Petit programme à lancer sur votre PC pendant que vous jouez. Il **lit** la sélection des champions dans
le client League of Legends et l'envoie au site LoLHelper de votre groupe. La page **Draft** du site
affiche alors automatiquement les picks, bans et survols de votre équipe, ainsi que les champions
adverses, et propose des conseils de draft à vos amis.

- Aucune installation et aucun droit administrateur : deux fichiers, un double-clic.
- Lecture seule : le programme ne clique sur rien, ne choisit, ne bannit et ne verrouille rien à votre place.
- Fonctionne avec Windows PowerShell 5.1 (inclus dans Windows 10 et 11) et avec PowerShell 7.

## Installation

1. Sur le site, page **Draft**, cliquez sur « Télécharger le programme compagnon (Windows) » et
   récupérez les **deux** fichiers :
   - `Lancer-LoLHelper-Draft.bat`
   - `lolhelper-draft.ps1`
2. Rangez-les **dans le même dossier** (par exemple `Documents\LoLHelper`).
3. Double-cliquez sur `Lancer-LoLHelper-Draft.bat`.

Si Windows affiche « Windows a protégé votre ordinateur » (SmartScreen), cliquez sur
« Informations complémentaires » puis « Exécuter quand même ». Vous pouvez aussi, avant le premier
lancement, faire clic droit sur chaque fichier → **Propriétés** → cocher **Débloquer** → OK.

## Premier lancement

Le programme pose deux questions :

1. **Adresse du site** : celle que vous ouvrez dans le navigateur, par exemple
   `https://mon-domaine.fr/lolhelper` (vous pouvez coller l'adresse d'une page du site, elle est nettoyée).
   Le programme vérifie que le site répond.
2. **Mot de passe du site** : le mot de passe partagé du groupe (la saisie est masquée). Il est vérifié
   auprès du site.

Ces réglages sont enregistrés dans `%APPDATA%\LoLHelper\config.json`. Le mot de passe y est **chiffré
avec DPAPI** (protection de Windows) : seul votre compte Windows, sur ce PC, peut le relire.

Pour changer d'adresse ou de mot de passe, relancez avec l'option `-Reset` : ouvrez une invite de
commandes dans le dossier et tapez

```
Lancer-LoLHelper-Draft.bat -Reset
```

(ou supprimez simplement le fichier `%APPDATA%\LoLHelper\config.json`).

## Utilisation

Laissez la fenêtre ouverte pendant vos parties (avant ou après le lancement du client League, peu
importe). Elle affiche :

- le compte League connecté et si le site est joignable ;
- l'heure et le contenu de chaque envoi (« Envoyé au site : phase ban_pick – 2 champion(s) allié(s)… ») ;
- les problèmes éventuels (client fermé, site injoignable, mot de passe refusé…).

Le programme vérifie le client toutes les 5 secondes, puis **chaque seconde** pendant la sélection des
champions, et n'envoie quelque chose au site **que lorsque la draft change**. À la fin de la sélection
(partie lancée ou dodge), il envoie un dernier message « fin de sélection » pour que la page arrête
d'afficher la draft en direct. Il supporte la fermeture et le redémarrage du client.

**Ctrl+C** (ou fermer la fenêtre) pour quitter.

Au démarrage, la fenêtre affiche « Connecté au client League : compte Nom#TAG ». Le site vous reconnaît
par cet **identifiant Riot** (nom#tag, majuscules et minuscules indifférentes) : il doit figurer dans la
liste des joueurs du site (page Équipe), sinon le site refuse les envois avec le message « Le compte
Nom#TAG n'est pas dans la liste des joueurs du site. ».

## Confidentialité : ce qui est envoyé

Uniquement vers **votre** site LoLHelper (`<site>/api/index.php?r=live-draft`, protégé par le mot de
passe du groupe), en HTTPS avec la vérification normale du certificat du site :

- l'identifiant Riot (nom#tag) du compte connecté et son identifiant interne au client (puuid), qui
  permettent au site de savoir quel joueur envoie ;
- pour votre équipe : la position de chaque joueur, son champion choisi ou survolé, l'identifiant
  interne fourni par le client et, **seulement quand le client League affiche son nom** (vous-même,
  les membres de votre groupe), le nom#tag du coéquipier. Le site s'en sert pour reconnaître vos amis :
  il ne garde que le lien vers le joueur du site et **supprime** tous les noms et identifiants avant
  d'enregistrer (le nom d'un coéquipier qui n'est pas dans la liste des joueurs n'est jamais conservé) ;
- pour l'équipe adverse : les champions, et **seulement si le client League affiche lui-même
  l'équipe adverse** (voir ci-dessous) l'identifiant et le nom#tag de chaque adversaire, tels que le
  client les montre ;
- les bannissements, la liste des actions de la draft (ban/pick, champion, terminé ou non), la file
  (ex. 420 = classée solo/duo), la phase et le temps restant.

Rien d'autre n'est envoyé : aucun nom que le client masque (en classée solo/duo, les joueurs hors de
votre groupe restent anonymes), pas de chat, pas d'historique, pas de fichiers. Les données
envoyées sont visibles par les membres du groupe sur le site pendant 15 minutes au plus.

### Adversaires : quand sont-ils visibles ?

- **Partie classée ou normale** : le client League masque les joueurs adverses pendant la sélection
  des champions. Le programme n'envoie alors **rien** qui les identifie : pour chaque adversaire, seuls
  sa cellule et son champion partent, avec un puuid vide (`""`).
- **Clash, tournoi, partie personnalisée** : le client League montre lui-même l'équipe adverse. Le
  programme transmet le nom#tag affiché (et l'identifiant fourni par le client) pour que le site
  affiche le profil de vos adversaires.

Un nom n'est envoyé que si le client l'affiche : `gameName` et `tagLine` non vides et, quand le client
indique `nameVisibilityType`, la valeur `VISIBLE` (toute autre valeur = masqué). Le programme ne cherche
**jamais** à retrouver un joueur masqué : aucun autre champ (identifiant d'invocateur, identifiant
masqué) ni aucun autre endpoint n'est utilisé pour cela.

## À propos de Riot Games

Le programme utilise l'API locale du client League (« LCU »), qui n'est pas une API officielle de
Riot Games. Il se limite à des **lectures** (`GET`) de trois informations : le compte connecté, la
phase du client et la sélection des champions (plus la file de la partie). Il n'automatise **aucune**
action (pas de choix, ban ou verrouillage automatique, pas d'acceptation de partie) et ne contourne
pas le masquage des noms en sélection des champions (seuls les noms que le client affiche lui-même
sont transmis). Ce projet n'est ni
approuvé ni soutenu par Riot Games.

## En cas de problème

| Message | Que faire |
| --- | --- |
| « En attente du client League of Legends » | Lancez le client. S'il est installé ailleurs que `C:\Riot Games\League of Legends`, le programme le retrouve normalement via son processus ; sinon passez son fichier `lockfile` avec `-LockfilePath "D:\Jeux\League of Legends\lockfile"`. |
| « Client League détecté mais illisible » | Le client a été lancé en administrateur : relancez-le normalement, ou indiquez `-LockfilePath`. |
| « Le site refuse le mot de passe » | Le mot de passe du groupe a changé : `Lancer-LoLHelper-Draft.bat -Reset`. |
| « Client League en cours de démarrage » | Normal pendant quelques secondes après le lancement du client. |
| « Le client League est lancé mais ne fournit pas votre identifiant Riot » | Redémarrez le client League. Si le message reste affiché, lancez le mode diagnostic (ci-dessous) et transmettez le fichier. |
| « Le compte Nom#TAG n'est pas dans la liste des joueurs du site » | Ajoutez ce compte (même nom#tag) sur la page Équipe du site. |
| « Le site ne connaît pas la draft en direct » | Le site doit être mis à jour (version avec la page Draft). |
| « Site injoignable » | Vérifiez votre connexion et l'adresse du site ; le programme réessaie tout seul. |
| La fenêtre se ferme ou rien ne se lance | Votre entreprise/école bloque peut-être PowerShell par stratégie de groupe ; utilisez un PC personnel. |

Lancement manuel, sans le `.bat` :

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\lolhelper-draft.ps1 [-Reset] [-Diagnostic] [-LockfilePath <chemin>] [-ConfigPath <chemin>]
```

### Mode diagnostic

Si le programme ne vous reconnaît pas ou reste bloqué sur un message, lancez-le avec `-Diagnostic` :

```
Lancer-LoLHelper-Draft.bat -Diagnostic
```

Il fonctionne normalement et écrit en plus, toutes les quelques secondes, le fichier
`%TEMP%\lolhelper-diagnostic.json` (son chemin exact s'affiche dans la fenêtre). Ce fichier contient
les réponses brutes du client League : le compte connecté (`/lol-summoner/v1/current-summoner`), la
phase du client (`/lol-gameflow/v1/gameflow-phase`) et la dernière sélection des champions vue
(`/lol-champ-select/v1/session`), ainsi que ce que le programme en a compris (identifiant Riot lu,
puuid accepté ou non).

Avant d'être écrit, le fichier est **anonymisé** : pour tous les **autres** joueurs, chaque identifiant
(puuid, summonerId, obfuscatedPuuid, accountId…) et chaque pseudo (gameName, tagLine…) non vide est
remplacé par `<masqué>` ; les secrets de la discussion de sélection (jeton, mot de passe du salon)
aussi. Seuls votre propre compte (nom#tag, identifiants) et les informations de jeu (champions, bans,
chrono) restent lisibles. Rien n'est envoyé : c'est à vous de transmettre ce fichier à
l'administrateur du site si vous le souhaitez. Fermez le programme et relancez-le sans `-Diagnostic`
pour arrêter.

## Détails techniques

- Connexion au client : fichier `lockfile` (`C:\Riot Games\League of Legends\lockfile`, ou chemin donné),
  sinon ligne de commande du processus `LeagueClientUx.exe` (`--app-port`, `--remoting-auth-token`) ;
  appels sur `https://127.0.0.1:<port>` avec l'authentification `riot:<jeton>`.
- Endpoints lus : `/lol-summoner/v1/current-summoner`, `/lol-gameflow/v1/gameflow-phase`,
  `/lol-champ-select/v1/session`, et `/lol-gameflow/v1/session` (numéro de file, une fois par draft).
- Le client League utilise un certificat auto-signé. Il est accepté **uniquement** pour les appels vers
  `https://127.0.0.1` : sous Windows PowerShell 5.1 par un rappel de validation qui vérifie l'adresse
  de chaque requête (toute autre adresse garde la validation normale de Windows), sous PowerShell 7 par
  `-SkipCertificateCheck` sur les seuls appels au client. Les appels au site ne contournent jamais la
  validation TLS.
- Format envoyé : `CompanionPayload` version 2 (voir `public/api/lib/live.php`), `PUT r=live-draft` avec
  l'en-tête `X-App-Password`. Le puuid du client League (format UUID) n'est **pas** celui de l'API Riot
  (chiffré, propre à chaque clé) : le site reconnaît donc les joueurs par `riot_id`
  (`{"game_name": …, "tag_line": …}`), puis par égalité exacte du puuid à défaut. Les payloads version 1
  des anciens compagnons restent acceptés.

### Tests (développeurs)

Sous Linux avec PowerShell 7 (`pwsh`), PHP, Python 3 et OpenSSL :

```
bash companion/tests/run.sh             # tests unitaires + intégration avec un faux site
SITE=real bash companion/tests/run.sh   # intégration avec la vraie API PHP (copie de public/)
```

Le test d'intégration lance un faux client League HTTPS (`tests/fake_lcu.py`, certificat auto-signé,
scénario chronométré dans `tests/fixtures/scenario-*.json`, redémarrage du client avec un nouveau port,
draft classée aux adversaires masqués puis draft Clash aux adversaires révélés), pilote l'assistant de
configuration par l'entrée standard et vérifie chaque envoi (noms masqués jamais envoyés, nom#tag du
partenaire de groupe et des adversaires de Clash transmis, identifiant Riot absent signalé) ainsi que le
fichier de diagnostic (identités des autres joueurs masquées). Sous Windows, les
tests unitaires seuls : `powershell -NoProfile -ExecutionPolicy Bypass -File companion\tests\unit.ps1`.

Les fichiers `lolhelper-draft.ps1` et `Lancer-LoLHelper-Draft.bat` sont copiés dans `public/companion/`
pour être téléchargeables depuis le site : après une modification, recopiez-les.
