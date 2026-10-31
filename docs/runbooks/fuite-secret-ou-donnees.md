# Fuite de secret ou de données

Objet : que faire dans les premières heures quand un secret (clé d'API, mot de passe, jeton) ou des données de
comptes ont pu être exposés, et comment tenir le registre des violations. Public : le propriétaire. Aucun
agent n'écrit en production : les changements de clés, de variables Vercel et de secrets GitHub sont faits par
le propriétaire.

Dernier essai : jamais (à dater après un exercice à blanc sur un secret de préproduction).

> **À faire relire par `juridique-rgpd`** avant le premier usage : la qualification d'une violation de données,
> les délais de notification et le modèle du registre ci-dessous.

## Les trois premières heures

1. **Ne rien supprimer.** Garder les traces (journaux Vercel, historique Git, courriels reçus, captures).
2. **Couper l'accès** avant d'enquêter : régénérer le secret exposé (tableau ci-dessous), mettre à jour tous ses
   emplacements, redéployer. Un secret exposé dans un dépôt ou un journal est considéré comme connu de tiers,
   même s'il a été retiré ensuite : l'historique Git le garde.
3. **Qualifier** : le secret ouvrait-il l'accès à des données personnelles (comptes, adresses e-mail, alertes,
   favoris, demandes de mise en relation avec un avocat, retours) ? Si oui, passer à « Fuite de données » plus
   bas, sans attendre la fin de l'enquête : le délai de notification court depuis le moment où l'on en a pris
   connaissance.
4. **Noter l'heure** de la découverte et de chaque action dans le registre (modèle plus bas).

## Tableau secret, régénération, effet de bord

Pour chaque secret : où le régénérer, où le remettre, ce qui casse ou change en le changeant. Une variable
Vercel ne s'applique qu'à un **nouveau déploiement** ; les variables `NEXT_PUBLIC_*` sont figées au build
(voir `docs/reference/variables-environnement.md`).

