# Conditions de lancement et gel du périmètre

> **Mise à jour du 08/11/2026.** Le nom du fichier garde la date de la décision d'origine (10/10/2026). La liste
> ci-dessous est désormais la **liste unique « go / no-go » du lancement payant**, à jour au 08/11/2026 (proposition
> P17 de l'état des lieux du 08/11, validée par le propriétaire le 08/11). Le propriétaire la coche lui-même : aucune
> case n'a été cochée par l'équipe. La colonne « État au 08/11/2026 » reprend ce que disent les comptes-rendus cités,
> pas une vérification nouvelle, sauf mention contraire.
>
> **Mise à jour du 14/11/2026** (proposition P6 de l'état des lieux du 14/11, validée par le propriétaire le 14/11).
> Les lignes touchées portent la date du 14/11 dans leur colonne « État ». **Le paiement de l'offre Analyse est
> ouvert** en production, Stripe en mode réel, depuis au moins le 14/11 (confirmé par le propriétaire), alors que des
> cases restent à « non » : c'est sa décision. Ces lignes restent à traiter, paiement ouvert. Aucune case n'a été
> cochée par l'équipe.

Décision du 10 octobre 2026, issue du plan correctif (`docs/audits/2026-10-09-plan-correctif.md`).
Elle complète `decision-perimetre-2026-10-09.md` (France entière).

## Liste go / no-go du lancement payant

Le paiement s'ouvre quand **toutes** les cases sont cochées. Chaque ligne se vérifie par oui ou par non. Une ligne
à « non » est un no-go, sauf décision contraire du propriétaire, écrite dans la colonne « État ».

Sources citées dans la colonne « Source » :

- **10/10** : ce document et le plan correctif (`docs/audits/2026-10-09-plan-correctif.md`), tâches P0-xx à P3-xx ;
- **31/10** : `docs/equipe/2026-10-31-feuille-blanche.md` (P1 à P12 : section 3 ; « n° » : section 4) ;
- **06/11** : `docs/equipe/2026-11-06-revue-marketing.md` (points ouverts) ;
- **08/11** : `docs/equipe/2026-11-08-etat-des-lieux.md` (numéros de la section 2 et des annexes ; « section 5 » :
  actions et décisions du propriétaire ; « juridique » : annexe du rapport de juridique-rgpd).

### 1. Conditions du 10/10/2026, état revu

| Go  | Condition                                                             | Source                                            | État au 08/11/2026                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ ] | Compte admin sécurisé (mot de passe changé, double authentification)  | 10/10 P0-01, P0-02 ; 31/10 P2                     | **Double authentification non exigée au 31/10** : `admin_mfa_required` valait `false` en base. Pas de nouvelle mesure depuis. `ADMIN_MFA_REQUIRED` à vérifier (08/11, section 5). **14/11 :** refusée le 12/11 par le propriétaire, **risque accepté** (`2026-11-11-registre-des-pieces.md`, section 15) ; **à réactiver avant le premier envoi réel et avant le premier abonné** (procédure T3, lot A du 14/11). Accès tiers : rôle de lecture Lovable supprimé en base le 12/11 (#492) ; reste au propriétaire : désinstaller l'application GitHub de Lovable et déconnecter le projet                                                               |
| [ ] | Catalogue rapide, sans erreur 500, sans « 0 annonce » trompeur        | 10/10 P1-01, P1-02 ; 08/11 T4                     | 415 migrations sur 415 appliquées au 31/10. `/sales` en compte connecté **non mesuré** après la migration `20261110120000` (08/11 T4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [ ] | Mentions légales renseignées en production                            | 10/10 P1-03, P1-04 ; 31/10 P1                     | **Ouvert** : P1 du 31/10 toujours ouvert au 08/11 (section 5). La configuration de production n'a pas été vérifiée par l'équipe (08/11, juridique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [ ] | Pied de page, CGU et confidentialité à l'inscription                  | 10/10 P1-05, P1-06                                | Livré (10/10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [ ] | Périmètre géographique tranché et aligné                              | 10/10 P1-07                                       | Livré (France entière)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [ ] | Départements, coordonnées, statuts des ventes corrects                | 10/10 P1-08, P1-09                                | Code livré (10/10). Non remesuré ligne à ligne pour cette liste. Champs manquants sur les ventes à venir au 31/10 (section 2) : tribunal 23 %, code postal 43 %                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [ ] | Facturation sûre : impayé, remboursement, compte, rétractation        | 10/10 P1-11 à P1-14 ; 08/11 C9                    | Livré le 10/10, **mais remis en cause** : le 08/11, C9 signale un second remboursement possible quand une rétractation est relancée (constat vérifié dans le code). Voir la section 5 de cette liste                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [ ] | Stripe configuré en production                                        | 10/10 P1-15 ; 31/10 n° 45 ; 08/11 Commercial      | **À faire par le propriétaire.** Détail proposé le 08/11 (volet Commercial, bloquant 1, non encore validé) : Price à 59 € « inclusive », webhook abonné aux bons événements, migrations `20261110140000` et `20261110140100` vérifiées en production. 09/11 : marche à suivre dans `docs/runbooks/ouverture-paiements.md` ; produit et Price créés dans l'environnement de test Stripe ; migration `20261113100000` à vérifier aussi. **14/11 :** Stripe en production **en mode réel**, paiement Analyse ouvert depuis au moins le 14/11 (confirmé par le propriétaire ; `/api/billing/offer` répond `configured: true`, état des lieux du 14/11, C1) |
| [ ] | Licence Licitor ou retrait du module                                  | 10/10 P1-17 ; 31/10 P5 ; 08/11 juridique          | **Décision du propriétaire : Licitor conservé.** Toujours **aucun accord écrit** au 08/11. Dépendance accrue depuis les retraits de Vench et de Petites Affiches : voir la section 2 de cette liste                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [ ] | Frais, rendement, plafond justes                                      | 10/10 P2-01 à P2-07 ; 31/10 n° 27 ; 08/11 D1 à D4 | Livré le 10/10 (barème à revérifier sur Légifrance, 31/10 n° 27). Le 08/11, le volet Données signale des chiffres affichés à corriger : modèles LightGBM actifs sans porte d'activation (D1), « d'après N ventes comparables » (D2, D4), bien libre face à bien occupé (D3)                                                                                                                                                                                                                                                                                                                                                                            |
| [ ] | Production alignée sur `main`, crons qui se rattrapent, base soulagée | 10/10 P3-01 à P3-04 ; 08/11 section 5             | 415 migrations sur 415 appliquées au 31/10. À vérifier au 08/11 : migrations `20261110120000`, `20261110140000` et `20261110140100` en production                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Tant que les mentions légales ne sont pas toutes renseignées ou que `STRIPE_ANALYSIS_PRICE_ID` est absent,
le paiement se ferme de lui-même (le code refuse le checkout et masque l'essai) : le site peut être public en
lecture, l'offre Analyse ne se vend pas. Au 08/11, l'échappatoire `ALLOW_INCOMPLETE_LAUNCH_CONFIG` existe toujours
(`scripts/lib/launch-config.mjs:51`, 08/11 juridique) : la retirer fait partie de P1 du 31/10.

### 2. Sources et droits sur les données

| Go  | Condition                                                                                                                        | Source                        | État au 08/11/2026                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ] | Vench retiré en production (`catalogue_withdrawn = true` pour `vench`)                                                           | 08/11 P17 ; décision du 29/10 | Décision du propriétaire du 29/10 : annonces rarement exploitables, collecte en échec depuis le 26/10. Migration `20261109153217_withdraw_vench_source.sql` dans `main`. Application en production à confirmer par la requête ci-dessous                                                                                                           |
| [ ] | Petites Affiches retiré en production (`catalogue_withdrawn = true` pour `petites_affiches`)                                     | 08/11 P17 ; décision du 30/10 | Décision du propriétaire du 30/10 : même catalogue que Vench, fiches illisibles depuis le changement de présentation du site. Migration `20261110093117_withdraw_petites_affiches_source.sql` dans `main`. Application en production à confirmer de la même façon                                                                                  |
| [ ] | Notaires : trace écrite de l'accord versée au dossier, **ou** position relue par un avocat (conditions d'immobilier.notaires.fr) | 11/11 annexe 14 ; 14/11 P6    | **14/11 :** envois aux notaires **ouverts depuis le 12/11** sur l'accord oral des notaires déclaré par le propriétaire (`INFORMATION_AGENT_NOTARY_SEND_ENABLED=true`, `2026-11-11-registre-des-pieces.md`, section 14). Chaque envoi est validé par un administrateur ; le pilote automatique n'écrit pas aux notaires. Aucune trace écrite versée |
| [ ] | Licitor : licence écrite obtenue, **ou** décision assumée, documentée et relue par un avocat                                     | 31/10 P5 ; 08/11 section 5    | **Aucun accord écrit** : seul un accord oral du 14/10 est invoqué (`docs/runbooks/information-agent.md`). Au 31/10, 21,7 % des ventes à venir visibles n'existaient que par Licitor. Les statistiques d'adjudication et les scénarios d'enchères de `/offres` en dépendent (08/11, juridique)                                                      |

Vérification en lecture seule des deux retraits (les deux lignes doivent sortir avec `catalogue_withdrawn = true`) :

```sql
select source_name, enabled, catalogue_withdrawn
from public.auction_source_state
where source_name in ('vench', 'petites_affiches');
```

### 3. Hébergement, mesure et emails

| Go  | Condition                                                               | Source               | État au 08/11/2026                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ] | Projet Vercel en plan Pro                                               | 31/10 P7 ; 08/11 P2  | **Non confirmé.** Le dépôt documente le plan Hobby (`docs/vercel_setup.md`), qui est non commercial. Le plan réel est à confirmer par le propriétaire. **14/11 :** toujours non confirmé, alors que le paiement est ouvert ; à relever par le propriétaire avant le 18/11 (état des lieux du 14/11, P1)                                                                                  |
| [ ] | Les 17 événements produit arrivent dans Vercel, Analytics, Events       | 08/11 P2             | **Non vérifié.** Selon la documentation Vercel, les événements personnalisés sont réservés aux plans Pro et Enterprise : sur Hobby, ils ne sont pas enregistrés. Sans eux, la conversion n'est pas mesurable (08/11 C6). **14/11 :** toujours non vérifié ; dépend du plan (ligne précédente), console Events à relever par le propriétaire avant le 18/11 (état des lieux du 14/11, P1) |
| [ ] | DMARC publié sur `_dmarc.immojudis.com` en `p=none`                     | 31/10 P8             | Relevé DNS public du 08/11 : `v=DMARC1; p=none; rua=mailto:dmarc@immojudis.com; adkim=r; aspf=r`. Case laissée au propriétaire                                                                                                                                                                                                                                                           |
| [ ] | DMARC passé en `p=quarantine`, après 2 à 4 semaines de rapports propres | 31/10 P8 ; 08/11 C28 | **À faire.** Décision ouverte au 08/11 (section 5), avec le retrait du MX SES à la racine du domaine                                                                                                                                                                                                                                                                                     |

### 4. Juridique : relectures par un avocat

Liste « À faire valider par un avocat » du 08/11 (section 5 et rapport de juridique-rgpd), complétée par les points
ouverts de la revue marketing du 06/11. Une ligne se coche quand l'avis écrit de l'avocat est reçu et ses demandes
appliquées.

| Go  | Point relu par un avocat                                                                                                                                                                                        | Source                            | État au 08/11/2026                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ ] | CGU 2026-11-10.1 (ouverture des paiements), en vigueur : note « BROUILLON à faire valider par un avocat », préavis de l'article 14 pour les comptes existants, article 8 (informations transmises par l'avocat) | 14/11 J17 ; 14/11 P6              | **14/11 :** en vigueur et acceptées à chaque souscription depuis l'ouverture du paiement ; applicables aux comptes existants le 1er décembre 2026. **Non relues par un avocat : relecture à faire**                            |
| [ ] | CGV : qualification de l'abonnement (durée indéterminée ou reconduction), conditions pour les professionnels, exécution immédiate obligatoire au paiement                                                       | 06/11 ; 08/11 juridique (point 4) | Non relu                                                                                                                                                                                                                       |
| [ ] | Identification de l'éditeur, et opposabilité des CGU au 1er décembre par un simple bandeau                                                                                                                      | 08/11 section 5 ; juridique (1)   | Non relu                                                                                                                                                                                                                       |
| [ ] | Licence ou position assumée sur Licitor                                                                                                                                                                         | 08/11 section 5 ; 31/10 P5        | Non relu                                                                                                                                                                                                                       |
| [ ] | Désignation d'un avocat payant par défaut, au regard du RIN (art. 19.4.2) et du libre choix                                                                                                                     | 08/11 section 5 ; 31/10 P12       | Non relu                                                                                                                                                                                                                       |
| [ ] | Base légale du profil d'investisseur (donnée financière)                                                                                                                                                        | 08/11 section 5 ; J3              | Non relu. **14/11 :** exécution du contrat, annoncée dans la politique de confidentialité 2026-11-14.1, liée depuis `/compte`                                                                                                  |
| [ ] | Nature des emails d'alerte et de fin d'essai : service ou prospection (CPCE, art. L34-5)                                                                                                                        | 08/11 section 5 ; 06/11           | Non relu                                                                                                                                                                                                                       |
| [ ] | Verdict « On enchérit » et libellés du rapport partagé                                                                                                                                                          | 08/11 section 5 ; 31/10 P10       | Non relu                                                                                                                                                                                                                       |
| [ ] | Texte exact du formulaire type de rétractation                                                                                                                                                                  | 08/11 section 5 ; juridique (8)   | Non relu                                                                                                                                                                                                                       |
| [ ] | Photos tirées des procès-verbaux d'huissier                                                                                                                                                                     | 08/11 section 5 ; T1              | Non relu. La question reste à poser à juridique-rgpd (08/11, section 3). **14/11 :** intérêt légitime et retrait sur demande annoncés dans la politique de confidentialité 2026-11-14.1 ; mise en balance écrite à faire (J14) |

