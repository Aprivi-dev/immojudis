# Emails d'authentification (confirmation, mot de passe, changement d'adresse)

Objet : passer les emails que Supabase envoie à chaque inscrit (confirmation d'adresse, mot de passe
oublié, changement d'adresse) de leur version par défaut (anglais, lien brut `…supabase.co/auth/v1/verify`,
expéditeur « ImmoJudis <assistant@immojudis.com> ») aux gabarits français d'Immojudis, avec un lien qui ne
consomme pas le jeton avant le clic. Public : le propriétaire (accès Supabase, Vercel, Resend).

**Rien de ceci n'est appliqué automatiquement.** `supabase/config.toml` n'est pas appliqué à la production
(`docs/runbooks/offre-de-lancement.md`) et il ne faut jamais lancer `supabase config push`. Deux voies, au
choix du propriétaire : coller chaque gabarit et son objet dans Supabase > Authentication > Emails, ou
lancer à la main le workflow « Apply Supabase Auth Config » (section « Appliquer par le workflow »).

## Ce que contient le dépôt

| Pièce                                                                        | Rôle                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supabase/templates/*.html` (6 gabarits)                                     | Gabarits finaux. Le bouton mène à `https://immojudis.com/auth/confirmer?token_hash={{ .TokenHash }}&type=…&redirect_to={{ .RedirectTo }}`. Déclarés dans `supabase/config.toml` (`[auth.email.template.*]`). |
| `docs/runbooks/emails-authentification/retour-arriere/*.html` (6 gabarits)   | Mêmes gabarits avec `{{ .ConfirmationURL }}` : le lien de vérification de Supabase, qui marche sans la page. Étape 3 de la bascule et retour arrière.                                                        |
| `src/app/auth/confirmer/page.tsx`, `src/components/AuthLinkConfirmation.tsx` | Page d'arrivée du lien. Elle ne vérifie rien à l'ouverture (les passerelles anti-hameçonnage ouvrent les liens) : `verifyOtp` ne part qu'au clic. Hors mesure d'audience, `noindex`.                         |
| `src/lib/auth-email-templates.ts`                                            | Source des 12 fichiers HTML. `UPDATE_AUTH_EMAIL_TEMPLATES=1 npx vitest run src/lib/auth-email-templates.test.ts` les réécrit ; sans cette variable, le test échoue s'ils s'en écartent.                      |
| `src/lib/email-layout.ts`, `public/brand/email/immojudis-logo-email*-v1.png` | Modèle unique et logos (288×64, moins de 10 Ko) : les mêmes que les emails envoyés par l'application.                                                                                                        |

Objets (aussi dans `config.toml`) :

| Gabarit            | Objet                                                      | Bouton                          |
| ------------------ | ---------------------------------------------------------- | ------------------------------- |
| `confirmation`     | Confirmez votre adresse email pour accéder à Immojudis     | Confirmer mon adresse           |
| `recovery`         | Réinitialisation de votre mot de passe Immojudis           | Choisir un nouveau mot de passe |
| `email_change`     | Confirmez votre nouvelle adresse email Immojudis           | Confirmer le changement         |
| `invite`           | Invitation à rejoindre Immojudis                           | Accepter l'invitation           |
| `magic_link`       | Votre lien de connexion Immojudis                          | Me connecter                    |
| `reauthentication` | Votre code de confirmation Immojudis (code `{{ .Token }}`) | (aucun : un code à saisir)      |

Les trois premiers textes sont ceux validés le 01/11/2026. `invite`, `magic_link` et `reauthentication`
ne sont émis par aucun parcours de l'application aujourd'hui (aucun `signInWithOtp`, `inviteUserByEmail` ni
`reauthenticate`) : leur texte est à relire avant de les coller, et ils peuvent rester ceux de Supabase
tant que ces parcours n'existent pas.

## Ordre de bascule

1. **Déployer le code** (page `/auth/confirmer` et logos `/brand/email/…`). Vérifier :
   `https://immojudis.com/brand/email/immojudis-logo-email-v1.png` et `…-dark-v1.png` s'affichent, et
   `https://immojudis.com/auth/confirmer?token_hash=x&type=signup` affiche « Lien incomplet » ou le bouton
   (jamais d'erreur serveur).
2. **Séparer l'expéditeur de l'agent d'information** si ce n'est pas fait. Aujourd'hui les emails
   d'authentification partent de `assistant@immojudis.com`, la même adresse que
   `INFORMATION_AGENT_EMAIL_FROM`. Tant que l'adresse est la même, un rebond ou une plainte sur un email de
   confirmation serait lu comme un évènement de l'agent par le webhook `/api/webhooks/resend/information-agent`
   (`delivery-events.ts` compare l'adresse d'expéditeur). Dans Vercel (production) :
   `INFORMATION_AGENT_EMAIL_FROM="Immojudis <enquete@reponses.immojudis.com>"` (domaine déjà vérifié en envoi et
   en réception), puis redéployer. L'agent reste de toute façon désactivé
   (`INFORMATION_AGENT_OUTBOUND_ENABLED=false`).
3. **Expéditeur de Supabase** : Authentication > Emails > SMTP Settings : nom « Immojudis », adresse
   `ne-pas-repondre@immojudis.com` (domaine `immojudis.com` déjà vérifié dans Resend ; aucune boîte à créer
   pour envoyer : c'est la même adresse « ne pas répondre » que `NOREPLY_EMAIL_FROM`, celle des alertes,
   rappels et autres emails automatiques). Les gabarits portent la phrase « Message automatique, merci de ne
   pas y répondre. Pour nous écrire : contact@immojudis.com ». Laisser hôte, port et identifiants Resend tels
   quels.
4. **Gabarits, première étape (lien de Supabase)** : relever d’abord les gabarits actuels (retour arrière complet), puis coller dans Authentication > Emails > Templates, pour chacun
   des trois (puis des trois autres si souhaité), l'objet du tableau ci-dessus et le contenu du fichier de
   `docs/runbooks/emails-authentification/retour-arriere/`. Tester avec une vraie inscription (adresse de
   test, `+alias`) : le message arrive en français, au bon expéditeur, le lien confirme le compte. Idem pour
   « Mot de passe oublié ».
5. **Gabarits, seconde étape (lien d'Immojudis)** : remplacer par le contenu des fichiers de
   `supabase/templates/`. Retester inscription, mot de passe oublié, et un lien ouvert deux fois (le second
   clic affiche « Ce lien n'est plus valable », avec le renvoi de l'email pour une inscription ; pour un mot de
   passe, la page « lien invalide ou expiré »). Vérifier que le lien du bouton porte bien
   `redirect_to=https://immojudis.com/…` (et non une adresse vide) : la page retombe sinon sur `/bienvenue`.
6. **Limites et protections** : voir ci-dessous.

Pas de désinscription ni de `List-Unsubscribe` sur ces messages : ce sont des messages de sécurité liés à une
action de la personne, sans contenu commercial.

## Appliquer par le workflow (alternative au tableau de bord)

Le workflow « Apply Supabase Auth Config » (`.github/workflows/apply-supabase-auth-config.yml`, qui lance
`scripts/apply-supabase-auth-config.mjs`) fait à la place du propriétaire ce que décrivent les étapes 3 à 5 : il lit les gabarits et leurs objets dans le dépôt
(`supabase/config.toml` et les fichiers HTML qu'il désigne, ou ceux de `retour-arriere/`), les compare à la
configuration d'authentification de la production (projet `sgpakxtyvenlpeihuucm`) par l'API de gestion de
Supabase, et ne les écrit qu'à la demande. Les étapes 1 et 2 de la bascule (code déployé, expéditeur de
l'agent séparé) restent à faire avant.

**Créer le jeton** (une fois) :

1. Supabase > avatar du compte > Account Preferences > Access Tokens
   (`https://supabase.com/dashboard/account/tokens`) > Generate new token. Nom conseillé
   `immojudis-github-auth-config`, expiration la plus courte possible (quelques jours). Le jeton est
   **personnel** : il a les droits du compte du propriétaire sur tous ses projets Supabase, pas seulement sur
   Immojudis. Il ne s'affiche qu'une fois ; ne le coller que dans le secret GitHub ci-dessous.
2. GitHub > dépôt > Settings > Secrets and variables > Actions > New repository secret (ou secret de
   l'environnement `Production`, que le workflow utilise) : nom exactement **`SUPABASE_ACCESS_TOKEN`**.
3. Une fois la bascule terminée et testée : supprimer le secret et révoquer le jeton dans Supabase.

Sans le secret, le workflow s'arrête avec l'erreur « Secret SUPABASE_ACCESS_TOKEN manquant ».

**Lancer** : GitHub > Actions > « Apply Supabase Auth Config » > Run workflow, sur la branche `main` (toute
autre branche est refusée).

| Entrée           | Valeurs                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `mode`           | `plan` (par défaut : affiche le diff, n'écrit rien) ou `apply` (écrit en production)                 |
| `confirm_target` | `production`, obligatoire pour `apply`, ignoré par `plan`                                            |
| `variant`        | `principal` (lien `/auth/confirmer`, par défaut) ou `retour-arriere` (lien `{{ .ConfirmationURL }}`) |
| `sender_email`   | facultatif, en `@immojudis.com` (`ne-pas-repondre@immojudis.com`) ; vide = SMTP non modifié          |
| `sender_name`    | facultatif (par exemple `Immojudis`) ; vide = SMTP non modifié                                       |

**Toujours lancer d'abord en `plan`** : le journal de l'étape « Plan or apply the auth configuration » montre,
pour chacun des six gabarits, l'objet et le contenu actuels de Supabase (`-`) et ceux du dépôt (`+`), puis
l'expéditeur si demandé. Relire, puis relancer avec `mode=apply` et `confirm_target=production`.

Ce que fait `apply` : contrôles locaux (gabarits en français, variables prévues, lien attendu de la variante,
adresse en `@immojudis.com`), lecture de la configuration actuelle, **enregistrement de cette configuration
(sans aucun secret) dans l'artefact de sauvegarde**, écriture des seuls champs qui diffèrent, puis relecture
pour vérifier. Il ne touche jamais à `smtp_host`, `smtp_user`, `smtp_pass` ni `smtp_port` et n'affiche ni le
jeton ni aucun mot de passe. Il applique les **six** gabarits d'un coup, y compris `invite`, `magic_link` et
`reauthentication` (voir « Ce qui reste à relire »).

Correspondance avec l'ordre de bascule : étapes 3 et 4 = un lancement `variant=retour-arriere` avec
`sender_email=ne-pas-repondre@immojudis.com` et `sender_name=Immojudis`, puis les tests de l'étape 4 ; étape 5 = un
lancement `variant=principal`, puis les tests de l'étape 5. Chaque lancement est précédé de son `plan`.

Limite connue : le script n'a été éprouvé qu'avec une API simulée. Si Supabase refuse de modifier seulement
l'adresse ou le nom de l'expéditeur sans renvoyer tout le SMTP, l'écriture échoue sans rien changer
(l'échec le dit, avec le code HTTP) : changer alors l'expéditeur dans le tableau de bord (étape 3) et relancer
sans `sender_email` ni `sender_name`.

## Sécurité du lien `/auth/confirmer`

- **`{{ .RedirectTo }}` est inséré brut** dans le `href` du bouton (`html/template` de Go l'y encode
  d'office). Dans le lien affiché en clair, où il ne l'est pas, il passe par `{{ .RedirectTo | urlquery }}`
  (contrôle local du 10/11/2026 : les six gabarits s'analysent et s'exécutent avec `html/template` de
  Go 1.24, le `href` du bouton est inchangé). La page
  compense : `redirect_to` est le dernier paramètre (tout ce qui suit lui appartient, encodé ou non) et
  n'est suivi que s'il est une page du site, une fois normalisé (`sameSitePath` : pas de `//`, de `/\`,
  d'autre origine ni de retour vers la page elle-même). Tout le reste mène à `/bienvenue`.
- **Liste d'URL autorisées de Supabase** (Authentication > URL Configuration) : la garder stricte, soit
  `https://immojudis.com/**` seulement, comme dans `supabase/config.toml` (test
  `supabase-auth-config.test.ts`). Aucune URL de préversion ni `localhost` en production : c'est elle qui
  décide quel `redirect_to` Supabase accepte d'écrire dans l'email.
- **Le jeton est dans l'adresse** : `/auth/confirmer?token_hash=…`. Le jeton est à usage unique, mais
  **ne pas exporter ni partager les journaux Vercel (requêtes, `Request Logs`, drains) sans masquer
  `token_hash`**. La page est hors mesure d'audience (Google Analytics, Vercel Analytics, Speed Insights),
  `noindex` et sans référent (`no-referrer`) ; l'adresse est effacée de la barre du navigateur au clic.

## Expéditeur conseillé

« Immojudis <ne-pas-repondre@immojudis.com> » : le nom d'affichage est « Immojudis » (jamais « ImmoJudis »),
l'adresse est celle de tous les emails automatiques aux comptes (`NOREPLY_EMAIL_FROM` : alertes, récapitulatif,
rappels, résultats, fin d'essai, ouverture de l'offre) et distincte de `enquete@reponses.immojudis.com` (agent
d'information) et de `contact@immojudis.com` (messages qui acceptent une réponse : facturation, commandes, mise
en relation). Les emails « ne pas répondre » n'ont aucun Reply-To. Un rebond ou une plainte sur un message
d'authentification ne se mélange donc pas avec l'agent. Les rebonds de ces emails arrivent au webhook des
emails de compte (`/api/webhooks/resend/account-emails`, `docs/runbooks/rebonds-plaintes-emails.md`).

À faire côté DNS par le propriétaire, hors dépôt : un enregistrement DMARC sur `immojudis.com` (constat du
01/11/2026 : aucun DMARC, aucun SPF à la racine pour les messages envoyés depuis Google Workspace).

## Limite d'envoi

- **Supabase** : Authentication > Rate Limits > « Rate limit for sending emails ». Avec un SMTP personnalisé
  la valeur par défaut est faible (de l'ordre de 30 emails par heure ; la valeur change selon le plan et les
  versions, la relire dans le tableau de bord, ce document ne la garantit pas). Elle compte les
  confirmations, les mots de passe oubliés et les renvois confondus. Une vague d'inscriptions (relance,
  publication d'un article) peut la dépasser : les personnes en trop reçoivent une erreur à l'inscription.
  Relever la valeur avant toute communication qui amène des inscrits, et laisser en place le renvoi avec
  délai de la page de connexion.
- **Resend** : le plan fixe aussi un plafond par jour et par mois (à lire dans Resend > Usage) ; les alertes,
  rappels et récapitulatifs partagent ce quota avec les emails d'authentification.
- Débit constaté avant la bascule : une trentaine d'envois d'authentification en 30 jours.

## Retour arrière

0. **Si le workflow a appliqué la configuration (`mode=apply`)** : la configuration d'avant est dans
   l'artefact `immojudis-supabase-auth-config-backup-<numéro du run>` du run concerné (GitHub > Actions > le
   run > Artifacts, conservé 90 jours). Dézipper : `immojudis-supabase-auth-config-backup.json` contient,
   sous `config`, les six objets, les six gabarits (le texte d'origine de Supabase), `smtp_admin_email` et
   `smtp_sender_name`, sans aucun secret. Pour les remettre par l'API (jeton saisi sans écho, jamais écrit
   dans un fichier ni dans l'historique) :

   ```bash
   read -rs SUPABASE_ACCESS_TOKEN && export SUPABASE_ACCESS_TOKEN
   jq '.config' immojudis-supabase-auth-config-backup.json \
     | curl -sS --fail -o /dev/null -w "%{http_code}\n" -X PATCH \
         -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
         --data @- "https://api.supabase.com/v1/projects/sgpakxtyvenlpeihuucm/config/auth"
   ```

   `200` = restauré. Une valeur `null` dans la sauvegarde veut dire « gabarit par défaut de Supabase » ; si
   l'API la refuse (non éprouvé), retirer ces clés du JSON et rétablir ces gabarits à la main. Sans jeton, on
   peut aussi recoller les textes du JSON dans Authentication > Emails. Pour seulement rétablir un parcours
   qui fonctionne (en français, lien de Supabase) sans le texte d'origine : relancer le workflow avec
   `variant=retour-arriere` (point 1).

1. Dans Supabase > Authentication > Emails > Templates, recoller pour chaque gabarit le contenu de
   `docs/runbooks/emails-authentification/retour-arriere/` (lien `{{ .ConfirmationURL }}`, qui fonctionne sans
   la page `/auth/confirmer` : l'ancien parcours par fragment `#access_token` est celui de
   `PasswordRecovery` et de `detectSessionInUrl`). Les liens déjà envoyés avec `token_hash` restent valables
   tant que la page est déployée.
2. Le texte d'origine de Supabase (anglais) n'est pas conservé dans le dépôt : le relever dans le tableau de
   bord AVANT l'étape 4 de la bascule si l'on veut pouvoir le restaurer à l'identique (le mode `apply` du workflow le garde dans son artefact de sauvegarde). Les gabarits de
   `retour-arriere/` suffisent à rétablir un parcours qui fonctionne.
3. L'expéditeur se rétablit dans SMTP Settings à sa valeur d'avant la bascule : « Immojudis
   <contact@immojudis.com> » au 02/11/2026 (la valeur exacte est `smtp_admin_email` dans l'artefact de sauvegarde du
   run `apply`, ou `sender_email=contact@immojudis.com` pour le workflow). Les gabarits de `retour-arriere/`
   portent aussi la phrase « Message automatique, merci de ne pas y répondre. Pour nous écrire : contact@… »
   (même générateur) : elle reste exacte depuis `contact@`, qui reçoit les réponses. Ne le faire qu'avec l'étape 2 de la bascule annulée en même temps (voir plus haut).
4. Le code peut rester déployé : la page `/auth/confirmer` ne fait rien sans lien valide.

## Ce qui reste à relire

- Les textes de `invite`, `magic_link` et `reauthentication` (non validés, non émis aujourd'hui).
- Le rendu des gabarits dans Gmail, Apple Mail et Outlook (non testé ici : seules des captures Chromium ont
  été faites) ; en particulier le mode sombre et l'image du logo (`alt="Immojudis"` si les images sont bloquées).
- La limite d'envoi réelle de Supabase et de Resend (voir plus haut).
