# Ouverture des paiements Stripe (offre Analyse)

Mise à jour : 14/11/2026 (lot A : C2, C3 et T3 de `docs/equipe/2026-11-14-etat-des-lieux.md`). Bloquant C11 de l'état
des lieux du 08/11 (`docs/equipe/2026-11-08-etat-des-lieux.md`) et ligne « Stripe configuré en production » de
`docs/roadmaps/conditions-de-lancement-2026-10-10.md`.

Le code de facturation est en place (checkout, webhook, portail, réconciliation). Ouvrir les paiements, c'est
**configurer** Stripe et Vercel, puis faire la recette en mode test **avant** de passer en production. Ce document
dit quoi faire, dans quel ordre, et comment revenir en arrière.

## 0. Ce que le code exige (ne pas le contourner)

Le checkout ne s'ouvre que si `analysisCheckoutReadiness` (`src/lib/analysis-checkout-readiness.ts`) ne signale
rien de manquant ni de fermé :

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ANALYSIS_PRICE_ID` (forme `price_…`) ;
- une clé du mode du déploiement : `sk_live_…` (ou `rk_live_…`) en Production, `sk_test_…` (ou `rk_test_…`) en
  Preview. Une clé de test en Production ferait obtenir Analyse avec la carte de test de Stripe ; une clé réelle
  sur un Preview encaisserait de vrais paiements sur une base de test. Une clé dont le mode ne se lit pas (ni `sk_` ni
  `rk_` suivi de `live_` ou `test_`) ne compte pas non plus. Dans tous ces cas le checkout reste fermé ;
- l'identité légale `NEXT_PUBLIC_LEGAL_*` ;
- le canal de confirmation contractuelle : `RESEND_API_KEY`, l'expéditeur (`TRANSACTIONAL_EMAIL_FROM` ou
  `ALERT_EMAIL_FROM`) et `SITE_URL` ;
- l'interrupteur de vente `STRIPE_ANALYSIS_SALES_OPEN` : absent, la vente est ouverte ; posé à toute autre valeur
  que `true`, il ferme le checkout (voir le § 5).

Deux autres contrôles du mode, hors de cette garde :

- le build Production est refusé avec une clé qui n'est pas du mode réel, de test ou de forme inconnue
  (`scripts/lib/launch-config.mjs`, `stripeKeyModeProblems`) ;
  `ALLOW_INCOMPLETE_LAUNCH_CONFIG` ne lève pas ce refus ;
- le webhook répond 400 à un événement dont le mode (`livemode`) n'est pas celui de la clé, avant de l'enregistrer
  ou de le traiter : un point de terminaison de test branché sur la clé réelle (ou l'inverse) n'ouvre ni ne retire
  aucun accès. Stripe rejoue alors l'événement pendant 3 jours : corriger le secret du webhook ou la clé.

Au moment du paiement, le Price est relu chez Stripe et refusé s'il n'est pas : **actif, récurrent, EUR,
5 900 centimes, mensuel (intervalle 1), comportement fiscal « inclusive »** (`resolveConfiguredAnalysisPrice`,
`src/lib/billing.ts`).

**TVA : franchise en base** (décision du 09/11/2026). Aucun taux n'est appliqué (ni Stripe Tax ni taux fixe).
Chaque client Stripe créé par le site porte en pied de facture « TVA non applicable, art. 293 B du CGI »
(`VAT_EXEMPTION_INVOICE_MENTION`, `src/lib/billing.ts`). En cas de sortie de la franchise (dépassement du seuil),
il faudra brancher un taux dans `buildAnalysisCheckoutSessionParams`, retirer la mention et revoir les libellés
« TTC ».

## 1. Événements du webhook

Point de terminaison : `<origine>/api/stripe/webhook`. Événements à cocher (et seulement ceux-là) :

| Événement                                                                      | Effet dans le code                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `checkout.session.completed`, `checkout.session.async_payment_succeeded`       | Rattache l'abonnement, confirmation de commande                                  |
| `checkout.session.expired`                                                     | Libère la réservation de checkout                                                |
| `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed` | Synchronise l'état et l'accès Analyse, confirmation de résiliation               |
| `customer.subscription.trial_will_end`                                         | Email de fin d'essai Stripe (inutile tant que le checkout est sans essai Stripe) |
| `invoice.payment_failed`                                                       | Email « Votre paiement n'a pas abouti »                                          |
| `invoice.payment_action_required`                                              | Email « Confirmez le paiement » (3-D Secure au renouvellement, C10)              |
| `charge.refunded`                                                              | Retire l'accès après un remboursement total                                      |
| `charge.dispute.created`, `charge.dispute.closed`                              | Suspend puis rétablit ou non l'accès                                             |

Un événement non listé est journalisé « ignored » : sans danger, mais inutile.

## 2. Réglages du tableau de bord Stripe (test, puis à refaire en production)

1. **Facturation → Factures → Pied de page par défaut** : « TVA non applicable, art. 293 B du CGI ». Le code le
   met déjà sur chaque client qu'il crée ; ce réglage couvre un client créé à la main.
2. **Portail client** (Paramètres → Billing → Portail client) : **enregistrer** une configuration (sans elle,
   « Gérer mon abonnement » échoue : le code utilise la configuration par défaut). Activer : mise à jour du moyen de
   paiement, historique des factures, **résiliation en fin de période**. Désactiver le changement d'offre.
3. **Relances (Smart Retries)** : garder les relances automatiques. Le délai de grâce affiché aux clients est
   `PAST_DUE_GRACE_DAYS` (7 jours, § 4 des CGV) ; la fin des relances ne doit pas tomber avant.
4. **Emails envoyés par Stripe** : le site envoie déjà ses propres emails (paiement échoué, confirmation 3-D Secure,
   résiliation). Désactiver les emails Stripe équivalents (« Envoyer un lien pour confirmer les paiements », emails
   d'échec de paiement) pour éviter les doublons. Garder les reçus de paiement Stripe (factures).
5. **Coordonnées publiques** (nom, adresse, email du support) : celles de l'éditeur, identiques à
   `NEXT_PUBLIC_LEGAL_*`.

## 3. Recette en mode test sur un déploiement Preview Vercel

Compte Stripe : « environnement de test Immojudis ». Déjà créés le 09/11/2026 :

- produit `prod_Vb9wBbHMcjd77m` « Immojudis — offre Analyse » ;
- Price `price_1UZxcpA15i2ch0eFyrVWw4yk` : 59 €, EUR, mensuel, « inclusive » (passe le contrôle du code).

### Avant de commencer : trois points à vérifier

- **La base du Preview ne doit pas être la base de production.** Les variables Supabase du Preview
  (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`…) doivent viser un projet de test : un abonnement de test écrit
  dans `user_subscriptions` ouvrirait un vrai accès Analyse.
