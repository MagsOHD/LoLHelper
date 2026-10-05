// Adresse du site qui héberge l'API PHP (dossier api/). Laisse vide dans le cas normal :
// l'API est alors cherchée à côté de la page (ex. www/lolhelper/api/index.php).
// À remplir seulement si l'interface est servie depuis un autre domaine que l'API :
//   window.APP_CONFIG = { apiBase: "https://mon-site.fr/lolhelper" };
// (ajoute alors ce domaine d'interface dans 'cors_origins' de api/config.php)
window.APP_CONFIG = { apiBase: "" };
