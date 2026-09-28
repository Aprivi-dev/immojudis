# État de la file avant publication — 29 septembre 2026

## Relevé de production en lecture seule

Au 28 septembre 2026 à 21 h 50 UTC, la file compte 6 029 tâches non
terminales, dont 5 989 éligibles immédiatement : 2 906 descriptions,
2 602 détails de source, 413 PDF et 68 extractions de faits. Parmi les
tâches éligibles, 3 099 ont plus de 48 heures. Les 24 heures précédentes
comptent 825 tâches terminées, soit environ 34 par heure. Le stock
nécessiterait donc environ sept à huit jours au débit observé, **sans aucune
nouvelle entrée**. Il s'agit d'une estimation de capacité, pas d'une prévision
de résorption.

Le cron de dispatch tourne toutes les 15 minutes. Le planificateur actuel
donne la priorité à une collecte de source dès qu'elle est due ; le worker
d'enrichissement n'est ainsi déclenché qu'environ toutes les 60 à 90 minutes.
Sur 48 heures, 36 workers ont été lancés, dont 14 réussis et 22 en échec.
Le contrôle `operational-health` échoue fréquemment sur un délai SQL. Ces
constats empêchent de qualifier la fraîcheur durable des fiches.

La revue des diagnostics du 13 septembre montre trois réponses HTTP 500
consécutives du dispatch avec `canceling statement due to statement timeout`.
La requête responsable n'est pas encore isolée par un plan SQL. Les journaux
de collecte montrent aussi un blocage du parseur Vench dans BeautifulSoup,
terminé par le watchdog global après cinq minutes : le parseur tourne dans
un thread, où son `SIGALRM` local ne peut pas l'interrompre. Des liens sociaux
ont été présentés comme documents PDF, et Petites Affiches a rencontré des
séquences `301` puis `400` du relais. Ces échecs doivent être corrigés ou
circonscrits avant de conclure que la seule priorité du planificateur suffit.

## Corrections proposées dans la PR 179

La migration `20260928215139_queue_scheduler_fairness.sql` laisse la file
préempter une source due pendant une heure au maximum ; une source plus en
retard reprend la priorité. Le worker alterne les tâches de détail et les
autres enrichissements lorsque l'arriéré dû de ces derniers est plus grand.
Une lecture PostgreSQL facultative, bornée à une tentative de connexion de
trois secondes, guide ce ratio ; les claims SQL restent l'autorité et le
worker revient au cycle historique si la lecture échoue.

La migration `20260928230000_optimize_pipeline_health_and_retention.sql`
réduit le coût du contrôle de fraîcheur. Toutes les nouvelles migrations
doivent encore passer le rejeu Supabase local, être appliquées en production
avant le code correspondant et être suivies d'une nouvelle mesure. Aucune de
ces corrections ne crée à elle seule de capacité CPU, réseau, OCR ou LLM.

## Critère de publication

La branche reste en brouillon tant que les migrations et l'intégration ne
sont pas vérifiées par CI, que le contrôle de santé n'est pas rétabli et
qu'une période de mesure ne montre pas une file éligible qui diminue sans
dégrader la fraîcheur des sources. L'envoi de courriels réels reste désactivé
et suit son propre essai fournisseur contrôlé.