- **Protection Vercel** : les Preview sont protégés (SSO). Stripe n'a pas de session Vercel : générer le secret
  « Protection Bypass for Automation » (Vercel → Projet → Settings → Deployment Protection) et l'ajouter à l'URL
  du webhook : `…/api/stripe/webhook?x-vercel-protection-bypass=<secret>`.
- **Emails** : le Preview n'a ni `SITE_URL`, ni `RESEND_API_KEY`, ni expéditeur. Sans eux le checkout reste fermé
  (règle du § 0). Les ajouter en cible Preview, avec un expéditeur de test, et ne s'inscrire qu'avec ses propres
  adresses.

### Variables Vercel (cible Preview, limitées à la branche de recette)

| Variable                   | Valeur                                                    |
| -------------------------- | --------------------------------------------------------- |
| `STRIPE_SECRET_KEY`        | `sk_test_…` (Stripe → Développeurs → Clés API, mode test) |
| `STRIPE_ANALYSIS_PRICE_ID` | `price_1UZxcpA15i2ch0eFyrVWw4yk`                          |
| `STRIPE_WEBHOOK_SECRET`    | `whsec_…` du point de terminaison de test                 |
| `SITE_URL`                 | URL du Preview                                            |

Redéployer le Preview après chaque changement de variable.

