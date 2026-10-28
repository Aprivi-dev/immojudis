# Documentation d'Immojudis

Point d'entrée de `docs/`. Les pages sont classées en quatre rubriques selon ce que vous cherchez à faire.
Mise à jour : 2026-10-28. Le [README racine](../README.md) donne le démarrage rapide et [`CLAUDE.md`](../CLAUDE.md)
les vérifications avant de livrer du code.

## 1. Apprendre : comprendre le produit et la plateforme

- [Installation locale et déploiement Vercel](vercel_setup.md) : variables, Supabase, build, indexation, crons.
- [Variables d'environnement : référence du lot](reference/variables-environnement.md) : défauts, constantes qui
  n'en sont pas, où chaque variable est lue.
- [Dictionnaire de données](data-dictionary.md) : tables d'Outcome Graph, puis tables des pépites, de
  l'inondation, des communes, des loyers et du zonage.
- [Architecture actuelle](architecture/current-state.md) et [cible](architecture/target-state.md).
- [README du pipeline de données](../services/data-pipeline/README.md) : collecte, enrichissement, imports de
  référence.
- [README des migrations Supabase](../supabase/README.md).

## 2. Faire : exploiter la production (procédures)

Les procédures pas à pas sont dans [`runbooks/`](runbooks/). Les plus utiles :

| Situation                                                     | Runbook                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Retirer les pépites du public tout de suite                   | [Arrêt d'urgence des pépites](runbooks/pepites-arret-urgence.md)                                                                                                                                                         |
| Le traitement d'inondation échoue ou produit des « inconnus » | [Pannes Géorisques](runbooks/georisques-pannes-inondation.md)                                                                                                                                                            |
| Ouvrir la règle `pepite-v2`                                   | [Ouverture de `pepite-v2`](runbooks/pepite-v2-ouverture.md)                                                                                                                                                              |
| Charger la carte des loyers de décembre                       | [Import annuel ANIL](runbooks/import-annuel-anil.md)                                                                                                                                                                     |
| Prolonger l'essai de comptes                                  | [Prolongation d'essai](runbooks/prolongation-essai.md)                                                                                                                                                                   |
| Couper ou rétablir l'essai de 7 jours                         | [Essai gratuit à l'inscription](runbooks/offre-de-lancement.md)                                                                                                                                                          |
| Alerte `cron.stale`, santé opérationnelle                     | [Phase 3 : SLO et runbooks](operations-phase-3.md), [arrêt de la santé opérationnelle](runbooks/operational-health-arret.md)                                                                                             |
| Collecte arrêtée ou en retard                                 | [`pipeline-scheduler-disabled`](runbooks/pipeline-scheduler-disabled.md), [`pipeline-source-stale-listings`](runbooks/pipeline-source-stale-listings.md), [`pipeline-source-missed`](runbooks/pipeline-source-missed.md) |
| Alertes email en retard                                       | [`alerts-delivery-late`](runbooks/alerts-delivery-late.md)                                                                                                                                                               |
| Agent d'information                                           | [`information-agent`](runbooks/information-agent.md)                                                                                                                                                                     |
| Sécurité Supabase                                             | [`supabase-security-advisors`](runbooks/supabase-security-advisors.md)                                                                                                                                                   |

Planification et supervision :

- [Inventaire des tâches planifiées](operations/planification.md) (crons Vercel, `pg_cron`, workflows).
- [Supervision externe](operations/supervision-externe.md) et [phase 5 : télémétrie et test de fumée](operations-phase-5.md).
- Données de référence : [loyers et zonage](operations/donnees-de-reference-loyers-et-zonage.md),
  [environnement](operations/donnees-de-reference-environnement.md).

## 3. Consulter : conformité, fiches de modèle, références

- Conformité : [phase 6](compliance-phase-6.md), [registre des traitements](rgpd-processing-register.md),
  [matrice de conservation](data-retention-matrix.md), [archives des textes juridiques](legal-archives/README.md).
- Fiches de modèle : [résultats d'enchères](model-card-outcome-evaluation.md),
  [Outcome Graph](model-card-outcome-graph.md), [statistiques de tribunal](model-card-tribunal-statistics.md).
- [Fiabilité du pipeline](pipeline-reliability.md), [sécurité d'Outcome Graph](security/outcome-graph.md).
- [Conception](design/fondations.md) et feuilles de route ([`roadmaps/`](roadmaps/)).

## 4. Comprendre : pourquoi et comment on en est là

- [Comptes-rendus de l'équipe d'agents](equipe/README.md) : un fichier par mission, décisions du propriétaire
  incluses.
- [Audits](audits/) (sources, extraction, performance) et [archives](archive/).
- Audits récents : [DVF et valorisation](dvf-valuation-audit-2026-07-12.md),
  [préparation des statistiques](statistics-pilot-readiness-2026-08-24.md),
  [feuille de route d'enrichissement](statistics-data-enrichment-roadmap.md).
