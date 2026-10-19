# Collecte et enrichissement — 10 septembre 2026

## Exécution

- Découverte multi-sources : une unité par source au plus toutes les 12 heures, réservée par l'ordonnanceur SQL (tick pg_cron de 15 minutes) qui déclenche `workflow_dispatch` ; le lancement manuel (admin) reste possible.
- File documentaire et IA : une unité toutes les 30 minutes par le même ordonnanceur (ou à la demande avec `enrichment_only=true`).
- `workflow_dispatch` conserve le scan manuel et ajoute `enrichment_only`. Le workflow n'a pas de cron GitHub.
- Un seul workflow écrivain à la fois ; aucune annulation du run actif.
- Scan : 10 biens documentaires et 20 synthèses maximum. Le reliquat est enregistré en base.
- Worker manuel : deux jobs réservés à la fois, budget de 40 minutes ; reprise au prochain lancement manuel.

## Fraîcheur

Une signature prix/date ne suffit plus à sauter une fiche. La dernière vérification propre à cette URL doit dater de moins de 24 heures, ou de 6 heures si la vente intervient dans les sept jours. Une modification du contenu invalide les versions documentaires et de synthèse.

Les PDF sont revalidés quotidiennement avec `If-None-Match` et `If-Modified-Since` lorsque le serveur fournit ces en-têtes. Sans validateur, le téléchargement est répété. Un remplacement est écrit atomiquement ; l'ancien fichier est conservé sous son SHA-256 dans `versions/`. Ces fichiers suivent la rétention du cache d'extraction GitHub, qui ne constitue pas une archive permanente.

L'état documentaire contient l'empreinte des liens, l'heure de contrôle et le nombre de documents sélectionnés en échec. Une pièce non extraite ne compte plus comme preuve de couverture.

### Effet d'une extraction de l'avocat poursuivant sur les textes IA (octobre 2026)

Lire l'avocat des fiches Vench (~475 en ligne) et Petites Affiches (~508) change `lawyer_name`, `lawyer_contact` et plusieurs blocs `source_blocks` (`avocat`, `contact_avocat`, `entete_avocat`, `avocat_poursuivant_*`), tous dans `SOURCE_FACT_FIELDS`. `SOURCE_EXTRACTION_VERSION` n'est pas modifié : les fiches sont relues au rythme normal (24 h, 6 h avant une vente) et non toutes d'un coup.

- Texte d'affichage : l'empreinte de contenu (`capture_fingerprints`) ignore les champs avocat. Une fiche dont l'empreinte du même type de capture est déjà enregistrée (cas courant) garde son texte `accepted`. Seule une fiche sans empreinte de ce type (première lecture par le job `source_detail`, ligne antérieure à la règle) est comparée à l'empreinte de preuve : elle passe en `stale` (texte conservé, faits LLM retirés) et revient dans la file ; sans cette extraction, la même première lecture produit déjà le même résultat dès que la page seule diffère de la carte fusionnée (cas usuel).
- Faits LLM documentaires : l'empreinte de preuve (`evidence_fingerprint`) et le contexte envoyé au modèle (`llm_fact_input_key`, tous les `source_blocks`) changent aussi. Les fiches qui ont des pièces déjà analysées (`documents_extracted > 0`) voient `has_current_fact_analysis` devenir faux et repassent par un job `fact_extraction` puis une synthèse. Les fiches sans pièce (la plupart des Petites Affiches, qui n'en publient pas) ne sont pas concernées.
- Estimation : au plus ~980 fiches voient leur empreinte de preuve bouger ; seules celles qui ont des pièces analysées, plus les premières lectures `source_detail`, coûtent un passage LLM (faits + synthèse). Le nombre exact se lit en production (`raw_payload.source_checks.*.display_invalidations` et le backlog `fact_extraction` après le premier scan) ; il n'a pas été mesuré.
- Pour l'éviter une fois pour toutes : sortir les champs avocat de `source_evidence_fingerprint` et des sections `[ANNONCE SOURCE …]` envoyées au modèle. Non appliqué : cela déplace aussi l'empreinte de preuve de toutes les fiches une fois.

## Couverture et qualité

Les sources paginées Info Enchères, Cessions État, Enchères Immobilières et Notaires parcourent jusqu'à 100 pages par périmètre. Une page répétée, une source vide et un plafond atteint sont signalés comme incomplets. Licitor signale une frontière de pagination non parcourue. Les sources sans preuve d'exhaustivité restent explicitement non vérifiées.

Les conflits entre sources sont conservés dans `raw_payload.source_conflicts`. Une preuve documentaire et une vérification plus récente interviennent dans l'arbitrage par champ. Les anomalies ne majorent plus la richesse d'une annonce. Des numéros de lots différents et des surfaces applicatives fortement divergentes empêchent la fusion.