### 5. Paiement : bloquants proposés le 08/11 (proposé, non encore validé)

Ces lignes viennent du volet Commercial et contenus de l'état des lieux du 08/11 (annexe, « Bloquant avant
l'ouverture des paiements »). **Ce volet n'a pas été validé par le propriétaire** : chaque ligne reste « proposé, non
encore validé » tant qu'il ne l'a pas retenue. Les constats notés « vérifié » ont été relus dans le code par le chef du
département ou par le chef d'orchestre.

| Go  | Condition                                                                                                                                       | Source               | État au 08/11/2026                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ ] | Une rétractation relancée ne peut plus déclencher un second remboursement                                                                       | 08/11 C9             | **Retenu par le propriétaire le 09/11, codé** : remboursement marqué par demande, déjà remboursé déduit du prorata (`contract-withdrawal.ts`). Reste la recette (runbook, scénario 7)                                                                              |
| [ ] | 3-D Secure au renouvellement traité (`invoice.payment_action_required`, email « Confirmer mon paiement »)                                       | 08/11 C10            | **Retenu le 09/11, codé** : email `payment_action_required` vers la page de paiement Stripe. Reste : cocher l'événement sur le webhook, recette (scénario 4)                                                                                                       |
| [ ] | Runbook « ouverture-paiements » écrit, et recette Stripe faite par le propriétaire                                                              | 08/11 C11 ; 14/11 P6 | **Retenu le 09/11.** Runbook écrit : `docs/runbooks/ouverture-paiements.md`. **14/11 :** Stripe étant en mode réel, la recette se fait par **un premier paiement réel suivi d'un remboursement**, **à faire par le propriétaire** ; aucune recette notée à ce jour |
| [ ] | Une alerte repassée en hebdomadaire à la fin de l'essai redevient quotidienne à l'abonnement                                                    | 08/11 C1             | **Retenu le 09/11, codé** : marqueur `frequency_downgraded_at` (migration `20261113100000`), retour en quotidien au premier droit Analyse durable                                                                                                                  |
| [ ] | Liste de suppression : un rebond ou une plainte arrête aussi l'email J+5 et l'email d'ouverture, avant `TRIAL_END_EMAIL_MODE=on`                | 08/11 C7             | **Proposé, non encore validé.** La fonction actuelle ne retire que 4 consentements (vérifié)                                                                                                                                                                       |
| [ ] | Textes figés branchés sur la garde d'ouverture du paiement (« pas encore ouverte », « choisissez l'offre Analyse »), variante « ouverte » relue | 08/11 C12            | **Retenu le 09/11, codé** : connexion, plafond verrouillé et email de fin d'essai suivent la garde d'ouverture. Reste : relecture juridique de la variante « ouverte » ; CGU (« pas encore ouverte ») à changer par une nouvelle version à l'ouverture             |