| Secret                                                                               | Ce qu'il ouvre                                                                               | Où le régénérer                                                                                                                       | Où le remettre                                                                                                                 | Effet de bord                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_SECRET_KEY` ou `SUPABASE_SERVICE_ROLE_KEY` (clé serveur)                   | Toute la base, **RLS contournée**                                                            | Supabase : réglages du projet, clés d'API (nouvelle clé secrète, ancienne révoquée). Clé « legacy » : changer le secret JWT du projet | Vercel (Production et Preview), secrets GitHub (`SUPABASE_SERVICE_ROLE_KEY` des workflows de collecte), `.env.local`           | Les routes serveur et la collecte échouent tant que la nouvelle clé n'est pas partout. Changer le secret JWT invalide aussi la clé publique `anon` « legacy » et les sessions ouvertes. **Si `EMAIL_UNSUBSCRIBE_SECRET` est absent, les liens de désinscription (365 jours) et de suivi des e-mails (90 jours) déjà envoyés cessent de fonctionner** (voir plus bas) |
| `SUPABASE_DB_URL` (et `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL`)                    | Postgres en direct : lecture et écriture de tout                                             | Supabase : réglages, base de données, réinitialiser le mot de passe                                                                   | Vercel, secrets GitHub `SUPABASE_DB_URL` (environnement `Production` aussi), `.env.local`                                      | Collecte, migrations, contrôle de dérive échouent jusqu'à la mise à jour. Si l'intégration Vercel–Supabase synchronise ces variables, vérifier qu'elle ne remet pas l'ancienne valeur. `SUPABASE_DB_SSL_CA` est un certificat, pas un secret                                                                                                                         |
| `CRON_SECRET`                                                                        | Les routes `/api/cron/*` et `POST /api/pipeline/revalidate-sale`                             | Tirer une nouvelle valeur aléatoire (32 octets au moins)                                                                              | Vercel, secret GitHub `CRON_SECRET`, **et Supabase Vault** : relancer `npm run ops:health-scheduler:configure` (écrit en base) | Tant que Vault porte l'ancienne valeur, les tâches planifiées par `pg_cron` reçoivent 401 et l'alerte `cron.stale` finit par s'ouvrir ; les filets quotidiens de Vercel, eux, utilisent déjà la nouvelle valeur                                                                                                                                                      |
| `STRIPE_SECRET_KEY`                                                                  | Facturation : abonnements, clients, remboursements                                           | Stripe : développeurs, clés d'API, faire tourner la clé (l'ancienne peut rester valable un court délai)                               | Vercel                                                                                                                         | Paiements et portail de facturation en erreur entre la révocation et le redéploiement                                                                                                                                                                                                                                                                                |
| `STRIPE_WEBHOOK_SECRET`                                                              | Faux événements de paiement (accès Analyse accordé à tort)                                   | Stripe : développeurs, webhooks, point de terminaison, faire tourner le secret de signature                                           | Vercel                                                                                                                         | Les événements Stripe sont rejetés (signature invalide) jusqu'au redéploiement : les accès Analyse ne se mettent plus à jour. Rejouer les événements ratés depuis Stripe                                                                                                                                                                                             |
| `RESEND_API_KEY`                                                                     | Envoi d'e-mails au nom du domaine                                                            | Resend : clés d'API (créer la nouvelle, supprimer l'ancienne)                                                                         | Vercel                                                                                                                         | Aucun e-mail (alertes, rappels, contact, avocats, incidents) entre la suppression et le redéploiement ; les alertes restent en file (`queued`) et partent au passage suivant. Voir `alerts-delivery-late.md`                                                                                                                                                         |
| `RESEND_WEBHOOK_SECRET`                                                              | Faux courriers entrants pour l'agent d'information                                           | Resend : webhook de réception, secret de signature                                                                                    | Vercel                                                                                                                         | Les réponses reçues sont rejetées jusqu'au redéploiement                                                                                                                                                                                                                                                                                                             |
| `EMAIL_UNSUBSCRIBE_SECRET`                                                           | Forger un lien de désinscription ou de suivi pour n'importe quel compte                      | Tirer une nouvelle valeur aléatoire (32 octets au moins)                                                                              | Vercel                                                                                                                         | Tous les liens déjà envoyés cessent de fonctionner (voir « La clé de désinscription »)                                                                                                                                                                                                                                                                               |
| `INFORMATION_AGENT_PORTAL_SECRET`                                                    | Forger les liens de dépôt et d'opposition de l'agent d'information                           | Tirer une nouvelle valeur aléatoire (32 octets au moins)                                                                              | Vercel                                                                                                                         | Les liens de dépôt et d'**opposition** déjà envoyés à des professionnels cessent de fonctionner : à signaler à `juridique-rgpd` avant de changer (une opposition doit rester possible). Voir `information-agent.md`                                                                                                                                                  |
| `GITHUB_SCROLL_TOKEN` (jeton GitHub)                                                 | Lancer les workflows (collecte, inondation, alertes opérationnelles) depuis le site          | GitHub : réglages du compte, jetons à portée fine, régénérer (portée minimale : le dépôt, workflows)                                  | Vercel                                                                                                                         | Le déclenchement depuis `/admin`, le traitement d'inondation (qui lance un workflow) et le canal d'alerte par défaut échouent jusqu'au redéploiement                                                                                                                                                                                                                 |
| `OPERATIONS_ALERT_WEBHOOK_SECRET`                                                    | Faux incidents sur le canal d'alerte                                                         | Chez le récepteur du webhook                                                                                                          | Vercel                                                                                                                         | Les alertes opérationnelles sont refusées par le récepteur jusqu'à la mise à jour des deux côtés                                                                                                                                                                                                                                                                     |
| `SOURCE_FETCH_RELAY_TOKEN`, `REPLICATE_API_TOKEN`, `JUDILIBRE_*` (clé, client OAuth) | Relais de collecte, génération par IA, source des décisions de justice                       | Chez chaque fournisseur                                                                                                               | Secrets GitHub (workflows de collecte et de résultats)                                                                         | Le workflow concerné échoue (collecte, enrichissement, résultats) jusqu'à la mise à jour                                                                                                                                                                                                                                                                             |
| `GEORISQUES_API_TOKEN`, `METEOSTAT_RAPIDAPI_KEY`                                     | Quotas de services tiers                                                                     | Chez le fournisseur                                                                                                                   | Vercel                                                                                                                         | Retour à l'API sans jeton (Géorisques) ; `METEOSTAT_RAPIDAPI_KEY` n'est lue par aucun code (vérifié le 28/10/2026)                                                                                                                                                                                                                                                   |
| `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`                                                    | Cartes et géocodage **sur votre quota** (le jeton est public par nature, dans le navigateur) | Mapbox : créer un nouveau jeton public, restreint aux adresses du site (URL), supprimer l'ancien                                      | Vercel, puis **redéployer** (inliné au build)                                                                                  | Cartes absentes sur les pages construites avec l'ancien jeton tant que le redéploiement n'a pas eu lieu. Voir `quotas.md`                                                                                                                                                                                                                                            |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (clé `anon`)                                  | Rien au-delà de ce que la RLS autorise : elle est publique                                   | Seulement si elle doit tourner (changement de secret JWT)                                                                             | Vercel, puis **redéployer**                                                                                                    | Pages sans données jusqu'au redéploiement                                                                                                                                                                                                                                                                                                                            |
| `RATE_LIMIT_IP_SALT`                                                                 | Retrouver une adresse IP à partir d'une empreinte                                            | Tirer une nouvelle valeur                                                                                                             | Vercel                                                                                                                         | Remet à zéro les compteurs de limite de débit par adresse                                                                                                                                                                                                                                                                                                            |

Un secret **commité dans Git** se régénère d'abord, puis se retire du code. `npm run check:secrets` (CI) cherche
les secrets dans le dépôt, mais ne remplace pas la rotation : l'historique reste lisible.

## La clé de désinscription

Les liens de désinscription des e-mails (valables 365 jours) et les liens de suivi des clics (90 jours) sont
signés avec une clé dérivée de `EMAIL_UNSUBSCRIBE_SECRET` ou, à défaut, de la clé serveur Supabase
(`SUPABASE_SERVICE_ROLE_KEY`, sinon `SUPABASE_SECRET_KEY`). **Changer cette clé invalide tous les liens
déjà envoyés** :

- un lien de désinscription périmé affiche une page « lien invalide ou expiré » (il ne désinscrit plus) ;
  la désinscription reste possible depuis le compte (préférences de notification). Un lien de suivi invalide
  mène à l'accueil.
- c'est l'effet **voulu** si la clé a fuité (des liens forgés ne fonctionnent plus), **à éviter** si la rotation
  est seulement préventive. Dans ce cas, avant de changer la clé serveur, fixer `EMAIL_UNSUBSCRIBE_SECRET` à
  la valeur que le code dérivait jusque-là : `HMAC-SHA256(ancienne clé serveur, "immojudis:email-unsubscribe:v1")`
  en hexadécimal. Calcul local, sans laisser la clé dans l'historique du terminal :

  ```bash
  read -rs OLD_KEY && export OLD_KEY
  node -e 'console.log(require("node:crypto").createHmac("sha256", process.env.OLD_KEY).update("immojudis:email-unsubscribe:v1").digest("hex"))'
  unset OLD_KEY
  ```

  Cela conserve les liens de **désinscription** ; les liens de suivi des clics (étiquette différente, dérivés
  de la clé elle-même) ne sont pas conservés, ce qui est sans conséquence grave (le clic mène à l'accueil).

- Un désabonnement doit rester possible : en cas de doute, demander à `juridique-rgpd`.

## Fuite de données

Une violation de données personnelles est un accès, une perte, une divulgation ou une altération non voulus,
qu'elle soit malveillante ou accidentelle (une table lisible par `anon` à cause d'une politique RLS erronée,
un export envoyé à la mauvaise personne, une sauvegarde perdue, une clé serveur diffusée).

1. **Arrêter la fuite** : régénérer le secret, corriger la politique, retirer l'export. Pour un défaut de droits
   dans la base, une migration corrective s'applique par le workflow « Apply Supabase Migrations » (voir
   `docs/vercel_setup.md`) ; en attendant, couper la fonctionnalité concernée si un interrupteur existe
   (`docs/runbooks/retour-arriere.md`).
