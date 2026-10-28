# Essai gratuit de 7 jours à l'inscription (ex-offre de lancement)

Ce document a deux parties :

1. **Essai de 7 jours (actuel)** : la règle en vigueur depuis le 25/10/2026, l'interrupteur, ce que voient les
   comptes, les protections contre l'abus.
2. **Historique** : l'offre de lancement sans durée (19/10 au 25/10/2026) et ce qui a été abandonné. À lire pour
   comprendre les noms internes, pas pour agir.

Le mécanisme garde ses noms internes `launch_offer`, `launchOffer` et `LAUNCH_OFFER_*` (table
`app_private.launch_offer`, RPC `get_launch_offer_status`, routes `/api/launch-offer` et
`/api/admin/launch-offer`).

---

# Partie 1. Essai de 7 jours (actuel)

## La règle

Décision du propriétaire du 25/10/2026 : un compte gratuit a l'offre Analyse pendant **7 jours à compter de la
confirmation de son adresse email**, **une fois par personne**, **sans carte bancaire** ; ensuite il revient à
Découverte, sauf abonnement. CGV 2026-10-25.1 (article « Essai gratuit à l'inscription » et article
« Modification des conditions ») et politique de confidentialité 2026-10-25.1.

- La fin de l'essai d'un compte est `app_private.signup_trial_ends_at` : confirmation + 7 jours
  (migration `20261103100000_signup_trial_seven_days.sql`), ou rien si le compte n'y a pas droit (pas de profil,
  adresse non confirmée, adresse jetable, ou un compte plus ancien a déjà confirmé la même adresse canonique).
- L'interrupteur `app_private.launch_offer` veut dire « l'essai à l'inscription est ouvert ». Le **couper** ferme
  les essais en cours et n'en accorde plus aux nouveaux comptes (voir « Couper l'essai » : point à valider
  juridiquement).
- Le paiement ne dépend pas de l'interrupteur : il s'ouvre quand Stripe, l'identité légale et le canal de
  confirmation sont prêts (`analysisCheckoutReadiness`). Le checkout n'ajoute plus d'essai avec carte
  (`STRIPE_CHECKOUT_TRIAL_OFFERED = false`).
- Les comptes qui avaient l'ancienne offre suivent la même règle, sans email préalable (décision du propriétaire
  du 25/10/2026, malgré l'avis de la relecture de conformité qui recommandait un email d'information et un
  délai d'au moins 7 jours). Un compte confirmé depuis plus de 7 jours n'a donc plus d'essai.
- Les textes affichés viennent d'une seule source, `src/lib/launch-offer.ts`. Toute modification de ces textes
  demande de reporter la formule dans l'article des CGV (texte juridique ancré par empreinte : nouvelle
  version).

## Comment ça marche

- **Base** : les fonctions qui décident de l'accès Analyse (`app_private.current_user_has_premium_access`,
  `app_private.has_active_analysis_access`, et `public.has_analysis_access` qui appelle la première) lisent
  `app_private.launch_offer_active()` **et** `app_private.launch_offer_account_eligible(uuid)` (essai en cours
  du compte).
- **Application** : `resolvePlanEntitlements` (`src/lib/property-reports.ts`) lit l'état par le RPC
  `get_launch_offer_status` (cache serveur de 30 s, `src/lib/launch-offer.server.ts`) et la fin d'essai du compte
  par `get_signup_trial_end` ; elle renvoie le plan Analyse avec `launchOffer: true` et `trialEndsAt`. Les pages
  lisent `GET /api/launch-offer` (cache CDN de 30 s). Aucune variable d'environnement.
- **Aucune écriture** dans `user_profiles.account_tier` ni dans `user_subscriptions` : couper l'essai ramène
  chaque compte à son offre réelle, sans nettoyage. Un abonné, un compte premium et un administrateur ne sont
  pas concernés.