### 6. Promesse de l'offre : plafonds calculables

| Go  | Condition                                                                                                                        | Source   | État au 08/11/2026                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ] | La part des ventes dont le plafond est calculable est mesurée chaque jour et affichée                                            | 08/11 P7 | **14/11 : codé.** L'écran « Contrôles qualité du catalogue » de l'administration affiche, pour les ventes à venir, la part dont l'enchère plafond est calculable, par type de vente, avec le motif d'échec principal (`AdminCatalogueQualityPanel.tsx`). **Valeur jamais relevée** : à relever par le propriétaire avant le 18/11 (état des lieux du 14/11, P1) |
| [ ] | Ce taux atteint **60 % des ventes au tribunal**, **ou** la promesse de `/offres` a été réécrite pour correspondre au taux mesuré | 08/11 P7 | Seuil **proposé** par le volet Produit le 08/11, à confirmer par le propriétaire. Taux non mesuré                                                                                                                                                                                                                                                               |

### 7. Décisions du propriétaire encore ouvertes

| Go  | Décision prise et notée                                                                                                             | Source                                     | État au 08/11/2026                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [ ] | Éditeur identifié (société créée) et régime de TVA choisi (Stripe Tax ou taux fixe)                                                 | 31/10 P1 et n° 45 ; 08/11 section 5        | **TVA tranchée le 09/11 : franchise en base** (art. 293 B du CGI, mention sur les factures). Éditeur : ouvert |
| [ ] | Sort de l'essai de 7 jours tant que le paiement est fermé (et, s'il est gardé : email de fin d'essai, « essai d'ouverture » C13)    | 31/10 P3 et n° 87 ; 08/11 conflit 5        | Ouvert                                                                                                        |
| [ ] | Fusion des doublons entre sources : `dedupe-candidates` relu, puis `DEDUPE_RECONCILE_ENABLED` activé, ou refus noté                 | 31/10 P9 ; 08/11 D12                       | Ouvert. 73 groupes de doublons (151 lignes) mesurés le 08/11                                                  |
| [ ] | Modèle avocats : plus d'avocat payant désigné par défaut, ou désignation validée par un avocat ; libre choix affiché sur `/avocats` | 31/10 P12 ; 08/11 section 5                | Ouvert                                                                                                        |
| [ ] | Cible prioritaire choisie (marchands de biens ou investisseurs débutants)                                                           | 31/10 n° 98 ; 08/11 section 5 et conflit 2 | Ouvert                                                                                                        |