2. **Établir le périmètre** : quelles tables ou fichiers, quelles personnes (comptes, avocats référencés,
   contacts de l'agent d'information), quelles colonnes (adresse e-mail, nom, alertes, demandes), sur quelle
   période. S'appuyer sur les journaux Vercel et Supabase, sans les copier hors du compte du propriétaire.
3. **Évaluer le risque pour les personnes** (faible, élevé). Le registre des traitements
   (`docs/rgpd-processing-register.md`) dit quelles données sont tenues, et la matrice de conservation
   (`docs/data-retention-matrix.md`) combien de temps.
4. **Notification** : sauf si la violation est peu susceptible d'engendrer un risque pour les personnes, elle est
   notifiée à la CNIL **dans les 72 heures** après en avoir pris connaissance (article 33 du RGPD), et aux
   personnes concernées sans retard injustifié si le risque est élevé (article 34). Une violation non notifiée
   est **quand même inscrite au registre** (ci-dessous). Les décisions de notification relèvent du
   propriétaire, avec l'avis de `juridique-rgpd` : l'équipe d'agents ne notifie personne.
5. **Informer** les sous-traitants concernés si leur propre accès est en cause (Supabase, Vercel, Resend,
   Stripe) et ouvrir un ticket chez eux si le fournisseur est l'origine.