- **Jamais pour `anon`**, ni pour un compte sans profil ou sans adresse confirmée.
- **Mon compte** affiche la date de fin (« jusqu'au … »), puis « votre essai s'est terminé le … », ou le refus
  (`signupTrialStatusText`).
- Les données d'un compte sont conservées après l'essai (politique de confidentialité) ; elles redeviennent
  accessibles avec l'offre Analyse.

## Couper l'essai

### Option 1 : le bouton de `/admin/clients` (recommandé)

1. Se connecter en administrateur (double authentification comprise si `ADMIN_MFA_REQUIRED=true`).
2. Ouvrir **Admin > Clients & abonnements** : le bloc « Essai gratuit à l'inscription (offre de lancement) »
   est en haut de la page. Son titre dit « Essai gratuit ouvert » ou « Essai gratuit coupé ».
3. Cliquer sur **Couper l'essai gratuit**. Une boîte « Couper l'essai gratuit ? » donne le nombre de comptes qui
   perdent l'offre Analyse ; confirmer avec **Couper l'essai** (ou **Annuler**).

Le bouton appelle `POST /api/admin/launch-offer` (jeton vérifié, rôle administrateur, MFA), puis le RPC
`public.set_launch_offer(false)`, que la base refuse à tout autre compte. La ligne enregistre `updated_at` et
`updated_by`. La page annonce « Essai gratuit à l'inscription coupé : les comptes en essai reviennent à l'offre
Découverte. »

### Option 2 : une ligne SQL (éditeur SQL Supabase, rôle `postgres`)

```sql
update app_private.launch_offer set active = false, updated_at = statement_timestamp() where singleton;
```

Pour rétablir : même requête avec `active = true`, ou le bouton **Rétablir l'essai gratuit** (aucune
confirmation, car cela n'enlève rien à personne). Vérifier l'état :
`select active, updated_at, updated_by from app_private.launch_offer;`

### Délai de prise en compte

La base change **immédiatement** (politiques RLS, quotas, déblocages). L'application suit **en une minute au
plus** : cache de 30 s du serveur (vidé tout de suite par le bouton sur l'instance qui le reçoit), puis 30 s de
cache CDN sur `/api/launch-offer`. Le plan d'un compte connecté est relu à chaque appel de
`/api/feature-entitlements`.

### Point à valider avant de couper

Aujourd'hui, couper l'interrupteur retire aussi les essais **en cours**, alors que l'article des CGV ne prévoit
un arrêt que pour les nouveaux comptes (proposition n° 13 du compte-rendu du 27/10/2026, relecture
juridique-rgpd). Tant que ce point n'est pas tranché, ne couper qu'en cas d'abus ou d'impératif technique ou
juridique.

## Ce que voient les comptes quand l'essai se termine (ou est coupé)

- Le compte **redevient Découverte** : 10 favoris, 1 alerte avec email hebdomadaire, 3 déblocages de ventes par
  mois, pas d'export, de rapport PDF, d'estimation détaillée ni de comparables.
- **Aucune notification** n'est envoyée par la fin d'un essai ni par la coupure.
- `/offres` et l'accueil présentent l'offre payante fermée tant que le paiement n'est pas ouvert : bouton
  « Me prévenir de l'ouverture » (avec les trois questions facultatives de la liste d'attente) et le tarif
  prévu. Quand le paiement est ouvert, la souscription se fait comme décrit dans `docs/vercel_setup.md`.
- Les **données créées pendant l'essai sont conservées** (alertes, favoris au-delà de 10, rapports enregistrés,
  comparaisons, ensembles d'analyse, clés d'API). Elles ne sont ni supprimées ni modifiées :
  - les favoris au-delà de 10 restent visibles, aucun ajout n'est possible tant qu'on est au-dessus du quota ;
  - les alertes à critères avancés ou quotidiennes existent encore, mais la base refuse leur modification ;
    la création de nouvelles zones ou alertes retombe sur le quota gratuit ;
  - les rapports enregistrés, leurs exports, les espaces de travail et les clés d'API se ferment (politiques RLS
    restrictives et droits de l'API réservés à Analyse) ; les données restent en base et se rouvrent si le compte
    s'abonne ;
  - les liens de partage de rapports d'un compte gratuit cessent de répondre (`shareOwnerKeepsSavedReports`).
- Les déblocages de ventes pris pendant l'essai ne comptent pas : un compte Analyse n'en consomme pas. Après
  l'essai, le compteur du mois repart de zéro.

## Prolonger l'essai de comptes choisis