## Chantier gelé : Outcome Graph

Jusqu'au lancement, **aucun nouveau développement** sur l'Outcome Graph (environ 30 tables), les statistiques
de tribunaux, JudiLibre et l'activité de la justice.

- Les drapeaux `TRIBUNAL_STATISTICS_ENABLED`, `OUTCOME_EVALUATION_ENABLED`, `JUDILIBRE_ENABLED` et
  `JUSTICE_ACTIVITY_ENABLED` restent fermés. Vérifié le 10/10/2026 : aucun n'est défini en production ;
  seuls trois existent en preview.
- `ADJUDICATION_PRICE_STATISTICS_ENABLED` : fermé en production le 09/10/2026, **réactivé le 12/10/2026**. Le
  13/10/2026, à la demande du propriétaire (qui déclare l'accord de Licitor), les statistiques des tribunaux et les
  scénarios d'enchères sont de nouveau affichés et promis : ligne « Statistiques des tribunaux » de la page Offres et
  du comparatif, mention dans les CGV §2 (version `2026-10-13.2`), onglet de la fiche d'exemple. Les autres drapeaux
  de cette liste restent fermés.
- Aucune PR « Outcome Graph » avant le lancement. Les workflows `outcome-*` ne doivent pas être planifiés.
- Le code reste dans `main` : le retirer coûterait plus cher qu'il ne rapporte tant qu'il est inactif.

## Ventes notariales et domaniales

Elles font partie du projet au même titre que les ventes au tribunal : les filtres « Chez le notaire » et
« Domaniales » et leurs pages d'entrée sont affichés par défaut. `NEXT_PUBLIC_NOTARY_STATE_PILOTS_ENABLED=false`
permet de les masquer (les annonces restent dans le catalogue). Les cessions de l'État sans date de vente
(appels d'offres, ventes amiables) ne sont pas listées : voir la décision en attente dans le rapport de suivi.

## Fréquence de collecte

Décision du 11 octobre 2026 : chaque source est collectée **au plus toutes les 12 heures** (6 heures auparavant).
La planification (`claim_autonomous_pipeline_run`, appelée toutes les 15 minutes par la tâche
`operational-health`) lance une collecte quand une source est due, et le traitement de la file
d'enrichissement (descriptions, fiches détail, PDF) au plus toutes les 30 minutes ; cette cadence-là est inchangée.
La cadence des sources est fixée à deux endroits : `INVENTORY_CADENCE` (`services/data-pipeline/src/autonomous_runner.py`,
échéance posée à la fin de la collecte) et la fonction SQL (attente pendant que la collecte lancée est en cours),
migration `20261016100000_source_inventory_cadence_12h.sql`.

## Licitor : conservé, avec un interrupteur de retrait gardé en réserve (décision du propriétaire)

Décision du propriétaire du 13/10/2026 : Licitor reste collecté et affiché, « c'est une des meilleures sources ». Une
première version du chantier retirait Licitor par défaut ; cette décision est annulée. Aucune licence écrite n'est
obtenue à ce jour (droit sui generis des bases de données, CPI L. 341-1 et L. 342-1) : la question juridique reste
posée, la décision de conserver la source est celle du propriétaire.

Le chantier garde l'**interrupteur de retrait** comme infrastructure, pour un usage futur : il est **réversible**,
**ne supprime aucune donnée** et **ne retire aucune source par défaut** : `auction_source_state.catalogue_withdrawn`
(une ligne par source), posé et levé par `public.set_catalogue_source_withdrawal`.

**Mise à jour du 08/11/2026.** L'interrupteur a servi pour deux autres sources, sur décision du propriétaire :
Vench le 29/10 (migration `20261109153217_withdraw_vench_source.sql`) et Petites Affiches le 30/10 (migration
`20261110093117_withdraw_petites_affiches_source.sql`). Licitor n'est pas retiré. Les requêtes de vérification de
« Mise en production » ci-dessous renvoient donc désormais ces deux sources : voir la section 2 de la liste go / no-go.

### Ce que ferait un retrait (quand il est posé pour une source)

- **Collecte arrêtée** : plus d'inventaire d'annonces, plus de fiches détail, plus de tick de l'historique des
  adjudications (pour Licitor) ; pas d'alerte `pipeline.source.<source>.missed` (une source retirée est aussi
  désactivée).
- **Catalogue masqué** : une vente dont la seule source est la source retirée est mise en quarantaine par le marqueur
  existant `raw_payload.publication_quarantine = 'source_withdrawn'` : elle disparaît de la recherche publique et
  connectée, de la carte, des comptages, du sitemap, des alertes et de la fiche (la fiche publique répond 404). Toutes
  les vues et fonctions de lecture respectaient déjà ce marqueur, aucune n'est réécrite.
- **Ventes fusionnées** (la source retirée et une autre) : elles restent visibles, sans lien, photo ni pièce hébergés
  par la source retirée (`src/lib/withdrawn-sources.ts`). Les textes (titre, description) ne portent pas leur
  provenance champ par champ et ne sont pas filtrés.

Les drapeaux de statistiques et de scénarios d'enchères des tribunaux ne dépendent pas de cet interrupteur (voir
« Chantier gelé : Outcome Graph » pour leur état).

