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

    // Statistiques méta par niveau de classement, collectées par la tâche planifiée api/cron/collect-meta.php
    // (toutes les heures) et par le bouton « Lancer » de la page Méta.
    'meta_enabled' => true,        // false = le cron ne fait plus rien
    'meta_tiers' => ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER_PLUS'],
                                   // niveaux suivis (ligne absente = les 8), servis à tour de rôle.
                                   // MASTER_PLUS = Master, Grandmaster et Challenger. Anciennes valeurs
                                   // 'CHALLENGER', 'GRANDMASTER', 'MASTER' acceptées : elles deviennent MASTER_PLUS
                                   // (en ne lisant que ces ligues-là pour trouver les joueurs).
    'meta_games_per_tier' => 500,  // parties gardées par niveau et par patch (50 à 5000) : les plus récentes du
                                   // patch ; une nouvelle partie remplace la plus ancienne. Un niveau dont les
                                   // 500 parties datent toutes des dernières 24 h est mis de côté jusqu'au lendemain.
    'meta_hours' => '04-15',       // plage horaire de la collecte automatique (cron), heure locale : de 4 h
                                   // (inclus) à 15 h (exclu). '22-06' passe minuit, '00-24' = toute la journée.
                                   // En dehors, le cron s'arrête aussitôt ; le bouton du site marche à toute heure.
    'timezone' => 'Europe/Paris',  // fuseau horaire de meta_hours (nom IANA : 'Europe/Paris', 'UTC'…)
    'meta_time_budget' => 3300,    // secondes de travail max par passage du cron (1 à 3300, 55 min), sans
                                   // jamais dépasser la fin de la plage horaire
    'meta_rate' => 0.25,           // requêtes Riot par seconde au plus pour la collecte (ligne absente = 0.25,
                                   // soit une requête toutes les 4 s) ; en plus, la collecte s'arrête d'appeler
                                   // à 60 % de chaque fenêtre de la limite de la clé (riot_limits.json du dossier
                                   // de données) pour laisser la place aux joueurs (servis jusqu'à 95 %).
                                   // 'auto' = pas de rythme fixe, seulement la règle des 60 % (plus rapide, mais
                                   // la clé de développement atteint vite ses limites). Sur un refus de Riot (429),
                                   // la collecte attend le délai demandé (Retry-After, 5 à 60 s) puis reprend.
    'meta_web_budget' => 45,       // secondes de travail max par clic sur « Lancer » depuis le site (5 à 120) ;
                                   // rester sous la limite d'exécution PHP de l'hébergeur
    'meta_min_games' => 300,       // parties d'un niveau nécessaires pour servir le nouveau patch plutôt que le
                                   // précédent
];