Voir `docs/runbooks/prolongation-essai.md` (outil « Inscriptions », limites, contrôle, retour arrière, et la
prolongation générale prévue à l'ouverture des paiements).

## Prévenir la liste d'attente (`/admin/clients`, bloc « Prévenir la liste d'attente »)

Les personnes qui ont cliqué sur « Me prévenir de l'ouverture » sont dans `offer_opening_notifications`. À
n'utiliser que quand la souscription est **réellement ouverte**. Le bloc :

- affiche le nombre de **destinataires actifs** (demande active, `notified_at` vide) et le nombre de personnes
  déjà prévenues ;
- montre l'**aperçu** du message ; **« M'envoyer un essai »** l'envoie à l'adresse de l'administrateur (objet
  « [Test] … », aucune écriture en base) ;
- **« Envoyer à N personnes »** envoie un lot de **200 au plus**, après confirmation : les plus anciennes demandes
  d'abord, uniquement vers des adresses confirmées, chacune avec son **lien de désinscription signé**
  (désinscription en un clic dans l'en-tête de l'email ; le lien retire la demande). Si la liste dépasse 200 ou
  si le délai de 20 s est atteint, le bloc le dit : relancer pour la suite ;
- n'envoie **jamais deux fois** au même destinataire : `notified_at` est écrit avant l'envoi par une mise à jour
  conditionnelle ; un envoi refusé par le fournisseur retire la marque et peut être relancé. Au pire, un
  plantage entre la marque et l'envoi fait perdre un message, jamais en envoie deux ;
- exige `RESEND_API_KEY`, `ALERT_EMAIL_FROM` et `SITE_URL` (les mêmes que les alertes). Sans eux, les boutons
  sont désactivés et le bloc dit ce qui manque.

Le texte du message (`buildOfferOpeningMessage`, `src/lib/admin-offer-opening-notifier.ts`) est à faire relire par
le propriétaire avant le premier envoi réel. Il est volontairement sobre : il rappelle la demande, renvoie vers
`/offres` pour les conditions en vigueur, n'annonce aucun prix et dit qu'aucun abonnement n'est créé sans accord.
Il dit que l'offre est ouverte : à n'envoyer que si c'est vrai.

## Protection contre l'abus par comptes multiples

Créer N comptes donnerait N essais. Trois protections s'ajoutent ; aucune ne gêne un usage normal.

### 1. Email confirmé exigé (base et application)

- L'essai n'ouvre les avantages qu'aux comptes dont `auth.users.email_confirmed_at` n'est pas nul
  (migration `20261028170000_launch_offer_requires_confirmed_email.sql`, puis `signup_trial_ends_at` ; côté
  application, `hasConfirmedEmail` dans `src/lib/launch-offer.server.ts`).
- Un compte qui confirme son adresse reçoit l'accès à la lecture suivante (cache serveur de 10 minutes sur une
  confirmation déjà lue, pas sur un refus).
- **À vérifier en production (Supabase > Authentication > Providers > Email)** : « Confirm email » doit être
  **activé** (`enable_confirmations = true` dans `supabase/config.toml`, mais ce fichier n'est pas appliqué
  automatiquement). Vérifier aussi qu'aucun autre fournisseur de connexion ne crée de comptes sans adresse
  vérifiée. Contrôle SQL : `select count(*) from auth.users where email_confirmed_at is null;` (ces comptes n'ont
  pas d'essai).
- Recommandé (non fait, demande des clés) : activer un CAPTCHA à l'inscription (Authentication > Attack
  Protection) et régler les limites de débit d'Auth (Authentication > Rate Limits). C'est la seule protection qui
  agit avant la création du compte.

### 2. Une fois par personne

Adresse canonique et domaines jetables refusés (migration `20261029110000_launch_offer_canonical_email.sql`).
Limite connue : l'unicité repose sur une table supprimée avec le compte ; supprimer puis recréer un compte avec la
même adresse peut donner un nouvel essai (constat du 27/10/2026, `paiements-stripe`, à traiter).

### 3. Plafonds journaliers des opérations coûteuses