### Scénarios (cartes de test Stripe)

| #   | Scénario                           | Comment                                                                                              | Attendu                                                                                                                                                                                                                  |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Souscription                       | `/offres`, carte `4242 4242 4242 4242`                                                               | Retour `/offres?checkout=success`, accès Analyse ouvert, email de confirmation de commande                                                                                                                               |
| 2   | Facture                            | Stripe → Factures                                                                                    | 59,00 €, aucune TVA, pied « TVA non applicable, art. 293 B du CGI »                                                                                                                                                      |
| 3   | 3-D Secure à la souscription       | carte `4000 0027 6000 3184`                                                                          | Checkout demande la confirmation, puis accès ouvert                                                                                                                                                                      |
| 4   | 3-D Secure au renouvellement (C10) | carte `4000 0027 6000 3184`, puis horloge de test (Stripe → Abonnement → « Run simulation ») +1 mois | Email « Confirmez le paiement de votre abonnement Immojudis », lien vers la page Stripe                                                                                                                                  |
| 5   | Échec de renouvellement            | changer la carte pour `4000 0000 0000 0341`, avancer d'un mois                                       | Email « paiement n'a pas abouti », accès gardé 7 jours puis suspendu                                                                                                                                                     |
| 6   | Résiliation                        | « Mon compte » → « Résilier mon abonnement »                                                         | Résiliation en fin de période, email de confirmation, accès jusqu'à la date                                                                                                                                              |
| 7   | Rétractation (C6, C9)              | demande de rétractation, exécutée deux fois depuis l'administration                                  | Le remboursement vise la charge de la dernière facture : Stripe accepte la lecture `expand: ["latest_invoice.payments"]` (sinon 409, § 7). La seconde exécution est refusée (409, demande close) : un seul remboursement |
| 8   | Remboursement total                | Stripe → Paiement → Rembourser                                                                       | Accès Analyse retiré                                                                                                                                                                                                     |
| 9   | Litige                             | carte `4000 0000 0000 0259`                                                                          | Accès suspendu à l'ouverture du litige                                                                                                                                                                                   |
| 10  | Alerte quotidienne (C1)            | compte en fin d'essai avec une alerte quotidienne, puis souscription                                 | Alerte passée en hebdomadaire à la fin de l'essai, de nouveau quotidienne après l'abonnement                                                                                                                             |
| 11  | Webhook rejoué                     | Stripe → Webhooks → renvoyer un événement déjà traité                                                | Réponse 200 « duplicate », aucun second email                                                                                                                                                                            |
| 12  | Fermeture de la vente (§ 5)        | `STRIPE_ANALYSIS_SALES_OPEN=false` sur le Preview, redéployer, puis renouvellement (horloge de test) | Souscription fermée ; l'abonné du scénario 1 garde l'accès Analyse après le renouvellement                                                                                                                               |

La page `/admin/compliance`, panneau « Activation commerciale », doit tout afficher prêt sur le Preview.

## 4. Passage en production

1. Société créée et identité légale publiée (`NEXT_PUBLIC_LEGAL_*`, condition P1 du 31/10).
2. Migrations appliquées en production, vérifiées une par une : `20261110140000`, `20261110140100`,
   `20261113100000` (marqueur de fréquence des alertes, C1).
3. Stripe en mode **live** : refaire le § 2, créer le produit et le Price (mêmes caractéristiques), créer le webhook
   vers `https://immojudis.com/api/stripe/webhook` avec les événements du § 1.