### Mise en production

La migration `20261021110000_licitor_source_withdrawal.sql` ne retire **aucune** source : l'appliquer pose seulement la
colonne, la contrainte, le déclencheur et les deux fonctions, sans réécrire une seule vente. Rien n'a été appliqué par
l'équipe.

1. Fusionner la branche, puis appliquer la migration (workflow « Apply Supabase Migrations » ou `npm run db:migrate`).
2. Déployer le site et le pipeline. Le code part de l'état « aucune source retirée » même si la migration n'est pas
   encore appliquée (fonction absente ou base injoignable : rien n'est masqué ni arrêté).
3. Vérifier (lecture seule) :
   ```sql
   select source_name, enabled, catalogue_withdrawn from public.auction_source_state where catalogue_withdrawn;
   select count(*) from public.auction_sales where raw_payload->>'publication_quarantine' = 'source_withdrawn';
   ```
   Les deux requêtes doivent ne rien renvoyer / renvoyer 0.

### Retirer une source, puis lever le retrait

Geste explicite, en base, avec le rôle `service_role` ou `postgres` :

```sql
select public.set_catalogue_source_withdrawal('licitor', true, 'raison');   -- retirer
select public.set_catalogue_source_withdrawal('licitor', false);            -- lever
```

Une seule transaction : le retrait désactive la source et met en quarantaine ses ventes ; la levée remet à l'affichage
les ventes (marqueur retiré), réactive la source (`enabled = true`), collectée au prochain passage du planificateur, et
rouvre l'historique des adjudications. Le site relit l'interrupteur au plus une minute plus tard. Si l'interrupteur est
illisible (base injoignable, `SUPABASE_DB_URL` absent d'un lancement local ou de l'audit manuel de couverture), aucune
source n'est considérée comme retirée : un retrait posé n'est alors pas vu.
