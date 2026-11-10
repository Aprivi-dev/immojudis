# Ouverture des paiements Stripe (offre Analyse)

Mise à jour : 09/11/2026. Bloquant C11 de l'état des lieux du 08/11 (`docs/equipe/2026-11-08-etat-des-lieux.md`)
et ligne « Stripe configuré en production » de `docs/roadmaps/conditions-de-lancement-2026-10-10.md`.

Le code de facturation est en place (checkout, webhook, portail, réconciliation). Ouvrir les paiements, c'est
**configurer** Stripe et Vercel, puis faire la recette en mode test **avant** de passer en production. Ce document
dit quoi faire, dans quel ordre, et comment revenir en arrière.

## 0. Ce que le code exige (ne pas le contourner)

Le checkout ne s'ouvre que si `analysisCheckoutReadiness` (`src/lib/analysis-checkout-readiness.ts`) ne signale
rien de manquant :

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ANALYSIS_PRICE_ID` (forme `price_…`) ;
- l'identité légale `NEXT_PUBLIC_LEGAL_*` ;
- le canal de confirmation contractuelle : `RESEND_API_KEY`, l'expéditeur (`TRANSACTIONAL_EMAIL_FROM` ou
  `ALERT_EMAIL_FROM`) et `SITE_URL`.

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

| #   | Scénario                           | Comment                                                                                              | Attendu                                                                                      |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Souscription                       | `/offres`, carte `4242 4242 4242 4242`                                                               | Retour `/offres?checkout=success`, accès Analyse ouvert, email de confirmation de commande   |
| 2   | Facture                            | Stripe → Factures                                                                                    | 59,00 €, aucune TVA, pied « TVA non applicable, art. 293 B du CGI »                          |
| 3   | 3-D Secure à la souscription       | carte `4000 0027 6000 3184`                                                                          | Checkout demande la confirmation, puis accès ouvert                                          |
| 4   | 3-D Secure au renouvellement (C10) | carte `4000 0027 6000 3184`, puis horloge de test (Stripe → Abonnement → « Run simulation ») +1 mois | Email « Confirmez le paiement de votre abonnement Immojudis », lien vers la page Stripe      |
| 5   | Échec de renouvellement            | changer la carte pour `4000 0000 0000 0341`, avancer d'un mois                                       | Email « paiement n'a pas abouti », accès gardé 7 jours puis suspendu                         |
| 6   | Résiliation                        | « Mon compte » → « Résilier mon abonnement »                                                         | Résiliation en fin de période, email de confirmation, accès jusqu'à la date                  |
| 7   | Rétractation (C9)                  | demande de rétractation, exécutée deux fois depuis l'administration                                  | Un seul remboursement ; la seconde exécution note « déjà émis »                              |
| 8   | Remboursement total                | Stripe → Paiement → Rembourser                                                                       | Accès Analyse retiré                                                                         |
| 9   | Litige                             | carte `4000 0000 0000 0259`                                                                          | Accès suspendu à l'ouverture du litige                                                       |
| 10  | Alerte quotidienne (C1)            | compte en fin d'essai avec une alerte quotidienne, puis souscription                                 | Alerte passée en hebdomadaire à la fin de l'essai, de nouveau quotidienne après l'abonnement |
| 11  | Webhook rejoué                     | Stripe → Webhooks → renvoyer un événement déjà traité                                                | Réponse 200 « duplicate », aucun second email                                                |

La page `/admin/compliance`, panneau « Activation commerciale », doit tout afficher prêt sur le Preview.

## 4. Passage en production

1. Société créée et identité légale publiée (`NEXT_PUBLIC_LEGAL_*`, condition P1 du 31/10).
2. Migrations appliquées en production, vérifiées une par une : `20261110140000`, `20261110140100`,
   `20261113100000` (marqueur de fréquence des alertes, C1).
3. Stripe en mode **live** : refaire le § 2, créer le produit et le Price (mêmes caractéristiques), créer le webhook
   vers `https://immojudis.com/api/stripe/webhook` avec les événements du § 1.
4. Vercel, cible **Production** : `STRIPE_SECRET_KEY` (`sk_live_…`, type « sensitive »), `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_ANALYSIS_PRICE_ID`. Retirer `ALLOW_INCOMPLETE_LAUNCH_CONFIG`. Redéployer.
5. Premier paiement réel avec sa propre carte, puis remboursement depuis Stripe : vérifier l'accès, la facture,
   les emails, puis la fin d'accès.

## 5. Retour arrière

- **Fermer la vente** sans toucher aux abonnés : retirer `STRIPE_ANALYSIS_PRICE_ID` de Vercel et redéployer. Le
  checkout se ferme de lui-même, les textes repassent en « pas encore ouverte ».
- **Ne pas** supprimer le webhook ni la clé secrète tant qu'un abonnement existe : les renouvellements,
  résiliations et remboursements ne seraient plus répercutés sur les accès.
- Secret compromis : `docs/runbooks/fuite-secret-ou-donnees.md`.
- Écart entre Stripe et la base : la réconciliation quotidienne (`/api/cron/billing-reconciliation`) le signale ;
  rejouer les événements manqués depuis Stripe → Webhooks.