4. Vercel, cible **Production** : `STRIPE_SECRET_KEY` (`sk_live_…`, type « sensitive » ; le build refuse toute
   autre clé), `STRIPE_WEBHOOK_SECRET` (celui du point de terminaison en mode **live**),
   `STRIPE_ANALYSIS_PRICE_ID`. Ne pas poser `STRIPE_ANALYSIS_SALES_OPEN`. Retirer `ALLOW_INCOMPLETE_LAUNCH_CONFIG`
   (il faut pour cela le § 6, `ADMIN_MFA_REQUIRED=true`). Redéployer.
5. Premier paiement réel avec sa propre carte, puis remboursement depuis Stripe : vérifier l'accès, la facture,
   les emails, puis la fin d'accès.

## 5. Retour arrière

- **Fermer la vente** sans toucher aux abonnés : dans Vercel, cible Production, poser
  `STRIPE_ANALYSIS_SALES_OPEN=false`, puis redéployer. Le checkout se ferme (`analysisCheckoutReadiness`), les
  textes repassent en « pas encore ouverte », et le panneau « Activation commerciale » de `/admin/compliance`
  affiche « Vente fermée ». Le Price reste reconnu et le rapprochement continue : les abonnés en cours gardent leur
  accès, leurs renouvellements, le portail et la résiliation.
- **Rouvrir la vente** : retirer `STRIPE_ANALYSIS_SALES_OPEN` (ou la passer à `true`), puis redéployer.
- **Ne jamais retirer `STRIPE_ANALYSIS_PRICE_ID` pour fermer la vente.** Sans lui, le Price des abonnés n'est plus
  reconnu : leur prochain événement d'abonnement les fait passer en Découverte alors qu'ils sont prélevés
  (`isRecognisedAnalysisPrice`, `src/lib/billing.ts`), et le rapprochement quotidien se tait
  (`billingReconciliationConfigured`). Pour changer de Price, ajouter d'abord l'ancien à
  `STRIPE_ANALYSIS_LEGACY_PRICE_IDS`, puis remplacer `STRIPE_ANALYSIS_PRICE_ID`.
- **Ne pas** supprimer le webhook ni la clé secrète tant qu'un abonnement existe : les renouvellements,
  résiliations et remboursements ne seraient plus répercutés sur les accès.
- Secret compromis : `docs/runbooks/fuite-secret-ou-donnees.md`.
- Écart entre Stripe et la base : la réconciliation quotidienne (`/api/cron/billing-reconciliation`) le signale ;
  rejouer les événements manqués depuis Stripe → Webhooks.

## 6. Second facteur de l'administration (actions du propriétaire)

Tant que le second facteur n'est pas exigé alors que le paiement est ouvert, ou que
`INFORMATION_AGENT_OUTBOUND_ENABLED=true`, l'accueil de `/admin` affiche l'avertissement « Second facteur non
exigé ». Un mot de passe volé suffirait pour agir sur les abonnés, écrire à des avocats ou décider au registre des
pièces. L'avertissement ne bloque rien. Il disparaît quand `ADMIN_MFA_REQUIRED=true` est déployé (étape 3).

Faire les quatre étapes dans cet ordre, sans en sauter : chaque interrupteur refuse une session sans second facteur,
et l'enrôlement doit donc précéder les trois autres.

