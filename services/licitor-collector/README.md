# Collecteur Licitor (accès manuel)

Gabarit privé : aucun cron. Chaque appel à `/api/tick` traite un lot borné et nécessite une action manuelle authentifiée.

Depuis le 12/10/2026, la collecte automatique ne passe plus par ce service : le lanceur planifié du pipeline
(`services/data-pipeline/src/sources/licitor_history_refresh.py`) exécute les mêmes ticks sous le rôle
`licitor_collector`, après chaque passage de la file d'enrichissement. Ce service reste utilisable pour un
tick ou un état ponctuel.

Aucun enrichissement ni publication du catalogue n’est déclenché par ce service. Les modules partagés doivent être inclus dans un paquet isolé avant tout déploiement ; ne pas déployer ce dossier directement.

**Interrupteur de retrait.** Aucune source n'est retirée à ce jour : Licitor est collecté normalement. Si
`auction_source_state.catalogue_withdrawn` était posé pour Licitor (usage futur), `/api/tick` et `/api/monthly`
répondraient 409 sans rien collecter. Sans `SUPABASE_DB_URL` dans l'environnement du service, l'interrupteur ne
peut pas être lu et aucune source n'est considérée comme retirée. Voir `services/data-pipeline/README.md`,
section « Source Licitor ».
