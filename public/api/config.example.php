<?php
// Copier ce fichier en config.php (même dossier) puis le remplir.
// config.php n'est jamais servi au navigateur (api/.htaccess) et n'est pas versionné.
return [
    'riot_api_key' => '',          // RGAPI-...
    'riot_platform' => 'euw1',
    'app_password' => '',          // mot de passe partagé, vide = pas de protection
    'cors_origins' => [],          // seulement si l'interface est sur un autre domaine
    'data_dir' => null,            // null = dossier lolhelper-data à côté de www/
                                   // (à renseigner si le domaine pointe vers un sous-dossier de www/,
                                   // pour que le cron et le site utilisent le même dossier)

    // Statistiques méta haut elo, collectées par la tâche planifiée api/cron/collect-meta.php.
    'meta_enabled' => true,                         // false = le cron ne fait plus rien
    'meta_tiers' => ['CHALLENGER', 'GRANDMASTER'],  // paliers suivis (MASTER possible, liste longue)
    'meta_time_budget' => 600,     // secondes de travail max par passage du cron (1 à 3300)
    'meta_rate' => 0.5,            // requêtes Riot par seconde pour le cron ; la clé est partagée avec
                                   // les synchronisations (clé perso : 20/s et 100/2 min), garder de la marge
    'meta_min_games' => 300,       // parties nécessaires pour servir le nouveau patch plutôt que le précédent
];