1. **Enrôler le TOTP** : se connecter en administrateur, ouvrir `/admin/securite`, scanner le QR code avec une
   application d'authentification, saisir le code à 6 chiffres. Garder la « clé de saisie manuelle » affichée
   sous le QR code en lieu sûr (ou l'enregistrer dans une seconde application) : sans elle, perdre le téléphone
   ferme l'administration une fois les étapes 2 et 3 faites. Dès cet enrôlement, l'écran « Code de vérification » est demandé à chaque
   ouverture de l'administration.
2. **Interrupteur en base** : dans l'éditeur SQL de Supabase (rôle propriétaire de la base), exécuter
   `select app_private.set_admin_mfa_required(true);`. La fonction refuse tant qu'aucun administrateur n'a de
   facteur vérifié (étape 1). Ensuite, les droits d'administrateur en base exigent une session `aal2`.
3. **Interrupteur de l'application** : dans Vercel, cible Production, poser `ADMIN_MFA_REQUIRED=true`, retirer
   `ALLOW_INCOMPLETE_LAUNCH_CONFIG` si les mentions légales sont complètes, puis redéployer. Les routes
   d'administration refusent alors toute session sans le code (`aal1`), même appelées directement.
4. **Registre des pièces** : dans l'éditeur SQL, exécuter
   `select app_private.set_fact_registry_decisions_second_factor(true);`. Une décision au registre exige alors une
   session `aal2` (voir `docs/runbooks/registre-des-pieces-r2c.md`).

Vérifier : se déconnecter, se reconnecter, le code TOTP est demandé ; l'accueil de `/admin` n'affiche plus
l'avertissement.

Retour arrière (perte du facteur) : `select app_private.set_admin_mfa_required(false);` et
`select app_private.set_fact_registry_decisions_second_factor(false);` dans l'éditeur SQL, puis
`ADMIN_MFA_REQUIRED` retiré dans Vercel et redéploiement. Réenrôler un facteur, puis reprendre à l'étape 2.

## 7. Rétractation refusée (409)

Le bouton « Exécuter la rétractation » (Conformité, demandes RGPD et rétractations) lit tout chez Stripe avant
d'agir, et refuse sans rien changer (409) dans trois cas :

- « Plus de 100 paiements pour ce client » : la recherche d'un remboursement déjà émis ne couvrirait pas tous
  ses paiements ;
- « Paiement de la facture … introuvable parmi ceux du client » : la dernière facture a encaissé, mais sa charge
  n'est pas retrouvée ;
- « Dernière facture de l'abonnement illisible » : Stripe n'a pas rendu la facture avec ses paiements.

Dans ces cas, la rétractation se traite à la main, par le propriétaire, dans cet ordre :

1. **Vérifier qu'aucun remboursement n'est déjà émis** pour cette demande : Stripe → Clients → le client →
   chaque paiement remboursé, onglet des remboursements ; chercher la métadonnée `withdrawal_request_id` égale à
   l'identifiant de la demande. S'il en existe un, ne rien rembourser : passer à l'étape 3.
2. **Résilier dans Stripe** : Clients → le client → Abonnement → Annuler l'abonnement → **immédiatement**, sans
   cocher de remboursement dans cette boîte (le remboursement est fait à l'étape suivante, avec sa métadonnée).
3. **Rembourser la charge de la dernière facture**, et elle seule : Abonnement → Factures → dernière facture → son
   paiement (`ch_…`). Montant : tout (mode « intégral ») ou la part non fournie (mode « prorata » : jours restants
   de la période ÷ jours de la période, un jour entamé est dû), moins ce qui a déjà été remboursé sur cette charge.
   Poser la métadonnée, ce que fait la CLI Stripe (mode réel) :

   ```bash
   stripe refunds create --live --charge ch_… --amount <centimes> \
     -d "metadata[reason]=contract_withdrawal" \
     -d "metadata[withdrawal_request_id]=<identifiant de la demande>"
   ```

   La métadonnée est ce qui empêche une exécution ultérieure depuis l'administration de rembourser une seconde fois.

4. **Vérifier la fin d'accès par le webhook** : Stripe → Développeurs → Webhooks → le point de terminaison réel :
   `customer.subscription.deleted` (et `charge.refunded` pour un remboursement intégral) sont livrés en 200. Puis,
   en lecture seule : `select status, current_period_end from public.user_subscriptions where user_id = '<compte>';`
   donne `cancelled` et une date passée.
5. **Clore la demande** dans Conformité : statut « Traitée », code de résolution `withdrawal_executed_manually`,
   notes : motif du refus 409, identifiant et montant du remboursement, date de la résiliation. Puis informer la
   personne sur un support durable (`docs/compliance-phase-6.md`, « Procédure opérateur », étapes 6 et 7).
