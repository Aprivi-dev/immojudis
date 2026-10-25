# Offre de lancement : couper (ou rétablir) le surclassement des comptes gratuits

> **Depuis le 25/10/2026, l'offre de lancement est l'essai gratuit de 7 jours à l'inscription.**
> Décision du propriétaire : un compte gratuit a l'offre Analyse pendant 7 jours à compter de la
> confirmation de son adresse email, une fois par personne, sans carte bancaire ; ensuite il revient à
> Découverte, sauf abonnement. Le mécanisme ci-dessous est inchangé (même interrupteur, mêmes
> garde-fous, mêmes noms internes `launch_offer`), à une différence près : l'éligibilité d'un compte
> (`app_private.launch_offer_account_eligible`) dure 7 jours après la confirmation
> (`app_private.signup_trial_ends_at`, migration `20261103100000_signup_trial_seven_days.sql`).
>
> - L'interrupteur veut dire « l'essai à l'inscription est ouvert ». Le couper ferme les essais en cours
>   et n'en accorde plus aux nouveaux comptes.
> - Le paiement ne dépend plus de l'interrupteur : il s'ouvre quand Stripe, l'identité légale et le
>   canal de confirmation sont prêts (`analysisCheckoutReadiness`). Le checkout n'ajoute plus d'essai
>   avec carte (`STRIPE_CHECKOUT_TRIAL_OFFERED = false`).
> - Les comptes qui avaient l'offre de lancement suivent la même règle, sans email préalable (décision
>   du propriétaire du 25/10/2026, malgré l'avis de la relecture de conformité qui recommandait un email
>   d'information et un délai d'au moins 7 jours).
> - Le préavis de fin (`/admin/clients`, email `launch-offer-end-notice`) ne sert plus : chaque essai a
>   sa propre date de fin, affichée dans Mon compte.
> - CGV 2026-10-25.1 (art. 13 « Essai gratuit à l'inscription », art. 14 « Modification des
>   conditions ») et confidentialité 2026-10-25.1.
>
> Le reste de ce document décrit l'offre de lancement telle qu'elle était avant cette date.

Demande du propriétaire (19/10/2026) : « jusqu'à ce que je te le dise, on va permettre au compte
gratuit de bénéficier exceptionnellement d'un compte premium. Vu que la société n'est pas créée, vu que
Stripe n'est pas configuré [...] ». Tant que l'offre est **active**, tout compte gratuit qui a un
profil bénéficie des avantages de l'offre Analyse. Ce document dit comment elle fonctionne, comment la
couper et ce que voient ensuite les utilisateurs.

## Ce qui est en place

- **Une seule source de vérité, en base** : la table `app_private.launch_offer` (une ligne : `active`,
  `updated_at`, `updated_by`). Elle est **active dès l'application de la migration**
  `20261028120000_launch_offer.sql` (rejouer la migration ne rallume jamais une offre coupée).
