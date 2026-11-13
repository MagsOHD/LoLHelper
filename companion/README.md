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

Important : votre compte Riot doit figurer dans la liste des joueurs du site (page Équipe, avec son
identifiant Riot), sinon le site refuse les envois avec le message « Ce compte Riot n'est pas dans la
liste des joueurs du site. ».

## Confidentialité : ce qui est envoyé

Uniquement vers **votre** site LoLHelper (`<site>/api/index.php?r=live-draft`, protégé par le mot de
passe du groupe), en HTTPS avec la vérification normale du certificat du site :

- l'identifiant Riot (puuid) du compte connecté, qui permet au site de savoir quel joueur envoie ;
- pour votre équipe : la position de chaque joueur, son champion choisi ou survolé, et le puuid des
  coéquipiers lorsque le client le fournit (le site s'en sert pour reconnaître vos amis) ;
- pour l'équipe adverse : les champions, et **seulement si le client League affiche lui-même
  l'équipe adverse** (voir ci-dessous) le puuid de chaque adversaire, tel que le client le fournit ;
  jamais de pseudo ;
- les bannissements, la liste des actions de la draft (ban/pick, champion, terminé ou non), la file
  (ex. 420 = classée solo/duo), la phase et le temps restant.

Rien d'autre n'est envoyé : pas de pseudo (le vôtre s'affiche seulement dans la fenêtre), pas de
chat, pas d'historique, pas de fichiers. Les données
envoyées sont visibles par les membres du groupe sur le site pendant 15 minutes au plus.

### Adversaires : quand sont-ils visibles ?

- **Partie classée ou normale** : le client League masque les joueurs adverses pendant la sélection
  des champions. Le programme n'envoie alors **rien** qui les identifie : pour chaque adversaire, seuls
  sa cellule et son champion partent, avec un puuid vide (`""`).
- **Clash, tournoi, partie personnalisée** : le client League montre lui-même l'équipe adverse et
  fournit le puuid de chaque adversaire. Le programme transmet ce puuid (et rien d'autre : pas de
  pseudo) pour que le site affiche le profil de vos adversaires.

Le programme ne cherche **jamais** à retrouver un adversaire masqué : il n'utilise que le champ
`puuid` fourni par le client pour cet adversaire, et seulement s'il est non vide ; aucun autre champ
(identifiant d'invocateur, pseudo, identifiant masqué) ni aucun autre endpoint n'est utilisé pour cela.

## À propos de Riot Games

Le programme utilise l'API locale du client League (« LCU »), qui n'est pas une API officielle de
Riot Games. Il se limite à des **lectures** (`GET`) de trois informations : le compte connecté, la
phase du client et la sélection des champions (plus la file de la partie). Il n'automatise **aucune**
action (pas de choix, ban ou verrouillage automatique, pas d'acceptation de partie) et ne contourne
pas le masquage des adversaires en partie classée/normale (seul le puuid que le client affiche
lui-même, en Clash/tournoi/personnalisée, est transmis). Ce projet n'est ni
approuvé ni soutenu par Riot Games.

## En cas de problème

| Message | Que faire |
| --- | --- |
| « En attente du client League of Legends » | Lancez le client. S'il est installé ailleurs que `C:\Riot Games\League of Legends`, le programme le retrouve normalement via son processus ; sinon passez son fichier `lockfile` avec `-LockfilePath "D:\Jeux\League of Legends\lockfile"`. |
| « Client League détecté mais illisible » | Le client a été lancé en administrateur : relancez-le normalement, ou indiquez `-LockfilePath`. |
| « Le site refuse le mot de passe » | Le mot de passe du groupe a changé : `Lancer-LoLHelper-Draft.bat -Reset`. |
| « Ce compte Riot n'est pas dans la liste des joueurs du site » | Ajoutez ce compte (identifiant Riot) sur la page Équipe du site. |
| « Le site ne connaît pas la draft en direct » | Le site doit être mis à jour (version avec la page Draft). |
| « Site injoignable » | Vérifiez votre connexion et l'adresse du site ; le programme réessaie tout seul. |
| La fenêtre se ferme ou rien ne se lance | Votre entreprise/école bloque peut-être PowerShell par stratégie de groupe ; utilisez un PC personnel. |

Lancement manuel, sans le `.bat` :

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\lolhelper-draft.ps1 [-Reset] [-LockfilePath <chemin>] [-ConfigPath <chemin>]
```

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
- Format envoyé : `CompanionPayload` (voir `public/api/lib/live.php`), `PUT r=live-draft` avec l'en-tête
  `X-App-Password`.

### Tests (développeurs)

Sous Linux avec PowerShell 7 (`pwsh`), PHP, Python 3 et OpenSSL :

```
bash companion/tests/run.sh             # tests unitaires + intégration avec un faux site
SITE=real bash companion/tests/run.sh   # intégration avec la vraie API PHP (copie de public/)
```

Le test d'intégration lance un faux client League HTTPS (`tests/fake_lcu.py`, certificat auto-signé,
scénario chronométré dans `tests/fixtures/scenario-*.json`, redémarrage du client avec un nouveau port,
draft classée aux adversaires masqués puis draft Clash aux adversaires révélés), pilote l'assistant de
configuration par l'entrée standard et vérifie chaque envoi (puuid adverse vide en classée, puuid du
client en Clash). Sous Windows, les
tests unitaires seuls : `powershell -NoProfile -ExecutionPolicy Bypass -File companion\tests\unit.ps1`.

Les fichiers `lolhelper-draft.ps1` et `Lancer-LoLHelper-Draft.bat` sont copiés dans `public/companion/`
pour être téléchargeables depuis le site : après une modification, recopiez-les.
