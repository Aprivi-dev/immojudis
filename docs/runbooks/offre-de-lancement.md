# Offre de lancement : couper (ou rétablir) le surclassement des comptes gratuits

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
    bénéficie des avantages de l'offre Analyse. Ces avantages pourront vous être retirés, sans préavis, à
    tout moment, notamment au lancement officiel du site. » ;
  - visiteur : « Offre de lancement : créez un compte gratuit, confirmez votre adresse email et accédez aux
    avantages de l'offre Analyse (avantages retirables sans préavis, à tout moment, notamment au lancement
    officiel). »

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
- **Aucune notification** n'est envoyée (l'offre est retirable « sans préavis »). Aucun message n'explique
  la fin de l'offre : si le propriétaire veut en annoncer la fin, c'est un envoi à décider à part.
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

## À ajouter aux textes juridiques (non modifiés par ce chantier)

À faire valider par un juriste, par le propriétaire :

- **Conditions générales** (`src/routes/conditions-generales.tsx`) : une clause « offre de lancement »
  (avantages Analyse accordés à titre gracieux aux comptes gratuits, sans engagement de durée, retirables à tout
  moment et sans préavis, sans contrepartie financière ni droit acquis) ; le nombre de favoris du compte
  gratuit est cité à l'article 2 (« trois favoris au maximum », ligne 72) et doit passer à dix ; la
  description de l'offre Découverte doit rester celle du compte une fois l'offre coupée.
- **Politique de confidentialité** (`src/routes/privacy.tsx`) : l'état de l'offre est global et ne traite
  aucune donnée personnelle ; en revanche la liste d'attente qualifiée (questions facultatives, entretien de
  20 minutes) ajoute des finalités et des données (profil, volume de ventes, repères de prix, accord à un
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
