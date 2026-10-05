// Adresse du site qui héberge l'API PHP (dossier api/). Laisse vide si l'interface et l'API
// sont sur le même hébergement OVH (cas normal) : les appels vont alors vers /api/index.php.
// Exemple si l'interface est servie depuis un autre domaine :
//   window.APP_CONFIG = { apiBase: "https://mon-site.fr" };
// (ajoute alors ce domaine d'interface dans 'cors_origins' de api/config.php)
window.APP_CONFIG = { apiBase: "" };
