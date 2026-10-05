<?php
// Copier ce fichier en config.php (même dossier) puis le remplir.
// config.php n'est jamais servi au navigateur (api/.htaccess) et n'est pas versionné.
return [
    'riot_api_key' => '',          // RGAPI-...
    'riot_platform' => 'euw1',
    'app_password' => '',          // mot de passe partagé, vide = pas de protection
    'cors_origins' => [],          // seulement si l'interface est sur un autre domaine
    'data_dir' => null,            // null = dossier lolhelper-data à côté de www/
];