Constantes documentées dans `src/lib/rate-limit-policies.ts` (`DAILY_OPERATION_LIMITS`). Jour UTC, message
« Limite quotidienne atteinte, réessayez demain. » (HTTP 429, `Retry-After` jusqu'à minuit UTC). Les compteurs
vivent en base (`api_rate_limit_buckets`, `api_ip_rate_limit_buckets`), le compteur global avec une empreinte
fixe. Ils ne se consomment qu'après vérification du droit d'accès. Les comptes en essai ont une part réduite des
plafonds globaux (migration `20261029110100_launch_offer_separate_global_caps.sql`).

| Opération                                      | Par compte | Par adresse | Global (tout le site) |
| ---------------------------------------------- | ---------- | ----------- | --------------------- |
| Création / mise à jour d'un rapport enregistré | 40 / jour  | 100 / jour  | 1 000 / jour          |
| Export PDF d'un rapport                        | 60 / jour  | 150 / jour  | 2 000 / jour          |
| Dossier PLU et risques (JSON ou PDF)           | 60 / jour  | 150 / jour  | 1 500 / jour          |
| Contexte environnemental                       | 300 / jour | 600 / jour  | 4 000 / jour          |
| Actualisation de données à la demande          | 6 / 24 h   | 30 / jour   | 150 / 24 h (en base)  |

Pour relever un seuil : modifier la constante (et, pour les actualisations, la constante SQL
`global_daily_limit` de `enqueue_data_refresh_bounded` ; un test compare les deux). Le plafond global est un
disjoncteur : s'il est atteint, tous les comptes sont bloqués jusqu'à minuit UTC. Surveiller les réponses 429
`RATE_LIMITED` dans les journaux Vercel ; si le plafond d'une opération est atteint sans abus, le relever.

Ce qui n'a pas besoin de plafond de plus : les appels LLM (Replicate) ne sont déclenchés par aucune route
utilisateur (pipeline borné par `REPLICATE_MAX_CALLS_PER_HOUR`, 60 par défaut) ; les emails d'alertes partent du
cron (`ALERT_NOTIFICATION_CRON_LIMIT`, 200 par exécution par défaut, 1 000 au plus), au plus un par compte et par
exécution ; les emails d'authentification dépendent des limites d'Auth.

---

# Partie 2. Historique

## L'offre de lancement sans durée (19/10 au 25/10/2026)

Demande du propriétaire (19/10/2026) : « jusqu'à ce que je te le dise, on va permettre au compte gratuit de
bénéficier exceptionnellement d'un compte premium. Vu que la société n'est pas créée, vu que Stripe n'est pas
configuré [...] ». Tant que l'offre était active, tout compte gratuit avec un profil et une adresse confirmée
avait l'offre Analyse, sans limite de durée.

- Interrupteur `app_private.launch_offer`, **actif dès l'application de la migration**
  `20261028120000_launch_offer.sql` (rejouer la migration ne rallume jamais une offre coupée).
- Le paiement restait fermé tant que l'offre était active.
- Textes d'alors : la formule « Ces avantages sont temporaires et prendront fin au plus tard au lancement
  officiel du site. Nous vous prévenons par email avant leur fin » et l'article 13 « Offre de lancement » des
  CGV 2026-10-20.1. Ils ont été remplacés par les textes de `src/lib/launch-offer.ts` et la CGV 2026-10-25.1.
- Le 25/10/2026, l'essai de 7 jours l'a remplacée (migration `20261103100000`). Le mécanisme est repris tel
  quel ; seule change l'éligibilité d'un compte, qui dure 7 jours après la confirmation.

## Ce qui a été abandonné

- **Préavis de 30 jours et envoi d'un email de fin** (procédure décidée le 20/10/2026, outil « Fin de l'offre de
  lancement : préavis » de `/admin/clients`, migration `20261102140000`) : sans objet pour un essai individuel
  de 7 jours, dont chaque compte a sa propre date de fin. L'outil est supprimé par un autre chantier
  (proposition n° 7 du compte-rendu du 27/10/2026) ; sa procédure est retirée de ce document. La table des
  désinscrits et la portée du jeton de désinscription sont conservées.
- **Bandeau d'annonce de fin configurable** : jamais implémenté.
- **Mode « lecture et export seulement » après la coupure** : n'a jamais existé (la coupure ferme les rapports
  enregistrés, les exports et les clés d'API).

## Textes juridiques d'alors

Relecture du 20/10/2026 (à faire valider par un avocat) : article 13 « Offre de lancement » des CGV
2026-10-20.1, politique de confidentialité (l'état de l'offre est global et ne traite aucune donnée personnelle ;
la liste d'attente qualifiée ajoute des finalités et des données à décrire) et fiche « liste d'attente
d'ouverture de l'offre Analyse » du registre des traitements (`docs/rgpd-processing-register.md`). Les versions
en vigueur sont celles du 25/10/2026.