- **Côté base**, les fonctions qui décident de l'accès Analyse lisent `app_private.launch_offer_active()` :
  - `app_private.current_user_has_premium_access()` (politiques RLS, déblocages, vues de découverte) ;
  - `app_private.has_active_analysis_access(uuid)` (quotas de favoris, alertes, comparaisons,
    actualisations à la demande, lecture des pièces par l'agent) ;
  - `public.has_analysis_access()` appelle la première : rien à changer.
- **Côté application** : `resolvePlanEntitlements` (`src/lib/property-reports.ts`) lit l'état par le RPC
  `get_launch_offer_status` (cache serveur de 30 s, `src/lib/launch-offer.server.ts`) et renvoie le plan
  **Analyse** pour un compte gratuit avec le marqueur `launchOffer: true`. Les pages lisent
  `GET /api/launch-offer` (cache CDN de 30 s). Aucune variable d'environnement : une seule lecture, celle de
  la base.
- **Aucune écriture** dans `user_profiles.account_tier` ni dans `user_subscriptions` : couper l'offre ramène
  chaque compte à son offre réelle, **sans nettoyage**. Un abonné, un compte premium et un administrateur ne
  sont pas concernés.
- **Jamais pour `anon`** : sans connexion, `auth.uid()` est nul. Un compte sans ligne `user_profiles` (cas
  qui ne se produit pas après l'inscription) n'est pas surclassé, ni côté base ni côté application.
- **Le paiement reste fermé.** Tant que l'offre est active, aucun écran ne propose d'achat : la carte
  Analyse de `/offres`, `/compte` et l'accueil affichent la mention de l'offre et « Tarif prévu : 59 € TTC /
  mois. Pas encore souscriptible. ».
- **Textes** (une seule source, `src/lib/launch-offer.ts`) :
  - compte connecté : « Offre de lancement : votre compte gratuit, une fois votre adresse email confirmée,
    bénéficie des avantages de l'offre Analyse. Ces avantages sont temporaires et prendront fin au plus tard
    au lancement officiel du site. Nous vous prévenons par email avant leur fin ; ils peuvent toutefois être
    retirés plus tôt, sans préavis, en cas d'abus ou d'impératif technique ou juridique. » ;
  - visiteur : « Offre de lancement : créez un compte gratuit, confirmez votre adresse email et accédez aux
    avantages de l'offre Analyse. » suivi de la même formule de durée ;
  - données (`/compte`, FAQ de `/offres`) : « Vos données (favoris, alertes, rapports enregistrés) restent
    conservées tant que votre compte existe et dans les durées de la politique de confidentialité. Elles
    redeviennent accessibles avec l'offre Analyse. »
  - Formules de la relecture juridique du 20/10/2026, à faire valider par un avocat. **Le site s'engage donc à
    prévenir par email avant la fin** : voir « Avant de couper » ; couper sans avoir envoyé ce préavis n'est
    permis que pour abus ou impératif technique ou juridique.

## Couper l'offre

### Option 1 : le bouton de `/admin/clients` (recommandé)

1. Se connecter en administrateur (double authentification comprise si `ADMIN_MFA_REQUIRED=true`).
2. Ouvrir **Admin > Clients & abonnements** : le bloc « Offre de lancement » est en haut de la page.
3. Cliquer sur **Couper l'offre de lancement** et confirmer.

Le bouton appelle `POST /api/admin/launch-offer`, protégée comme les autres routes admin (jeton vérifié,
rôle administrateur, MFA), puis le RPC `public.set_launch_offer(false)`, que la base refuse à tout autre
compte (`public.is_admin()`). La ligne enregistre `updated_at` et `updated_by`.

### Option 2 : une ligne SQL (éditeur SQL Supabase, rôle `postgres`)

```sql
update app_private.launch_offer set active = false, updated_at = statement_timestamp() where singleton;
```

Pour la rétablir : même requête avec `active = true`, ou le bouton « Rétablir l'offre de lancement ».
Vérifier l'état : `select active, updated_at, updated_by from app_private.launch_offer;`

### Délai de prise en compte

La base change **immédiatement** (politiques RLS, quotas, déblocages). L'application suit **en une minute
au plus** : cache de 30 s du serveur (`launch-offer.server.ts`, vidé tout de suite par le bouton sur
l'instance qui le reçoit) puis 30 s de cache CDN sur `/api/launch-offer`. Un navigateur déjà ouvert relit
l'état à la navigation suivante (au plus une fois par minute) ; le plan d'un compte connecté est relu à
chaque appel de `/api/feature-entitlements`.

## Ce que voient les utilisateurs après la coupure

- Le compte gratuit **redevient Découverte** : 10 favoris, 1 alerte avec email hebdomadaire, 3 déblocages
  de ventes par mois, pas d'export, de rapport PDF, d'estimation détaillée ni de comparables. Les bandeaux et
  mentions de l'offre de lancement disparaissent.
- **Aucune notification** n'est envoyée par la coupure elle-même. Le préavis par email (engagement des
  textes publics) se fait avant, par la procédure « Avant de couper » ci-dessous.
- `/offres` et l'accueil présentent l'offre payante fermée : bouton principal « Me prévenir de
  l'ouverture » (avec les trois questions facultatives de la liste d'attente) et « Tarif prévu : 59 € TTC /
  mois. Pas encore souscriptible. ». Si Stripe et la société sont prêts, la souscription s'ouvre comme avant.
- Les **données créées pendant l'offre sont conservées** (alertes, favoris au-delà de 10, rapports
  enregistrés, comparaisons, ensembles d'analyse, clés d'API). Elles ne sont ni supprimées ni modifiées :
  - les favoris au-delà de 10 restent visibles, aucun ajout n'est possible tant qu'on est au-dessus du quota ;
  - les alertes à critères avancés ou quotidiennes existent encore, mais la base refuse leur modification
    (critères réservés à Analyse) ; la création de nouvelles zones ou alertes retombe sur le quota gratuit ;
  - les rapports enregistrés, leurs exports, les espaces de travail et les clés d'API se ferment (politiques
    RLS restrictives et droits de l'API réservés à Analyse), et les listes de suivi et portefeuilles sont
    refusés (le compte garde sa comparaison gratuite) ; les données restent en base et se rouvrent si l'offre
    est rétablie ou si le compte s'abonne ;
  - les liens de partage de rapports d'un compte gratuit cessent de répondre (`shareOwnerKeepsSavedReports`).
