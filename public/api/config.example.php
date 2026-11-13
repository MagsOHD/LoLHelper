<?php
// Copier ce fichier en config.php (même dossier) puis le remplir.
// config.php n'est jamais servi au navigateur (api/.htaccess) et n'est pas versionné.
return [
    'riot_api_key' => '',          // RGAPI-...
    'riot_platform' => 'euw1',
    'app_password' => '',          // mot de passe partagé, vide = pas de protection
    'admin_password' => '',        // mot de passe administrateur, nécessaire pour lancer la collecte méta
                                   // depuis le site (page Méta) ; différent du mot de passe partagé.
                                   // Vide = bouton de collecte désactivé.
    'cors_origins' => [],          // seulement si l'interface est sur un autre domaine
    'data_dir' => null,            // null = dossier lolhelper-data à côté de www/
                                   // (à renseigner si le domaine pointe vers un sous-dossier de www/,
                                   // pour que le cron et le site utilisent le même dossier)

    // Statistiques méta haut elo, collectées par la tâche planifiée api/cron/collect-meta.php.
    'meta_enabled' => true,                         // false = le cron ne fait plus rien
    'meta_tiers' => ['CHALLENGER', 'GRANDMASTER', 'MASTER'],  // paliers suivis
    'meta_time_budget' => 1500,    // secondes de travail max par passage du cron (1 à 3300), 25 min
    'meta_rate' => 0.6,            // requêtes Riot par seconde pour le cron ; la clé est partagée avec
                                   // les synchronisations (clé perso : 20/s et 100/2 min), garder de la marge
    'meta_web_budget' => 45,       // secondes de travail max par clic sur « Lancer » depuis le site (5 à 120) ;
                                   // rester sous la limite d'exécution PHP de l'hébergeur
    'meta_min_games' => 300,       // parties nécessaires pour servir le nouveau patch plutôt que le précédent
];