Après extraction documentaire, les surfaces manquantes, occupations inconnues et contradictions déclenchent un job `fact_extraction`, qui utilise `structured_then_display`. Le worker refuse de terminer avec succès un job PDF qui conserve des erreurs.

## Publication

Lorsque `SUPABASE_DB_URL` est configuré, les ventes, biens, procédures, surfaces, risques, preuves documentaires et jobs sont écrits dans une transaction PostgreSQL. Une erreur annule cette transaction ; aucun repli REST ne publie une moitié de ces données.

Les runs conservent leur statut compatible avec l'interface existante. `summary.stage_status` distingue collecte, enrichissement et publication ; `summary.completion_status` indique un succès partiel lorsqu'un traitement reste différé ou en erreur. Le nettoyage reste bloqué pour une collecte incomplète.

## Suivi et reprise

Après un lancement manuel, le dernier step du workflow exécute `python -m src.pipeline_health`. Son résumé expose couverture par source et backlog par type/statut. Les nouveaux jobs épuisant leurs tentatives ou restant en attente plus de 48 heures font échouer ce contrôle.

Les jobs suivent les délais et le nombre maximal de tentatives de `auction_enrichment_jobs`. Après correction d'un problème de source, relancer le scan pour réévaluer les données puis le workflow avec `enrichment_only=true`. Un document inaccessible reste signalé ; il n'est jamais marqué extrait par défaut.

### Jobs d'enrichissement épuisés (alerte `pipeline.enrichment.exhausted`)

Un job `failed` dont `attempt_count >= max_attempts` n'est plus jamais pris en charge : c'est une lettre morte. Il ne compte pas dans `pipeline.enrichment.stalled` (il ne pourrait jamais la fermer) mais dans `evidence.exhausted` de l'observation `enrichment-queue`. L'observateur `observe_autonomous_pipeline` ouvre un avertissement séparé, `pipeline.enrichment.exhausted` (catégorie `import`, migration `20261025110000_enrichment_exhausted_alert.sql`), quand :

- au moins **3** jobs sont devenus épuisés pendant les dernières 24 heures (`evidence.exhausted_24h`, d'après `updated_at` de la dernière tentative) : une source ou un type de document se met à échouer pour de bon ;
- ou au moins **50** jobs épuisés attendent une décision (`evidence.exhausted`) : un reliquat que personne n'a traité.

Les seuils sont recopiés dans les détails de l'alerte (`exhausted_24h_threshold`, `exhausted_threshold`). La hausse se referme d'elle-même 24 heures après le dernier nouvel épuisement (plus deux heures d'hystérésis) ; le reliquat se referme quand les jobs sont relancés ou annulés. Les jobs d'une vente retirée, passée ou remplacée par une révision plus récente sont en principe annulés par la prochaine prise en charge de la file (vérifier dans `claim_auction_enrichment_jobs*`) : ils quittent alors le décompte sans action.

Reprise manuelle (en `service_role`, jamais sans avoir compris la cause ; ne pas relancer en boucle) :

1. Regrouper les échecs par cause :
   `select job_type, left(last_error, 120) as erreur, count(*) as jobs, min(updated_at), max(updated_at) from public.auction_enrichment_jobs where status = 'failed' and attempt_count >= max_attempts group by 1, 2 order by jobs desc;`
2. Corriger la cause (source modifiée, document inaccessible, budget, bogue) puis la déployer. Si l'échec est définitif (document supprimé, fiche retirée), annuler plutôt que relancer :
   `update public.auction_enrichment_jobs set status = 'cancelled', locked_at = null, updated_at = now() where status = 'failed' and attempt_count >= max_attempts and <filtre sur job_type et last_error>;`
3. Sinon, conserver d'abord un instantané des lignes concernées (`select * from public.auction_enrichment_jobs where ...`), puis rendre **une seule** tentative, sans remise à zéro générale ni effacement de `last_error` (comme pour l'incident de budget du 13 septembre) : un job encore en échec s'épuise de nouveau aussitôt au lieu de boucler :
   `update public.auction_enrichment_jobs set status = 'queued', attempt_count = greatest(0, max_attempts - 1), next_attempt_at = now(), locked_at = null, updated_at = now() where status = 'failed' and attempt_count >= max_attempts and <même filtre>;`
4. Lancer le workflow avec `enrichment_only=true` ou attendre l'ordonnanceur, puis vérifier que `evidence.exhausted` baisse et que l'alerte se referme.

Ces requêtes sont à valider avant toute exécution ; aucune n'a été lancée par le correctif.

Vérifications : suite Python, tests de renouvellement de PDF/304, expiration des fiches, pagination, lots distincts, rollback simulé et transaction réelle sur PostgreSQL jetable.
