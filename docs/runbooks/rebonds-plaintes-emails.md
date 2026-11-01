# Rebonds et plaintes des emails de compte (webhook Resend)

Objet : retirer automatiquement le consentement email d'un compte dont l'adresse rebondit définitivement ou
dont le destinataire signale un email comme indésirable. Public : le propriétaire (accès Resend et Vercel).

Sans ce webhook, une adresse morte reste sollicitée à chaque passage et une plainte n'arrête rien : la
réputation de l'expéditeur baisse, et avec elle la livraison de tous les emails.

## Ce que fait la route

`POST /api/webhooks/resend/account-emails` (`src/app/api/webhooks/resend/account-emails/route.ts`) :

1. vérifie la signature Svix (`svix-id`, `svix-timestamp`, `svix-signature`) avec
   `RESEND_ACCOUNT_WEBHOOK_SECRET` avant toute lecture ou écriture ; signature absente ou invalide : 400 ;
2. ne retient que `email.bounced` de type **Permanent** et `email.complained` ; un rebond passager ou
   indéterminé, tout autre évènement et les emails de l'agent d'information (`INFORMATION_AGENT_EMAIL_FROM`,
   traités par l'autre webhook) sont acquittés sans effet (200) ;
3. retrouve le compte de l'adresse (`public.user_id_for_email`, migration `20261110130100`, adresse confirmée
   seulement) ; une adresse inconnue est acquittée sans effet ;
4. retire les quatre consentements email du compte (alertes, rappels d'audience, récapitulatif hebdomadaire,
   alertes de résultat) et annule ses emails d'alerte en file (`delivery_status = 'cancelled'`) ;
5. une panne (base, configuration) répond 500 : Resend rejoue l'évènement, les retraits sont idempotents.

Aucune adresse n'est écrite dans les journaux (`scope: "account-email-delivery"`, nombre de destinataires et de
comptes seulement). La personne peut redonner son accord elle-même dans ses réglages de notification.

## Mise en place (une fois)

1. Appliquer la migration `20261110130100_user_id_for_email.sql` (voir le compte rendu du lot : à appliquer par
   le propriétaire, jamais depuis l'agent).
2. Dans Resend, Webhooks, **créer un second webhook** (l'actuel, `/api/webhooks/resend/information-agent`,
   garde son secret `RESEND_WEBHOOK_SECRET`) :
   - adresse : `https://immojudis.com/api/webhooks/resend/account-emails` ;
   - évènements : `email.bounced` et `email.complained` seulement ;
   - copier son secret de signature (`whsec_…`).
3. Dans Vercel (Production, variable sensible), poser `RESEND_ACCOUNT_WEBHOOK_SECRET=whsec_…`, puis redéployer.
4. Dans Resend, envoyer l'évènement de test du webhook : la réponse doit être 200 (`ignored: true` pour un test).

Chaque webhook Resend a son propre secret : ne pas réutiliser `RESEND_WEBHOOK_SECRET`.

## Journal des envois : évènements de livraison (à abonner APRÈS le déploiement)

Les lots 3 et 4 du module « Emails » écrivent chaque envoi dans `email_send_log` (migration
`20261110210000`, à appliquer par le propriétaire avant le déploiement) et y mettent à jour l'état de remise
(`record_email_delivery_event`). Les deux webhooks acceptent sans erreur `email.delivered`,
`email.delivery_delayed` et `email.failed` en plus de `email.bounced` et `email.complained` ; ces trois
évènements sont **écrits au journal et n'ont aucun autre effet** (aucun consentement touché).

1. Déployer le code et appliquer les migrations `20261110210000` à `20261110210300`.
2. Dans Resend, ajouter `email.delivered`, `email.delivery_delayed` et `email.failed` au webhook de
   `/api/webhooks/resend/account-emails`. **Ne pas abonner `email.opened` ni `email.clicked`** : ils ne sont
   ni lus ni conservés.
3. Tant que ces évènements ne sont pas abonnés, les lignes restent à « Envoyé » ; le bouton « Actualiser » de
   l'onglet Historique relit l'état de 20 envois récents au plus chez Resend.

L'écriture au journal passe APRÈS la logique de consentement (retraits, `bounce_status`, opposition), et une
panne ou une lenteur du journal (3 s au plus) ne la retarde jamais : les retraits sont faits, puis la route répond
500 pour que Resend rejoue l'évènement (les retraits sont idempotents, test
`src/lib/email-consent-revocation-idempotence.test.ts`). Le journal n'est jamais lu pour décider d'un retrait
(test `src/lib/email-delivery-log.test.ts`).

### Si « Actualiser » affiche « Rebond » ou « Plainte » sans que le consentement ait été retiré

« Actualiser » relit seulement l'état chez Resend et l'écrit au journal : il ne retire AUCUN consentement. Si le
webhook de rebond a été perdu (désactivé, secret erroné, 500 non rejoués), le journal peut donc afficher un rebond
alors que le compte reçoit toujours ses emails. Dans ce cas : (1) corriger le webhook (section « Si les évènements
arrivent en 500 ») ; (2) dans Resend, rejouer l'évènement concerné depuis l'onglet des envois du webhook, ce qui
retire les consentements ; (3) à défaut, retirer à la main les consentements du compte concerné depuis
l'administration (Clients et abonnements) et vérifier avec la requête de la section « Vérifier ».

### Envois hors du wrapper

`sendTrackedEmail` est le seul chemin d'envoi de l'application (garde `src/lib/send-tracked-email.test.ts`).
`scripts/send-information-agent-provider-canary.mjs` (essai du fournisseur de l'agent d'information, lancé à la
main) envoie en dehors du wrapper : ses emails ne figurent donc pas au journal des envois, sauf si Resend envoie
leurs évènements de livraison (ligne de gabarit `unknown`, contenu jamais affiché). Les emails Supabase Auth
envoyés par le SMTP de Resend sont dans le même cas : leur contenu (codes à usage unique) n'est jamais lu.

## Vérifier

- Resend, Webhooks, onglet des envois : les évènements sont en 200.
- Journaux Vercel, filtre `account-email-delivery` : une ligne `bounce_permanent` ou `complaint` par évènement
  utile.
- Après un évènement réel : `select alert_email_enabled, alert_email_revoked_at from
user_notification_preferences where user_id = '<compte>';` donne `false` et une date.

## Si les évènements arrivent en 500

- Variable absente ou mal copiée : 500 « Traitement de l'évènement impossible » et, côté journal,
  `webhook_failed` ; vérifier `RESEND_ACCOUNT_WEBHOOK_SECRET`. Une signature fausse donne 400, pas 500.
- Migration non appliquée : la recherche du compte échoue (500). Appliquer la migration ; Resend rejoue.
