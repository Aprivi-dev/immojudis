# Demandes de droits et rétractations : suivi, emails et alertes

Écran : Administration › Conformité (`/admin/compliance`), panneau « Demandes RGPD et rétractations ».
Code : `src/lib/privacy-requests.ts` (dépôt, traitement, effacement), `src/lib/contract-withdrawal.ts`
(rétractation), `src/lib/privacy-account-export.ts` (export d'un compte),
`src/lib/privacy-request-notifications.ts` (emails et suivi), `src/lib/privacy-request-emails.ts` (textes).
Migration : `supabase/migrations/20261202100000_privacy_requests_follow_up.sql`.

## Ce qui prévient qui

| Moment                                          | Destinataire                                                                                         | Contenu                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dépôt (compte ou lien signé d'un professionnel) | l'exploitation, par l'alerte `compliance.privacy_requests.awaiting_operator`                         | alerte d'exploitation ouverte dès le dépôt (canal commun : « Alertes ouvertes », workflow GitHub), lien vers Conformité                                                                                     |
| Dépôt                                           | l'exploitation, par email direct (`OPERATIONS_ALERT_EMAIL_TO`), seulement si la variable est définie | nature, date, échéance, lien vers Conformité. Jamais l'adresse ni le message du demandeur.                                                                                                                  |
| Dépôt                                           | le demandeur (`requester_email`)                                                                     | accusé de réception : nature, date, échéance, suivi (Mes droits, ou réponse à l'adresse)                                                                                                                    |
| Clôture (traitée, refusée)                      | le demandeur (`requester_email`)                                                                     | suites données, « Réponse au demandeur » saisie dans le panneau ; pour un effacement, ce qui est effacé et ce qui est conservé (citations de la politique de confidentialité) ; pour un refus RGPD, la CNIL |

Pour recevoir aussi un email direct au dépôt, définir `OPERATIONS_ALERT_EMAIL_TO` sur Vercel (Production). Sans
elle (cas actuel), l'exploitation n'est prévenue que par l'alerte d'exploitation, ouverte au dépôt et notifiée à la
remise suivante des alertes (passage d'`operational-health`, 30 minutes au plus).

Un échec d'envoi ne fait jamais échouer le dépôt ni la clôture. Il est journalisé (`privacy-request-notifications`,
sans adresse) et repris à chaque passage d'`operational-health` (30 min), cinq essais au plus. L'état de chaque
envoi est dans `data_subject_requests.metadata.notifications` (`operator`, `acknowledgement`, `closure` : statut,
nombre d'essais, date, identifiant Resend, gabarit ; jamais le corps) et s'affiche dans le panneau.
`acknowledged_at` est la date réelle d'envoi de l'accusé (nul tant qu'il n'est pas parti, après la migration).

Effacement d'un compte : l'email de clôture part APRÈS la suppression, vers `requester_email`, sans compte. La
purge de `email_send_log` est faite avant lui ; la ligne de cet envoi suit la durée commune du journal (90 jours).
La trace durable est `metadata.notifications.closure`, gardée avec la demande (5 ans après clôture).

## Alertes d'exploitation

Évaluées à chaque dépôt et à chaque passage d'`operational-health` (`public.evaluate_privacy_request_health`), notifiées par le
canal commun (« Alertes ouvertes », email, GitHub), refermées deux heures après le retour au calme :

| Clé                                             | Gravité       | Condition                                                                   |
| ----------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| `compliance.privacy_requests.due_soon`          | avertissement | demande ouverte à 7 jours ou moins de son échéance                          |
| `compliance.privacy_requests.overdue`           | critique      | échéance dépassée                                                           |
| `compliance.privacy_requests.awaiting_operator` | avertissement | au moins une demande au statut « Reçue », sans délai : ouverte dès le dépôt |

Conduite à tenir : ouvrir Conformité, passer la demande à « Vérification identité » ou « En cours » (l'alerte
« à prendre en charge » se referme, deux heures après qu'aucune demande n'est plus « Reçue »), la traiter avant l'échéance. Échéance : un mois (RGPD), 14 jours pour une
rétractation (remboursement dû 14 jours après la notification).

Avant la migration, l'évaluation est sautée sans erreur (`evaluation: "migration_pending"` dans le résultat du
passage) ; les emails partent déjà.

## Effacement d'un compte

Avant d'exécuter, le panneau affiche la garde calculée par le serveur : abonnement Analyse actif, achat à l'unité
payé depuis moins de 14 jours, crédit d'achat non utilisé (crédits « non vérifiables » avant la migration). Dans
ces cas, l'exécution exige la case « Je confirme l'effacement malgré ces éléments » (sinon 409 avec la raison).

Refus avant toute suppression (409) quand le compte est l'auteur de lignes qui empêchent sa suppression
(`on delete restrict`) : dossiers de l'agent d'information (`information_agent_cases.created_by`), relectures
statistiques. Le message les compte. Les traiter (réattribuer ou supprimer) avant de relancer : décision du
propriétaire, à faire dans l'éditeur SQL.

Ordre : clients Stripe (celui de l'abonnement et tous ceux que la recherche Stripe `metadata['user_id']` retrouve),
données applicatives (`ERASURE_TABLES`), journal des emails et invitations par adresse, fichiers, compte Auth,
clôture, email de clôture. Le compte visé est gardé dans `metadata.erasure.account_id` avant toute suppression :
une relance après une clôture manquée (compte déjà supprimé) termine ce qui ne dépend pas du compte et clôt la
demande au lieu d'échouer.

« Traitée » à la main : refusé pour un effacement non exécuté, sauf code `erasure_not_applicable` (rien à
effacer) ou `erasure_refused`. Un refus (« Rejetée ») exige la réponse au demandeur (motifs).

## Export d'un compte (accès, portabilité)

Bouton « Télécharger les données du compte (JSON) » : les tables de l'effacement (même liste), le compte, ses
demandes, le journal des emails et les invitations reçues à son adresse. Sans secret, jeton, empreinte ni
identifiant Stripe ou Resend brut. Le fichier se remet à l'adresse du demandeur, et à elle seule.

## Rétractation

- Abonnement : inchangé (résiliation et remboursement au prorata ou intégral). Sans abonnement Stripe sur le
  compte : 409, rien n'est modifié, la demande reste ouverte ; la clôturer avec ses motifs.
- Achat d'une vente à l'unité (choisi par la personne dans Mes droits parmi ses achats payés depuis moins de
  14 jours) : le panneau montre la date du paiement, si une vente a été ouverte avec l'achat, la renonciation cochée
  avant le paiement et l'envoi de la confirmation de commande. Les CGU (art. 2 bis et 6) prévoient la perte du droit
  de rétractation une fois l'accès fourni : **aucun refus n'est automatique**, l'opérateur décide. « Rembourser
  l'achat » rembourse tout le paiement (clé d'idempotence propre à l'achat) ; le webhook `charge.refunded` passe
  l'achat à `refunded` et retire le déblocage, sans toucher l'abonnement.
- La note d'exécution s'ajoute au journal opérateur ; l'identité vérifiée n'est pas modifiée.

## Variables d'environnement

Aucune nouvelle. Email direct à l'exploitation (facultatif, non défini en production aujourd'hui) :
`OPERATIONS_ALERT_EMAIL_TO`, `RESEND_API_KEY`, `ALERT_EMAIL_FROM`. Demandeur :
`RESEND_API_KEY`, `TRANSACTIONAL_EMAIL_FROM` (à défaut `ALERT_EMAIL_FROM`), `SITE_URL`. Effacement : `STRIPE_SECRET_KEY`
(désormais lue à chaque effacement d'un compte, pour la recherche des clients).

## Mise en production

1. Déployer le site : il fonctionne sans la migration (évaluation sautée, crédits « non vérifiables », échéance
   d'un mois pour une rétractation, `acknowledged_at` posé par la base au dépôt).
2. Appliquer `20261202100000_privacy_requests_follow_up.sql`.
3. Au passage suivant d'`operational-health`, les demandes ouvertes sans accusé ni email à l'exploitation (celles
   d'avant le déploiement) en reçoivent un, une fois.