6. **Clore** : cause, correctif, ce qui change pour éviter la répétition (test, invariant de sécurité, migration),
   puis compléter le registre.

## Registre des violations

Le RGPD (article 33, paragraphe 5) demande de documenter **toute** violation, même non notifiée. Tenir le
registre hors du dépôt (il décrit des personnes et des faits sensibles), dans un document privé du
propriétaire ; le dépôt n'en garde que le modèle. Une ligne par violation :

| Champ                          | À noter                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Référence et date de détection | Heure exacte à laquelle on en a eu connaissance (point de départ des 72 heures)  |
| Nature                         | Confidentialité, intégrité ou disponibilité ; accidentelle ou malveillante       |
| Origine et cause               | Secret exposé, politique RLS, erreur humaine, fournisseur…                       |
| Données et personnes           | Catégories de données, nombre approximatif de personnes et d'enregistrements     |
| Conséquences probables         | Pour les personnes (usurpation, démarchage, perte d'accès…)                      |
| Mesures prises                 | Rotation, correctif, retrait ; heure de chacune                                  |
| Notification CNIL              | Oui ou non, motif de la décision, date et canal utilisé (téléservice de la CNIL) |
| Information des personnes      | Oui ou non, motif, date, moyen                                                   |
| Clôture et suites              | Date, leçons, tests ou invariants ajoutés                                        |

## Voir aussi

- `docs/rgpd-processing-register.md`, `docs/data-retention-matrix.md`, `docs/compliance-phase-6.md`.
- `docs/runbooks/retour-arriere.md` pour couper une fonctionnalité ou revenir à une version saine.
- `docs/runbooks/information-agent.md` pour les liens et secrets de l'agent d'information.
- `docs/runbooks/supabase-security-advisors.md` pour les alertes de sécurité de la base.