- Les déblocages de ventes pris pendant l'offre ne comptent pas : un compte Analyse n'en consomme pas.
  Après la coupure, le compteur du mois repart de zéro pour ces comptes.

## Avant de couper : annoncer la fin (procédure décidée le 20/10/2026)

Les textes publics disent : « Nous vous prévenons par email avant leur fin ; ils peuvent toutefois être retirés
plus tôt, sans préavis, en cas d'abus ou d'impératif technique ou juridique. » Le préavis par email est donc un
engagement, pas une simple pratique (en plus de ne pas surprendre les comptes qui ont créé des contenus). Avant
de cliquer sur « Couper l'offre de lancement » :

1. **Fixer la date de coupure** et l'écrire dans le calendrier du propriétaire. Elle se situe **au moins
   30 jours après l'annonce**.
2. **Annoncer dans l'application, puis par email** à tous les comptes qui bénéficient de l'offre (compte
   gratuit à adresse email confirmée, hors abonnés, comptes premium et administrateurs), et pas seulement à
   ceux qui ont créé des contenus. Le message dit : la date, ce qui se ferme (voir la liste ci-dessus), que les
   données sont conservées tant que le compte existe et redeviennent accessibles avec l'offre Analyse, que
   `/compte` détaille « Ce qui reste gratuit » et « Ce qui demandera l'offre Analyse », et comment exporter.
   Aucun compte à rebours, aucune pression pour s'abonner.
   **Outil d'envoi (n° 74, migration `20261102140000`) : le bloc « Fin de l'offre de lancement : préavis » de
   `/admin/clients`.**
   1. Enregistrer la **date de fin annoncée** (`app_private.launch_offer.ends_on`). Elle est celle que dit le
      message ; **elle ne coupe rien** : l'offre reste active jusqu'au bouton « Couper l'offre de lancement »,
      à faire à la main ce jour-là (ou après avoir reporté la date). Une date passée est refusée.
   2. Le bloc donne le nombre de comptes concernés (ceux qui n'ont l'accès Analyse que grâce à l'offre, règle
      canonique d'éligibilité, hors administrateurs, premium et abonnés), les déjà prévenus, les désinscrits,
      et l'**aperçu** du message (`emails/launch-offer-end-notice.tsx`, ton factuel, aucun prix). « M'envoyer un
      essai » l'envoie à l'administrateur (objet « [Test] … », rien n'est journalisé).
   3. **« Envoyer le préavis à N comptes »** (après confirmation) envoie un lot de 200 au plus. **Rien n'est
      envoyé automatiquement.** L'envoi est refusé si la date est à moins de 30 jours (procédure du 20/10/2026),
      si l'offre est déjà coupée, si la date affichée n'est plus la date enregistrée, ou si l'envoi d'emails n'est
      pas configuré (`RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `SITE_URL`). Relancer pour le reste si le bloc le dit.
   4. **Idempotent** : `public.launch_offer_end_notices` (un préavis par compte et par date, réservé avant
      l'envoi ; un échec se reprend, 3 essais au plus dans les 23 h, clé d'idempotence Resend
      `immojudis-launch-offer-end-<user_id>-<date>`). Le journal est la preuve du préavis ; purgé à 24 mois par
      la tâche de rétention. Les envois « à vérifier » (essais épuisés ou vieux de plus de 23 h) ne repartent pas
      seuls : consulter le journal de Resend avant de les reprendre.
   5. **Désinscription** : chaque message porte un lien signé (et `List-Unsubscribe` en un clic). Le compte
      désinscrit entre dans `public.launch_offer_end_notice_optouts` et n'est plus jamais dans la file, pour
      aucune date ; son accès n'est pas modifié.
      Si la liste d'attente et les comptes de l'offre se recoupent, ce sont deux envois distincts (la liste
      d'attente n'est prévenue que quand la souscription est ouverte).
3. **30 jours d'accès en lecture et d'export aux contenus créés** : l'offre reste active pendant ces 30 jours,
   les comptes lisent et exportent ce qu'ils ont créé (rapports PDF, exports CSV, comparaisons). Ne pas couper
   avant la fin du délai.
   **Attention : le code et la base n'ont aucun mode « lecture et export seulement » après la coupure.** La
   coupure ferme immédiatement les rapports enregistrés, les exports et les clés d'API (voir ci-dessus). Les
   30 jours doivent donc se passer **avant** la coupure, offre active. Si le propriétaire veut un délai de
   grâce **après** la coupure, c'est un chantier à part (migration et règles d'accès).
4. **Vérifier l'état** (`select active, updated_at from app_private.launch_offer;`), puis couper (bouton de
   `/admin/clients`), puis vérifier `/offres` et `/compte` d'un compte de test.
5. **Prévenir la liste d'attente seulement quand la souscription est réellement ouverte** (voir ci-dessous) :
   le message renvoie vers `/offres`, où figurent les conditions en vigueur.

### Prévenir la liste d'attente (`/admin/clients`, bloc « Prévenir la liste d'attente »)

Les personnes qui ont cliqué sur « Me prévenir de l'ouverture » sont dans `offer_opening_notifications`. Le
bloc de `/admin/clients` :

- affiche le nombre de **destinataires actifs** (demande active, `notified_at` vide) et le nombre de personnes
  déjà prévenues ;
- montre l'**aperçu** du message ; **« M'envoyer un essai »** l'envoie à l'adresse de l'administrateur (objet
  « [Test] … », aucune écriture en base) ;
- **« Envoyer à N personnes »** envoie un lot de **200 au plus**, après confirmation : les plus anciennes
  demandes d'abord, uniquement vers des adresses confirmées, chacune avec son **lien de désinscription signé**
  (désinscription en un clic dans l'en-tête de l'email ; le lien retire la demande). Si la liste dépasse 200
  ou si le délai de 20 s est atteint, le bloc le dit : relancer pour la suite.
- Un **même destinataire n'est jamais prévenu deux fois** : `notified_at` est écrit avant l'envoi par une mise
  à jour conditionnelle ; un envoi refusé par le fournisseur retire la marque et peut être relancé. Au pire, un
  plantage entre la marque et l'envoi fait perdre un message, jamais en envoie deux.
- Prérequis : `RESEND_API_KEY`, `ALERT_EMAIL_FROM` et `SITE_URL` (les mêmes que les alertes). Sans eux, les
  boutons sont désactivés et le bloc dit ce qui manque.
- **Le texte du message (`buildOfferOpeningMessage`, `src/lib/admin-offer-opening-notifier.ts`) est à faire
  relire par le propriétaire avant le premier envoi réel.** Il est volontairement sobre : il rappelle la
  demande, renvoie vers `/offres` pour les conditions en vigueur, n'annonce aucun prix et dit qu'aucun
  abonnement n'est créé sans accord. Il dit que l'offre est ouverte : à n'envoyer que si c'est vrai.

### Bandeau d'annonce de fin configurable par l'administrateur (non implémenté)

Pas fait ici : ce n'est pas simple, car il faut une nouvelle donnée en base lue par une route publique en cache.
Conception proposée, à faire dans un chantier à part (la colonne `ends_on` existe désormais, posée par la
migration `20261102140000` du préavis par email ; le point 1 ci-dessous ne garde que `end_announcement_text`) :

1. Migration : deux colonnes sur `app_private.launch_offer` (`end_announcement_text text` borné à 300 caractères,
   `ends_on date`) et une fonction `public.set_launch_offer_announcement(text, date)` réservée à
   `public.is_admin()` (mêmes règles que `set_launch_offer`), avec son test pgTAP.
2. `GET /api/launch-offer` (`src/app/api/launch-offer/route.ts`) renvoie en plus `endsOn` et le texte ;
   `parseLaunchOfferResponse` (`src/lib/launch-offer.ts`) et le magasin `use-launch-offer.ts` les lisent
   (même cache de 30 s : l'annonce apparaît en une minute au plus).
3. Un composant de bandeau, monté dans l'en-tête, visible seulement tant que l'offre est active et qu'un texte
   est configuré, avec une hauteur réservée pendant `pending` (comme `LaunchOfferNote`), sans compte à
   rebours.
4. Un formulaire dans `AdminLaunchOfferPanel` (texte, date, aperçu) et `docs/` mis à jour.

En attendant, le message dans l'application se fait par un bandeau posé à la main dans une livraison, ou par le
seul email.

## Textes juridiques (état au 20/10/2026)

À faire valider par un avocat (par le propriétaire) :

- **Conditions générales** (`src/routes/conditions-generales.tsx`, version 2026-10-20.1) : l'article 13
  « Offre de lancement » reprend la formule du site (avantages temporaires, fin au plus tard au lancement
  officiel, préavis par email, retrait anticipé sans préavis pour abus ou impératif technique ou juridique,
  retour à Découverte sans frais ni paiement automatique ni suppression des données, aucun abonnement sans
  confirmation dans Stripe) ; il est spécial à l'offre et prévaut sur le préavis de 30 jours de l'article 2,
  qui reste celui des déblocages mensuels. Le nombre de favoris est tiré de `PLAN_LIMITS`. **Toute
  modification des textes de `src/lib/launch-offer.ts` demande de reporter la formule dans cet article
  (le texte juridique est ancré par empreinte : nouvelle version).**
- **Politique de confidentialité** (`src/routes/privacy.tsx`) : l'état de l'offre est global et ne traite
  aucune donnée personnelle ; en revanche la liste d'attente qualifiée (questions facultatives, entretien d'environ
  45 minutes) ajoute des finalités et des données (profil, volume de ventes, repères de prix, accord à un
  entretien) à décrire, avec la durée de conservation de la demande.
- **Registre des traitements** (`docs/rgpd-processing-register.md`) : mettre à jour la fiche « liste d'attente
  d'ouverture de l'offre Analyse » (nouvelles données, finalité d'étude de marché, base légale = consentement,
  conservation identique à la demande, effacement avec le compte). Non modifié ici.

## Protection contre l'abus par comptes multiples (chantier du 19/10/2026)

Pendant l'offre, créer N comptes donnerait N fois les quotas d'Analyse. Trois protections s'ajoutent ;
aucune ne gêne un usage normal.

### 1. Email confirmé exigé (base et application)

- L'offre n'ouvre les avantages qu'aux comptes dont `auth.users.email_confirmed_at` n'est pas nul
  (migration `20261028170000_launch_offer_requires_confirmed_email.sql`, fonction
  `app_private.launch_offer_account_eligible(uuid)` ; côté application, `hasConfirmedEmail` dans
  `src/lib/launch-offer.server.ts`). Avant cela, le profil étant créé à l'INSERT dans `auth.users`
  (déclencheur `handle_new_user_profile`), un compte non confirmé était surclassé.
- Un compte qui confirme son adresse reçoit l'accès à la lecture suivante (cache serveur de 10 minutes sur
  une confirmation déjà lue, pas sur un refus). Abonnés, comptes premium et administrateurs ne dépendent pas
  de cette règle.
- **À vérifier en production (Supabase > Authentication > Providers > Email)** : « Confirm email » doit être
  **activé** (`enable_confirmations = true` dans `supabase/config.toml`, mais ce fichier n'est pas appliqué
  automatiquement). Vérifier aussi qu'aucun autre fournisseur de connexion ne crée de comptes sans adresse
  vérifiée. Contrôle SQL : `select count(*) from auth.users where email_confirmed_at is null;` (ces comptes
  n'ont pas l'offre).
- Recommandé (non fait ici, demande des clés) : activer un CAPTCHA à l'inscription (Authentication >
  Attack Protection) et régler les limites de débit d'Auth (Authentication > Rate Limits : inscriptions et
  connexions par adresse IP, emails envoyés par heure). C'est la seule protection qui agit avant la création
  du compte.

### 2. Plafonds journaliers des opérations coûteuses

Constantes documentées dans `src/lib/rate-limit-policies.ts` (`DAILY_OPERATION_LIMITS`). Jour UTC, message
« Limite quotidienne atteinte, réessayez demain. » (HTTP 429, `Retry-After` jusqu'à minuit UTC). Les
compteurs vivent en base (`api_rate_limit_buckets`, `api_ip_rate_limit_buckets`), le compteur global avec une
empreinte fixe. Ils ne se consomment qu'après vérification du droit d'accès.

| Opération                                      | Par compte | Par adresse | Global (tout le site) |
| ---------------------------------------------- | ---------- | ----------- | --------------------- |
| Création / mise à jour d'un rapport enregistré | 40 / jour  | 100 / jour  | 1 000 / jour          |
| Export PDF d'un rapport                        | 60 / jour  | 150 / jour  | 2 000 / jour          |
| Dossier PLU et risques (JSON ou PDF)           | 60 / jour  | 150 / jour  | 1 500 / jour          |
| Contexte environnemental                       | 300 / jour | 600 / jour  | 4 000 / jour          |
| Actualisation de données à la demande          | 6 / 24 h   | 30 / jour   | 150 / 24 h (en base)  |

Pour relever un seuil : modifier la constante (et, pour les actualisations, la constante SQL
`global_daily_limit` de `enqueue_data_refresh_bounded` ; un test compare les deux).

Le plafond global est un disjoncteur : s'il est atteint, tous les comptes sont bloqués jusqu'à minuit UTC.
Surveiller les réponses 429 `RATE_LIMITED` dans les journaux Vercel ; si le plafond d'une opération est atteint
sans abus, le relever.

### 3. Ce qui n'a pas besoin de plafond de plus

- **Appels LLM (Replicate)** : aucune route utilisateur n'en déclenche. Les appels viennent du pipeline
  (`services/data-pipeline`), borné par `REPLICATE_MAX_CALLS_PER_HOUR` (60 par défaut, compteur en base
  `llm_request_budget`), et de l'agent d'information, réservé à l'administration.
- **Emails** : les alertes partent du cron (`ALERT_NOTIFICATION_CRON_LIMIT`, 200 par exécution par défaut,
  1 000 au plus), au plus un email par compte et par exécution, vers l'adresse (confirmée) du compte.
  Les emails d'authentification (confirmation, mot de passe) dépendent des limites d'Auth ci-dessus.
