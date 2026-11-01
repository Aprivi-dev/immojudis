# Emails d'authentification (confirmation, mot de passe, changement d'adresse)

Objet : passer les emails que Supabase envoie à chaque inscrit (confirmation d'adresse, mot de passe
oublié, changement d'adresse) de leur version par défaut (anglais, lien brut `…supabase.co/auth/v1/verify`,
expéditeur « ImmoJudis <assistant@immojudis.com> ») aux gabarits français d'Immojudis, avec un lien qui ne
consomme pas le jeton avant le clic. Public : le propriétaire (accès Supabase, Vercel, Resend).

**Rien de ceci n'est appliqué par le dépôt.** `supabase/config.toml` n'est pas appliqué à la production
(`docs/runbooks/offre-de-lancement.md`) et il ne faut jamais lancer `supabase config push`. Le propriétaire
colle chaque gabarit et son objet dans Supabase > Authentication > Emails.

## Ce que contient le dépôt

| Pièce                                                                        | Rôle                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/templates/*.html` (6 gabarits)                                     | Gabarits finaux. Le bouton mène à `{{ .SiteURL }}/auth/confirmer?token_hash={{ .TokenHash }}&type=…&redirect_to={{ .RedirectTo }}`. Déclarés dans `supabase/config.toml` (`[auth.email.template.*]`). |
| `docs/runbooks/emails-authentification/retour-arriere/*.html` (6 gabarits)   | Mêmes gabarits avec `{{ .ConfirmationURL }}` : le lien de vérification de Supabase, qui marche sans la page. Étape 3 de la bascule et retour arrière.                                                 |
| `src/app/auth/confirmer/page.tsx`, `src/components/AuthLinkConfirmation.tsx` | Page d'arrivée du lien. Elle ne vérifie rien à l'ouverture (les passerelles anti-hameçonnage ouvrent les liens) : `verifyOtp` ne part qu'au clic. Hors mesure d'audience, `noindex`.                  |
| `src/lib/auth-email-templates.ts`                                            | Source des 12 fichiers HTML. `UPDATE_AUTH_EMAIL_TEMPLATES=1 npx vitest run src/lib/auth-email-templates.test.ts` les réécrit ; sans cette variable, le test échoue s'ils s'en écartent.               |
| `src/lib/email-layout.ts`, `public/brand/email/immojudis-logo-email*-v1.png` | Modèle unique et logos (288×64, moins de 10 Ko) : les mêmes que les emails envoyés par l'application.                                                                                                 |

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
   `compte@immojudis.com` (domaine `immojudis.com` déjà vérifié dans Resend ; aucune boîte à créer pour
   envoyer). Laisser hôte, port et identifiants Resend tels quels.
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

## Expéditeur conseillé

« Immojudis <compte@immojudis.com> » : le nom d'affichage est « Immojudis » (jamais « ImmoJudis »), l'adresse
est distincte de `alertes@` (alertes, rappels, récapitulatif) et de `enquete@reponses.immojudis.com`
(agent d'information). Un rebond ou une plainte sur un message d'authentification ne se mélange donc ni avec
les alertes ni avec l'agent. Les rebonds de ces emails arrivent au webhook des emails de compte
(`/api/webhooks/resend/account-emails`, `docs/runbooks/rebonds-plaintes-emails.md`).

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

1. Dans Supabase > Authentication > Emails > Templates, recoller pour chaque gabarit le contenu de
   `docs/runbooks/emails-authentification/retour-arriere/` (lien `{{ .ConfirmationURL }}`, qui fonctionne sans
   la page `/auth/confirmer` : l'ancien parcours par fragment `#access_token` est celui de
   `PasswordRecovery` et de `detectSessionInUrl`). Les liens déjà envoyés avec `token_hash` restent valables
   tant que la page est déployée.
2. Le texte d'origine de Supabase (anglais) n'est pas conservé dans le dépôt : le relever dans le tableau de
   bord AVANT l'étape 4 de la bascule si l'on veut pouvoir le restaurer à l'identique. Les gabarits de
   `retour-arriere/` suffisent à rétablir un parcours qui fonctionne.
3. L'expéditeur se rétablit dans SMTP Settings (`assistant@immojudis.com`) ; ne le faire qu'avec l'étape 2 de la
   bascule annulée en même temps (voir plus haut).
4. Le code peut rester déployé : la page `/auth/confirmer` ne fait rien sans lien valide.

## Ce qui reste à relire

- Les textes de `invite`, `magic_link` et `reauthentication` (non validés, non émis aujourd'hui).
- Le rendu des gabarits dans Gmail, Apple Mail et Outlook (non testé ici : seules des captures Chromium ont
  été faites) ; en particulier le mode sombre et l'image du logo (`alt="Immojudis"` si les images sont bloquées).
- La limite d'envoi réelle de Supabase et de Resend (voir plus haut).
