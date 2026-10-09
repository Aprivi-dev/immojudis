# Plan correctif Immojudis

Issu de l'audit complet du 9 octobre 2026 (code, production, Supabase, Vercel).
Chaque tâche indique les fichiers concernés, les étapes à suivre et le critère qui permet de la considérer comme terminée.
Les codes de la ligne « Constats » (OPS-01, LIVE-01…) renvoient au rapport d'audit.

105 tâches couvrant les 103 constats.

Règles pour la personne ou l'agent qui exécute :

- Une tâche = une PR, sauf mention contraire. Titre de PR : `[ID] titre de la tâche`.
- Lire `AGENTS.md` et la doc Next 16 dans `node_modules/next/dist/docs/` avant de toucher au code Next.
- Toute modification de base passe par une migration dans `supabase/migrations/` ; les index se créent avec le script d'index concurrents.
- Ne pas cocher une tâche tant que tous ses critères « Terminé quand » ne sont pas vérifiés.
- Les montants juridiques et fiscaux sont à confirmer sur Légifrance avant d'être codés.

## Phase 0 — Aujourd'hui

Sécuriser le compte admin, dont le mot de passe a circulé.

### P0-01 · Changer le mot de passe du compte admin et couper ses sessions

- **Qui :** Toi · **Durée estimée :** 15 min · **Constats :** SEC-02
- **Où :** Supabase › Authentication › Users

**À faire**

1. Ouvre `https://immojudis.com/mot-de-passe-oublie`, saisis l'email du compte admin et choisis un nouveau mot de passe de 16 caractères ou plus, généré par un gestionnaire de mots de passe.
2. Dans le tableau de bord Supabase (projet `immojudis`), va dans Authentication › Users, ouvre ce compte et déconnecte toutes ses sessions.
3. Reconnecte-toi sur `/login` avec le nouveau mot de passe pour vérifier.
4. Ne transmets plus jamais un mot de passe dans un chat, un ticket ou un email.

**Terminé quand**

- [ ] L'ancien mot de passe est refusé sur `/login`.
- [ ] Une seule session active pour ce compte, la tienne.

### P0-02 · Activer la double authentification et l'exiger pour tout accès admin

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** SEC-02 · **Après :** P0-01
- **Où :** `src/integrations/supabase/auth-middleware.ts:89-99` · fonction SQL `app_private.current_user_is_admin` / `public.is_admin` · nouvelle page `src/app/admin/securite`

**À faire**

1. Supabase › Authentication › Multi-Factor : active le facteur TOTP.
2. Crée une page `/admin/securite` qui enrôle un facteur TOTP : `supabase.auth.mfa.enroll({ factorType: 'totp' })`, affiche le QR code, puis `challenge` et `verify` avec le code saisi.
3. Après connexion, si `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` renvoie `nextLevel = aal2` et `currentLevel = aal1`, affiche un écran « Code de vérification » avant toute page admin.
4. Dans `auth-middleware.ts`, ne mets `isAdmin = true` que si le rôle est admin ET `claims.aal === 'aal2'`.
5. Ajoute une migration qui modifie `public.is_admin()` et `app_private.current_user_is_admin()` : ajoute la condition `coalesce(auth.jwt()->>'aal','aal1') = 'aal2'`.
6. Enrôle ton compte admin avant de déployer la migration, sinon tu perdras l'accès admin.
7. Ajoute un test : un JWT admin en `aal1` reçoit 403 sur `/api/admin/dashboard`.

**Terminé quand**

- [ ] `select count(*) from auth.mfa_factors where status='verified'` ≥ 1.
- [ ] Connexion admin sans code TOTP : accès refusé à `/admin` et aux routes `/api/admin/*`.

## Phase 1 — Bloquants avant lancement

Ce qui empêche d'ouvrir le site au public et de vendre l'offre : catalogue qui expire, obligations légales, données hors périmètre, facturation.

### P1-01 · Rendre la recherche du catalogue rapide (cause des erreurs 500)

- **Qui :** Dev · **Durée estimée :** 1–2 j · **Constats :** LIVE-01, LIVE-13
- **Où :** Fonction `app_private.search_auction_sales_preview_v3` · table `public.auction_sales` · `supabase/migrations/` · `scripts/apply-supabase-concurrent-index-operations.mjs`

**À faire**

1. Cause mesurée : pour chaque vente, la fonction lit `raw_payload` (37 Ko en moyenne, 103 Mo au total) deux fois (`publication_quarantine`, `raw_image_url`) et le passe à `sale_catalogue_entry_is_live_materialized`. Le rôle `anon` est coupé à 3 s.
2. Migration : ajoute à `auction_sales` les colonnes `publication_quarantined boolean not null default false` et `thumbnail_url text`.
3. Dans la même migration, remplis-les depuis `raw_payload`, et crée un trigger `before insert or update of raw_payload` qui les tient à jour (mêmes règles qu'aujourd'hui : URL http(s), longueur ≤ 2048).
4. Vérifie que `catalogue_expiry_materialized` et `catalogue_expiry_deadline` sont remplis pour toutes les lignes. Ensuite, réécris l'appel de `sale_catalogue_entry_is_live_materialized` pour qu'il n'ait plus besoin de `raw_payload`, ou remplace-le par une condition sur ces colonnes.
5. Réécris `app_private.search_auction_sales_preview_v3` pour n'utiliser que des colonnes, jamais `raw_payload`.
6. Ajoute via le script d'index concurrents un index partiel : `create index concurrently auction_sales_catalogue_live_idx on public.auction_sales (sale_date, id) where status in ('upcoming','unknown','postponed') and not publication_quarantined`.
7. Tri « Pertinence » : `score_desc` retombe aujourd'hui sur la date. Soit tu implémentes un vrai tri par `investment_score` (colonne indexée), soit tu renommes l'option « Date de vente » et tu supprimes le doublon.
8. Mesure avec `set role anon; explain analyze select * from public.search_auction_sales_preview_v3(p_limit=>24);` : moins de 300 ms attendu.

**Terminé quand**

- [ ] `explain analyze` en rôle `anon` < 300 ms sans filtre.
- [ ] Aucun log `57014 statement timeout` sur cette fonction pendant 24 h (Supabase › Logs).
- [ ] Résultats de `/sales` affichés en moins de 2 s en mobile 4G.

### P1-02 · Ne plus jamais afficher « 0 annonces » quand la recherche échoue

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** LIVE-01, UX-05 · **Après :** P1-01
- **Où :** `src/components/search/SearchHeader.tsx` · `src/components/search/SearchPage.tsx` · `src/components/search/SearchFilters.tsx:55-60` · `src/app/providers.tsx:10`

**À faire**

1. Dans `SearchHeader`, n'affiche le compteur `N annonces` que si la requête a réussi (`isSuccess`). En erreur, n'affiche rien à la place du compteur.
2. Remplace `ErrorState` par un bloc avec `role="alert"` : titre « Le catalogue ne répond pas pour le moment », texte « Réessayez dans quelques secondes. », bouton « Réessayer » qui appelle `refetch()`. N'affiche jamais `error.message`.
3. Dans `providers.tsx`, configure le `QueryClient` avec `defaultOptions: { queries: { retry: 1, staleTime: 60_000 } }`.

**Terminé quand**

- [ ] En simulant une erreur réseau sur la RPC (DevTools › bloquer la requête), la page affiche le bloc d'erreur et le bouton relance la recherche.
- [ ] Le texte « 0 annonces » n'apparaît que si la recherche a vraiment renvoyé 0 résultat.

### P1-03 · Remplir les mentions légales en production

- **Qui :** Toi · **Durée estimée :** 1 h · **Constats :** BIZ-03
- **Où :** Vercel › projet `immojudis-dezt` › Settings › Environment Variables (Production)

**À faire**

1. Rassemble : raison sociale, forme juridique, capital, adresse du siège, RCS ou SIREN, numéro de TVA, directeur de la publication, email et téléphone de contact, médiateur de la consommation (nom, adresse, site). Si tu n'as pas encore de médiateur, adhère à un médiateur agréé avant de vendre.
2. Crée dans Vercel, cible Production, les variables : `NEXT_PUBLIC_LEGAL_ENTITY_NAME`, `NEXT_PUBLIC_LEGAL_ENTITY_FORM`, `NEXT_PUBLIC_LEGAL_ENTITY_CAPITAL`, `NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS`, `NEXT_PUBLIC_LEGAL_REGISTRATION`, `NEXT_PUBLIC_LEGAL_VAT_NUMBER`, `NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR`, `NEXT_PUBLIC_LEGAL_CONTACT_EMAIL`, `NEXT_PUBLIC_LEGAL_CONTACT_PHONE`, `NEXT_PUBLIC_LEGAL_MEDIATOR_NAME`, `NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS`, `NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE`.
3. Redéploie la production : les variables `NEXT_PUBLIC_*` sont figées au build.
4. Fais relire `/legal`, `/conditions-generales` et `/privacy` par un juriste avant d'ouvrir le paiement.

**Terminé quand**

- [ ] Les pages `/legal`, `/conditions-generales` et `/privacy` ne contiennent plus « À renseigner ».

### P1-04 · Rendre les mentions légales obligatoires au build

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** BIZ-03 · **Après :** P1-03
- **Où :** `scripts/verify-production-env.mjs:106-117`

**À faire**

1. Supprime la condition `stripeEnabled` : en production, exige les variables `NEXT_PUBLIC_LEGAL_*` dans tous les cas.
2. Fais échouer `npm run build` avec un message clair qui liste les variables manquantes.

**Terminé quand**

- [ ] Un build de production sans `NEXT_PUBLIC_LEGAL_ENTITY_NAME` échoue.

### P1-05 · Ajouter un pied de page commun à toutes les pages publiques

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** BIZ-03, UX-01
- **Où :** Nouveau `src/components/SiteFooter.tsx` · `src/app/layout.tsx` · `src/components/HomeDiscovery.tsx:200-221`

**À faire**

1. Crée `SiteFooter` avec : Mentions légales (`/legal`), CGU/CGV (`/conditions-generales`), Confidentialité (`/privacy`), Contact (`/contact`), Offres (`/accompagnement`), Ressources (`/ressources`), et la ligne « © 2026 » suivie de la raison sociale.
2. Monte-le une seule fois dans le layout racine, sauf sous `/admin` (layout admin séparé).
3. Supprime le footer local de `HomeDiscovery.tsx`.
4. Vérifie qu'il s'affiche sous la carte sur `/sales` en mobile sans masquer la barre de filtres collante.

**Terminé quand**

- [ ] Les liens légaux sont présents sur `/sales`, une fiche `/sales/[id]`, `/login`, `/avocats`, `/zzz` (404).

### P1-06 · Mentionner les CGU et la confidentialité à l'inscription

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** BIZ-03
- **Où :** `src/routes/login.tsx` (modes Découverte et Pro)

**À faire**

1. Sous le bouton de création de compte, ajoute : « En créant un compte, vous acceptez les conditions générales et la politique de confidentialité. » avec les deux liens.
2. Enregistre la version des CGU acceptée et la date dans le profil (`commercial_acceptances` existe déjà, réutilise-la).

**Terminé quand**

- [ ] La mention et les deux liens sont visibles dans les deux modes d'inscription.

### P1-07 · Décider du périmètre géographique et aligner tout le site

- **Qui :** Toi · **Durée estimée :** 30 min de décision · **Constats :** LIVE-03, PROD-05
- **Où :** Décision produit

**À faire**

1. Constat : 5 % des ventes sont en Nouvelle-Aquitaine et le site affiche « France entière ».
2. Option A, Nouvelle-Aquitaine seule : fixe `TARGET_DEPARTMENTS=16,17,19,23,24,33,40,47,64,79,86,87` dans les variables du workflow `data-pipeline.yml` et de `recompute-existing-sales.yml`, puis passe les ventes hors zone en `status='out_of_scope'` (ne les supprime pas).
3. Option B, France entière : mets à jour toutes les promesses « Nouvelle-Aquitaine » (README, `package.json`, pages `/a-propos`, `/comment-ca-marche`, meta descriptions) et complète la table des loyers (voir P2-02).
4. Note la décision dans `docs/roadmaps/` pour que personne ne la remette en cause.

**Terminé quand**

- [ ] La décision est écrite.
- [ ] Le catalogue et les textes du site disent la même chose.

### P1-08 · Compléter le département et les coordonnées des ventes

- **Qui :** Dev · **Durée estimée :** 1–2 j · **Constats :** LIVE-03, CALC-08
- **Où :** `services/data-pipeline/src/normalize.py` · `services/data-pipeline/src/geocode.py:119-150` · migration SQL de rattrapage

**À faire**

1. Dans la normalisation, déduis `department` du code postal quand il manque : 2 premiers chiffres ; `20xxx` donne `2A` si < 20200, sinon `2B` ; `97xxx` donne les 3 premiers chiffres.
2. Si le code postal manque aussi, appelle l'API BAN avec `city` (type `municipality`) pour obtenir code postal et département.
3. Ajoute une colonne `geo_precision` (`address`, `street`, `municipality`) et géocode en repli sur la commune quand l'adresse échoue, avec `geo_precision='municipality'`.
4. Durcis le géocodage d'adresse : n'accepte `housenumber` ou `street` qu'avec un score ≥ 0,6. Sur une réponse 429, attends 1 s, puis 2 s, puis 4 s (3 essais).
5. Écris une migration ou un script de rattrapage pour les ventes existantes, puis lance `recompute-existing-sales` en `repair_only`.
6. Sur la carte, affiche les points `municipality` avec un style « position approximative ».

**Terminé quand**

- [ ] `select count(*) filter (where department is null)*100.0/count(*) from auction_sales where sale_date>=now()` < 3 %.
- [ ] Moins de 10 % des ventes à venir sans coordonnées.
- [ ] La carte place au moins 90 % des résultats.

### P1-09 · Faire basculer le statut d'une vente après son audience

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** LIVE-03, DATA-06
- **Où :** `services/data-pipeline/src/normalize.py:483-484` · `src/lib` (affichage du statut) · migration SQL

**À faire**

1. Compare les dates sur le jour civil `Europe/Paris` et non à 00:00 UTC. Une vente n'est « passée » que le lendemain de l'audience, heure de Paris.
2. Ajoute un statut d'affichage « Audience passée · résultat en attente » entre le jour de l'audience et l'arrivée du résultat.
3. Corrige les 9 ventes `upcoming` dont la date est dépassée de plus d'un jour, et ajoute ce contrôle au health check.
4. Dans `encheres_immobilieres.py:674-690`, tolère 30 jours de passé avant de passer à l'année suivante, et supprime le `status='upcoming'` forcé (l. 414).

**Terminé quand**

- [ ] À 20 h le jour de l'audience, la vente n'apparaît plus comme « à venir ».
- [ ] 0 vente `upcoming` avec une date dépassée de plus d'un jour.

### P1-10 · Nettoyer les valeurs brutes affichées (« nan », « mixed », « 1 jours »)

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** LIVE-03, LIVE-07, LIVE-13
- **Où :** Pipeline Python (écriture en base) · composants d'affichage des types et durées

**À faire**

1. Avant toute écriture en base dans le pipeline, convertis NaN en `None` (avec pandas : `df = df.astype(object).where(pd.notna(df), None)`), et rejette les chaînes `'nan'`, `'None'`, `'null'`.
2. Migration de nettoyage : `update` qui remplace par `null` les champs texte valant `'nan'` (ville, avocat, libellés de contacts, tables de l'agent IA).
3. Ajoute la traduction `mixed` → « Lot mixte » dans la table des types de bien. Tout type inconnu doit afficher « Type à préciser », jamais la valeur brute.
4. Gère le singulier : « 1 jour », « 1 pièce ».
5. Normalise la casse des communes (« Samois-sur-Seine »).

**Terminé quand**

- [ ] Aucune occurrence de « nan », « mixed » ou « 1 jours » dans le catalogue, les fiches et l'admin.

### P1-11 · Débloquer l'abonné en impayé

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** BIZ-01
- **Où :** `src/lib/plans.ts:194` · `src/components/BillingActions.tsx:151,170` · `src/lib/billing.ts:231-245, 497-526`

**À faire**

1. Affiche le bouton « Gérer mon abonnement » (portail Stripe) dès que l'utilisateur a un `stripe_customer_id`, quel que soit le statut.
2. Ajoute une période de grâce : `past_due` garde l'accès 7 jours après `current_period_end`.
3. Gère l'événement `invoice.payment_failed` dans le switch de `billing.ts` : enregistre l'échec et envoie un email « Votre paiement n'a pas abouti » avec un lien vers le portail.
4. Affiche un bandeau persistant aux utilisateurs `past_due` : « Votre dernier paiement a échoué. Mettez à jour votre moyen de paiement. »
5. Ajoute des tests sur les statuts `past_due`, `unpaid` et `canceled`.

**Terminé quand**

- [ ] Un client en `past_due` voit le bandeau et le bouton portail, et garde l'accès pendant 7 jours.
- [ ] L'email part à chaque `invoice.payment_failed`.

### P1-12 · Rendre la synchronisation Stripe sûre (ordre des événements, remboursements)

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** BIZ-02, BIZ-11
- **Où :** `src/lib/billing.ts:793-937` (`syncStripeSubscription`, `resolveStripePlanCode`, remboursements)

**À faire**

1. Dans `syncStripeSubscription`, ne fais plus confiance au payload : relis l'abonnement avec `stripe.subscriptions.retrieve(id)` avant d'écrire.
2. Stocke `stripe_event_created` dans `user_subscriptions.metadata` et ignore tout événement plus ancien que celui déjà appliqué.
3. Si l'état de paiement enregistré par `record_stripe_payment_state` est `refunded` ou `dispute_lost`, ne remets jamais le statut à `active` ; passe par une RPC SQL qui applique cette règle.
4. Pour `charge.refunded` et `charge.dispute.*`, retrouve l'utilisateur par `charge.customer` (table `user_subscriptions.stripe_customer_id`) et non par les métadonnées.
5. Dans `resolveStripePlanCode`, n'accepte que `STRIPE_ANALYSIS_PRICE_ID` ; un autre prix lève une erreur journalisée.
6. Supprime la branche `mode === 'payment'` et la phrase « paiement unique » des CGV si aucun client n'en dépend.
7. Ajoute des tests : `updated` reçu après `deleted`, remboursement suivi d'un `updated`.

**Terminé quand**

- [ ] Après un remboursement total, aucun événement ne rend l'accès.
- [ ] Les événements livrés dans le désordre ne changent pas l'état final.

### P1-13 · Créer la page « Mon compte » avec la résiliation

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** BIZ-05
- **Où :** Nouvelle page `src/app/compte/page.tsx` · `src/components/Navbar.tsx` · `src/routes/conditions-generales.tsx:116`

**À faire**

1. Crée `/compte` avec : email, offre en cours, prochaine échéance, bouton « Gérer ou résilier mon abonnement » (portail Stripe), lien vers `/mes-droits`, bouton « Supprimer mon compte ».
2. Ajoute « Mon compte » dans le menu de l'utilisateur connecté, sur tous les en-têtes.
3. Dans les CGV, remplace le renvoi vers la page Offres par un renvoi à « Mon compte › Gérer ou résilier ».

**Terminé quand**

- [ ] Depuis n'importe quelle page, un abonné atteint la résiliation en 2 clics.

### P1-14 · Confirmation de commande sur support durable et rétractation

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** BIZ-06
- **Où :** `src/lib/commercial-acceptance.ts:246` · `src/lib/privacy-requests.ts:14` · admin

**À faire**

1. Joins à l'email de confirmation de commande les CGV acceptées en PDF (version datée) et le formulaire de rétractation.
2. Dans l'admin, ajoute sur une demande `contract_withdrawal` le bouton « Résilier et rembourser » : annulation immédiate Stripe, remboursement au prorata ou total selon les CGV, puis statut traité.
3. Fais valider le texte de rétractation par un juriste (service numérique fourni pendant le délai : renonciation expresse ou non).

**Terminé quand**

- [ ] L'email de confirmation contient les 2 pièces jointes.
- [ ] Une rétractation se traite en un clic depuis l'admin.

### P1-15 · Configurer Stripe en production

- **Qui :** Toi · **Durée estimée :** 1 h · **Constats :** LIVE-04, BIZ-11 · **Après :** P1-11, P1-12, P1-13, P1-14, P1-03
- **Où :** Tableau de bord Stripe · Vercel (Production)

**À faire**

1. À faire seulement après P1-11 à P1-14. Teste d'abord tout le parcours en mode test.
2. Dans Stripe, crée le produit « Analyse » et un prix récurrent mensuel à 29 € TTC (prix TTC, taxe incluse). Configure Stripe Tax ou la TVA selon ton régime.
3. Configure le portail client : mise à jour du moyen de paiement autorisée, résiliation autorisée en fin de période, factures visibles.
4. Active dans Stripe les emails de rappel de fin d'essai et d'échec de paiement.
5. Crée le webhook vers `https://immojudis.com/api/stripe/webhook` avec les événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `customer.subscription.created/updated/deleted/paused/resumed`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`.
6. Dans Vercel Production, ajoute `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ANALYSIS_PRICE_ID`, puis redéploie.
7. Fais un vrai achat avec ta carte, résilie, puis rembourse-toi pour vérifier tout le cycle.

**Terminé quand**

- [ ] Un achat réel crée une ligne `active` dans `user_subscriptions`.
- [ ] Le remboursement coupe l'accès.
- [ ] La résiliation via le portail est prise en compte.

### P1-16 · Ne pas proposer l'essai tant que le paiement est désactivé ; prix TTC

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** LIVE-06, BIZ-11, UX-11
- **Où :** `src/lib/analysis-offer.ts:22` · `/tribunaux` · `/accompagnement` · accueil

**À faire**

1. Quand le checkout est indisponible (pas de `STRIPE_ANALYSIS_PRICE_ID`), masque tous les boutons « Découvrir l'essai », « 7 jours d'essai gratuits » et « Découvrir Analyse ». Remplace-les par « Offre bientôt disponible ».
2. Écris le prix « 29 € TTC / mois » partout, ou « 29 € / mois, TVA non applicable, art. 293 B du CGI » selon ton régime.

**Terminé quand**

- [ ] Aucun appel à l'essai visible tant que Stripe n'est pas configuré.
- [ ] Toutes les mentions du prix précisent TTC ou l'article 293 B.

### P1-17 · Obtenir une licence écrite pour les données Licitor, ou retirer le module

- **Qui :** Toi · **Durée estimée :** Variable · **Constats :** BIZ-04
- **Où :** `docs/model-card-tribunal-statistics.md:109-112` · `src/components/PremiumAdjudicationExplorer.tsx`

**À faire**

1. Écris à Licitor pour formaliser l'accord : portée (prix d'adjudication), usage commercial dans une offre payante, durée, attribution exigée.
2. Tant que l'écrit n'est pas signé, mets `ADJUDICATION_PRICE_STATISTICS_ENABLED=false` en production et retire « Prix d'adjudication par tribunal » de la page Offres.
3. Archive la licence signée dans un dossier hors dépôt et note sa référence dans la fiche modèle.

**Terminé quand**

- [ ] Licence signée archivée, ou module désactivé et retiré de l'offre.

## Phase 2 — Justesse des chiffres et des données

Ce que l'utilisateur voit et sur quoi il fonde son enchère : frais, rendements, prix et dates extraits, alertes.

### P2-01 · Corriger le barème des frais d'adjudication

- **Qui :** Dev + juriste · **Durée estimée :** 1 j · **Constats :** CALC-01
- **Où :** `src/lib/profitability.ts:8-40` · tests associés

**À faire**

1. Vérifie sur Légifrance le texte en vigueur de l'art. A444-191 du Code de commerce et ses tranches HT. Valeurs couramment publiées, à confirmer : 0–6 500 € à 7,256 %, 6 500–17 000 € à 2,993 %, 17 000–60 000 € à 1,995 %, au-delà 1,497 %.
2. Remplace `EMOLUMENT_BRACKETS` par ces valeurs, avec en commentaire la source et la date de vérification.
3. Remplace `REGISTRATION = 0.058` par une table `DMTO_RATE_BY_DEPARTMENT` construite depuis la publication annuelle de la DGFiP des taux départementaux (environ 6,32 % quand le département a voté le relèvement de 2025, sinon 5,81 %). Date la table.
4. Calcule les droits sur prix + frais préalables (charges augmentatives), et non sur le seul prix.
5. Ajoute la contribution de sécurité immobilière (0,1 %), un poste « honoraires de l'avocat enchérisseur » (saisi par l'utilisateur, 1 500 € par défaut, modifiable) et les frais de publication.
6. Prévois un cas TVA (terrain à bâtir, vendeur assujetti) : case à cocher qui remplace les droits par la TVA.
7. Écris 3 tests de non-régression sur des décomptes réels de frais d'adjudication (demande-les à un avocat partenaire).

**Terminé quand**

- [ ] Les 3 décomptes réels sont reproduits à ±1 %.
- [ ] La source et la date du barème apparaissent dans l'interface (« Barème au JJ/MM/AAAA »).

### P2-02 · Recalculer rendement et « décote » sur une base réaliste

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** CALC-02
- **Où :** `src/lib/geo.ts:105-150` · `src/lib/alert-matches.ts:396,583` · filtres « Rendement min » · export CSV · emails d'alerte

**À faire**

1. Remplace dans `estimateGrossYieldPct` la mise à prix + 10 % par le prix total d'acquisition (`computeAcquisitionCosts`) appliqué à l'estimation de marché P50, ou au plafond calculé.
2. Remplace `RENT_BY_DEPT` par les loyers par commune de la carte des loyers (ANIL / data.gouv.fr), importés dans une table `rent_reference_by_commune`, avec le département en repli.
3. Tant que la référence locale manque, n'affiche pas de rendement (« Loyer de référence indisponible ») au lieu d'utiliser 11 €/m².
4. « Décote estimée » : calcule-la sur l'estimation de marché et non sur la mise à prix ; sinon retire-la des emails et des alertes.

**Terminé quand**

- [ ] Pour une vente de Creuse ou de Corrèze, le loyer utilisé n'est plus 11 €/m².
- [ ] Le rendement affiché sur une fiche est identique dans la fiche, le CSV et l'email.

### P2-03 · Ne plus ajouter 500 €/m² de travaux par défaut

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** CALC-04
- **Où :** `src/lib/profitability.ts:40` · `src/components/BidCeilingAssistant.tsx`

**À faire**

1. Mets les travaux à 0 € par défaut, et ajoute la question « Quels travaux prévoyez-vous ? » avec les 3 scénarios (rafraîchissement, confort, premium) à choisir.
2. Montre le montant calculé (surface × €/m²) avant de l'ajouter au plafond.

**Terminé quand**

- [ ] Le plafond initial n'inclut aucun travaux tant que l'utilisateur n'en a pas choisi.

### P2-04 · Prendre en compte l'occupation du bien dans le plafond

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** CALC-05
- **Où :** `src/components/BidCeilingAssistant.tsx:951` · `src/lib/profitability.ts`

**À faire**

1. Si `occupancy_status` vaut « occupé » ou est inconnu, ajoute une ligne « Décote d'occupation » (15 % par défaut, modifiable) et un champ « Mois de portage avant libération » (12 par défaut) multiplié par les charges mensuelles saisies.
2. Affiche clairement « Bien occupé : plafond réduit de X € ».

**Terminé quand**

- [ ] Deux ventes identiques, l'une occupée et l'autre libre, donnent deux plafonds différents.

### P2-05 · Corriger le libellé « recommandée » et le scénario prudent

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** CALC-06
- **Où :** `src/components/SimplifiedSaleDetailView.tsx:1824` · `src/lib/profitability.ts:131, 271-273`

**À faire**

1. Remplace « Mise plafond recommandée » par « Mise plafond selon vos hypothèses », partout.
2. Remplace « borne basse à 80 % » par la description réelle (« 10 % des ventes comparables les moins chères »).
3. Quand le P10 manque et que le scénario prudent utilise la médiane, affiche un avertissement visible : « Données insuffisantes : ce scénario n'est pas prudent. »

**Terminé quand**

- [ ] Le mot « recommandée » n'apparaît plus à côté du plafond.

### P2-06 · Compléter le guide avec les règles qui engagent l'acheteur

- **Qui :** Toi + Dev · **Durée estimée :** ½ j · **Constats :** CALC-07
- **Où :** `src/routes/ventes-immobilieres-judiciaires.tsx:575-640`

**À faire**

1. Ajoute une section « Ce qui vous engage » avec : surenchère d'au moins 10 % possible dans les 10 jours ; consignation de 10 % de la mise à prix, avec un minimum de 3 000 €, par chèque de banque ou caution bancaire ; paiement du prix dans les 2 mois, puis intérêts au taux légal ; frais préalables à payer rapidement ; avocat obligatoirement inscrit au barreau du tribunal judiciaire de la vente.
2. Fais relire cette section par un avocat et indique la date de relecture.

**Terminé quand**

- [ ] Les 5 règles figurent sur la page, relues par un avocat.

### P2-07 · Utiliser l'API DVF de production

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** CODE-01
- **Où :** `src/lib/market.functions.ts:38`

**À faire**

1. Remplace `https://apidf-preprod.cerema.fr/...` par l'URL de production de l'API DVF du Cerema (vérifie-la sur la documentation du Cerema).
2. Rends-la configurable avec la variable `CEREMA_DVF_BASE_URL` (valeur par défaut : l'URL de production).
3. Fixe une durée de cache explicite (`next: { revalidate: 86400 }`) au lieu de `force-cache` sans durée (`market.functions.ts:511`, `dvf-data-gouv.ts:339`).

**Terminé quand**

- [ ] Plus aucune occurrence de `preprod` dans `src/`.

### P2-08 · Fiabiliser le modèle de valorisation

- **Qui :** Dev data · **Durée estimée :** 2–3 j · **Constats :** CALC-03
- **Où :** `services/data-pipeline/src/valuation_training.py:438-668` · `src/lib/hybrid-market-valuation.ts:94-97` · `.github/workflows/valuation-model-training.yml:30`

**À faire**

1. Après validation sur le découpage chronologique, réentraîne le modèle publié sur train + calibration, puis recalibre sur la fenêtre la plus récente.
2. Fais calculer `local_median_log` et `local_spread_log` par la même fonction à l'entraînement et en production : exporte les statistiques par cellule H3 dans l'artefact, ou utilise en entraînement la sélection de comparables de la production.
3. Corrige la fuite : leave-one-out aussi pour l'écart-type, statistiques de cellules calculées sur le seul passé de chaque ligne.
4. Mets `activate: false` par défaut dans le workflow et exige, pour activer, une APE médiane meilleure que le modèle actif ET qu'une référence naïve (médiane locale).

**Terminé quand**

- [ ] Un modèle moins bon que l'actif ne s'active jamais.
- [ ] Le rapport d'entraînement compare nouveau modèle, modèle actif et référence naïve.

### P2-09 · Corriger la lecture du prix d'adjudication

- **Qui :** Dev data · **Durée estimée :** ½ j · **Constats :** DATA-01
- **Où :** `services/data-pipeline/src/normalize.py:205-224`

**À faire**

1. Exige « € » ou « euros » après le nombre dans les 3 motifs, refuse un nombre suivi de « / » (une date), et rejette un résultat inférieur à 1 000 € ou à 10 % de la mise à prix.
2. Ajoute des tests avec : « Bien adjugé 12/03/2025 pour 150 000 € » (150 000), « Lot adjugé 1 fois » (aucun), « adjugé : 85 000 euros » (85 000).
3. Recalcule les ventes `adjudicated` existantes et repasse en revue celles dont le prix change.

**Terminé quand**

- [ ] Les 3 tests passent.
- [ ] Aucune vente en base avec un prix d'adjudication inférieur à 1 000 €.

### P2-10 · Arrêter d'inventer des dates

- **Qui :** Dev data · **Durée estimée :** ½ j · **Constats :** DATA-02
- **Où :** `services/data-pipeline/src/normalize.py:330-342`

**À faire**

1. Remplace `parser.parse(..., fuzzy=True)` par un appel avec `default=` égal à une date sentinelle (par exemple 1900-01-01), et rejette le résultat si l'année, le mois ou le jour sont restés à la sentinelle.
2. Exige jour, mois et année (ou un format ISO) ; sinon renvoie `None`.
3. Tests : « lot 3 au 2ème étage » donne `None`, « mardi à 14h30 » donne `None`, « 15 mars à 14h » sans année donne `None`, « 15 mars 2027 à 14h » donne la bonne date.

**Terminé quand**

- [ ] Les 4 tests passent.

### P2-11 · Ne plus diviser la mise à prix par 10 sur les ventes multi-lots

- **Qui :** Dev data · **Durée estimée :** ½ j · **Constats :** DATA-03
- **Où :** `services/data-pipeline/src/normalize.py:160-170`

**À faire**

1. Ne laisse le texte l'emporter sur la valeur explicite que si les deux proviennent du même lot ou du même bloc.
2. Sinon, garde la valeur explicite et ajoute `price_conflict=true` à la vente pour une revue dans l'admin (qualité des données).
3. Tests : explicite 60 000 et texte « Mise à prix : 6 000 € (lot 2) » donnent 60 000 avec conflit.

**Terminé quand**

- [ ] Le test passe.
- [ ] Les conflits apparaissent dans `/admin/quality`.

### P2-12 · Rendre l'import DVF atomique

- **Qui :** Dev data · **Durée estimée :** 1 j · **Constats :** DATA-04
- **Où :** `.github/workflows/dvf-import.yml:131-171` · `services/data-pipeline/src/dvf_import.py:948-966`

**À faire**

1. Charge chaque fichier dans une table de staging `dvf_transactions_staging`, puis, quand tous les fichiers sont chargés, fais dans une seule transaction : `alter table dvf_transactions rename to dvf_transactions_old`, renomme la staging en `dvf_transactions`, recrée les index et supprime l'ancienne.
2. Supprime `--replace-existing` de la boucle par ressource ; un seul remplacement à la fin.
3. Ajoute `timeout=120` aux téléchargements et une liste blanche de domaines (`data.gouv.fr`, `files.data.gouv.fr`, `static.data.gouv.fr`) pour `resource_url`.

**Terminé quand**

- [ ] Un import interrompu au milieu laisse `dvf_transactions` intact.

### P2-13 · Collecter de façon identifiable et respectueuse

- **Qui :** Dev data + Toi · **Durée estimée :** 1 j · **Constats :** DATA-05
- **Où :** `services/data-pipeline/src/config.py:139-146` · `src/sources/cessions_etat.py:74` · `src/sources/petites_affiches.py:167` · `src/sources/cloud_transport.py:15` · `src/pdf_enrichment.py:431,659` · `src/sources/common.py:323`

**À faire**

1. Remplace le User-Agent Chrome usurpé par `ImmojudisBot/1.0 (+https://immojudis.com/contact)` partout.
2. Définis la variable `AUCTION_USER_AGENT` dans les variables GitHub des workflows `data-pipeline`, `recompute-existing-sales` et `source-coverage-audit`.
3. Applique robots.txt et un délai par hôte (1,5 s minimum) aux téléchargements de PDF, en réutilisant `RobotsRules`.
4. Applique `Crawl-delay` : `delay = max(delay_seconds, crawl_delay)`.
5. Toi : pour chaque source (Licitor, Petites Affiches, cessions de l'État, avocats, tribunaux), vérifie les CGU, écris la conclusion dans un tableau, et désactive toute source qui interdit la collecte.
6. N'utilise plus le relais Paris pour contourner un blocage ; s'il sert à autre chose, documente-le.

**Terminé quand**

- [ ] Aucun User-Agent de navigateur dans `services/`.
- [ ] Tableau des CGU par source rempli et daté.

### P2-14 · Corriger le dédoublonnage

- **Qui :** Dev data · **Durée estimée :** 1 j · **Constats :** DATA-07
- **Où :** `services/data-pipeline/src/dedupe.py:94-98, 356-361`

**À faire**

1. Dans la passe `source_url`, fusionne l'ancienne observation dans la nouvelle avec `_merge_into` au lieu de la remplacer (documents, observations, champs).
2. Dans la passe par adresse, compare la date au jour civil Paris et exige date ET prix identiques, ou une surface identique. Deux prix différents ne doivent jamais fusionner.
3. Ne fusionne pas une remise en vente (surenchère, folle enchère) avec la vente précédente : exige la même date d'audience.
4. Tests sur les 3 cas.

**Terminé quand**

- [ ] Les tests passent ; aucune perte de documents lors d'une fusion.

### P2-15 · Détecter les annulations sans changement de prix ni de date

- **Qui :** Dev data · **Durée estimée :** ½ j · **Constats :** DATA-08
- **Où :** `services/data-pipeline/src/sources/common.py:684-700` · `normalize.py:86`

**À faire**

1. Ajoute le statut ou le badge de la carte (« annulée », « reportée », « retirée ») à la signature incrémentale.
2. Test : une carte qui passe de « à venir » à « annulée » déclenche la relecture de la page de détail.

**Terminé quand**

- [ ] Le test passe.

### P2-16 · Plafonner le coût LLM dans tous les modes

- **Qui :** Dev data · **Durée estimée :** ½ j · **Constats :** DATA-09
- **Où :** `services/data-pipeline/src/pipeline_usage.py:64-67` · table des prix `TOKEN_PRICES`

**À faire**

1. Applique la réservation de budget même sans `PIPELINE_AUTONOMOUS_RUN_ID`.
2. Ajoute un budget journalier global en euros (variable `LLM_DAILY_BUDGET_EUR`, 5 € par défaut) partagé par le pipeline, les backfills et l'agent d'information.
3. Refuse tout appel à un modèle absent de `TOKEN_PRICES`.

**Terminé quand**

- [ ] Un backfill manuel s'arrête quand le budget du jour est atteint.

### P2-17 · Réparer les vignettes bloquées

- **Qui :** Dev data · **Durée estimée :** ½ j · **Constats :** LIVE-05 · **Après :** P1-01
- **Où :** Pipeline (extraction de `raw_image_url`) · `thumbnail_url` (P1-01)

**À faire**

1. À l'import, ne garde une image que si une requête HEAD renvoie `200` avec `content-type: image/*` et sans `cross-origin-resource-policy: same-origin`.
2. Exclus les URL `annonces-legales.petites-affiches.fr/vae/json/vignette/` et `petitesaffiches.fr/.../template-vlimmo.png`.
3. Sans image valide, affiche un pictogramme du type de bien au lieu d'une mini-carte Mapbox par fiche.

**Terminé quand**

- [ ] 0 requête d'image bloquée sur `/sales` (DevTools › Console).
- [ ] `/sales` pèse moins de 1,5 Mo au premier chargement.

### P2-18 · Normalisation factorisée et formats de prix

- **Qui :** Dev data · **Durée estimée :** 1 j · **Constats :** DATA-10
- **Où :** `_normalize_surface_number` (6 copies), `_enrich_sale_from_detail` (8), `_extract_surface` (7) · `normalize.py:111-128`

**À faire**

1. Crée une seule version de chaque fonction dans `services/data-pipeline/src/sources/common.py` et supprime les copies.
2. Gère « M€ » et « k€ » dans `parse_price` et rejette un prix inférieur à 100 €.
3. Tests : « 1,5 M€ » donne 1 500 000 ; « 85 k€ » donne 85 000 ; « 1 234,5 m² » donne 1234.5 dans toutes les sources.

**Terminé quand**

- [ ] Une seule définition de chaque fonction dans `services/`.

### P2-19 · Délai maximal sur les connexions Postgres du pipeline

- **Qui :** Dev data · **Durée estimée :** 1 h · **Constats :** DATA-11
- **Où :** `services/data-pipeline/src/storage/supabase_client.py:4751-4768`

**À faire**

1. Ajoute `options='-c statement_timeout=120000'` par défaut à `_postgres_connect`, et un délai plus long seulement pour l'entraînement.
2. Réutilise une connexion par processus au lieu d'en ouvrir une par prédiction (`pipeline_usage`, `source_detail_source_enabled`).

**Terminé quand**

- [ ] Une requête bloquée échoue en 2 minutes au lieu de 180.

### P2-20 · Filtrer le texte généré avant publication

- **Qui :** Dev data · **Durée estimée :** ½ j · **Constats :** DATA-12
- **Où :** Génération de `display_description`

**À faire**

1. Avant d'enregistrer `display_description`, rejette ou nettoie tout texte qui contient une URL, un email, un numéro de téléphone ou une instruction à l'impératif adressée au lecteur.
2. Journalise les rejets pour revue.

**Terminé quand**

- [ ] Un PDF piégé contenant « Appelez le 06… » ne fait pas apparaître le numéro sur la fiche.

### P2-21 · Alertes : évaluer toutes les ventes nouvelles pour tous les utilisateurs

- **Qui :** Dev · **Durée estimée :** 1–2 j · **Constats :** PROD-02, UX-06
- **Où :** `src/lib/alert-matches.ts:70-72, 130-140, 251-266, 519-533` · `SMART_ALERT_CRON_*`

**À faire**

1. Remplace la sélection des 160 premières ventes par : ventes créées ou modifiées depuis la dernière évaluation de chaque alerte, filtrées en SQL par département, prix, type et surface.
2. Supprime la limite de 25 utilisateurs par exécution ; découpe en lots si besoin, mais traite tout le monde chaque jour.
3. Dans `systemAuthForUser`, utilise l'offre réelle de l'utilisateur au lieu de `accountTier: "free"`.
4. Regroupe les ventes trouvées pour un même utilisateur en un seul email récapitulatif par jour.
5. Expose les fréquences quotidienne et hebdomadaire dans l'interface ; retire « immédiate » tant qu'elle n'existe pas réellement.

**Terminé quand**

- [ ] Avec 100 alertes de test, toutes sont évaluées en une exécution.
- [ ] N ventes trouvées pour un utilisateur donnent 1 seul email.

### P2-22 · Emails : consentement à l'envoi et désinscription conforme

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** BIZ-07
- **Où :** `src/lib/alert-notifications.ts:132, 363-384` · `src/lib/email-alerts.ts:128-159, 184, 305-308` · `src/app/api/notification-preferences/unsubscribe/route.ts`

**À faire**

1. Juste avant chaque envoi, revérifie le consentement et l'offre ; annule les notifications en attente d'un utilisateur désinscrit ou dont l'offre a pris fin.
2. Remplace le lien de désinscription par un jeton HMAC signé, avec une expiration de 60 jours, qui identifie l'utilisateur et le type d'email.
3. Fais modifier l'état par un `POST` ; le `GET` affiche une page de confirmation avec un bouton.
4. Ajoute les en-têtes `List-Unsubscribe` et `List-Unsubscribe-Post: List-Unsubscribe=One-Click` aux emails d'alerte.
5. Propose une désinscription par alerte en plus de la désinscription globale.

**Terminé quand**

- [ ] Un scanner qui suit le lien (`GET`) ne désinscrit personne.
- [ ] Gmail affiche le lien « Se désabonner » natif.

## Phase 3 — Fiabilité de la production

Pipeline sur main, crons qui se rattrapent, alertes utiles, base soulagée.

### P3-01 · Remettre la production sur main

- **Qui :** Dev + Toi · **Durée estimée :** ½ j · **Constats :** OPS-02, LIVE-09
- **Où :** Branche `codex/infrastructure-worker-20261008` · Vercel › variable `GITHUB_SCROLL_REF` (Production)

**À faire**

1. Ouvre une PR de `codex/infrastructure-worker-20261008` vers `main` (23 commits d'avance, 74 de retard). Merge `main` dedans, résous les conflits, fais passer la CI, puis merge.
2. Dans Vercel Production, remets `GITHUB_SCROLL_REF=main` (c'est la variable qui choisit la ref du worker, voir `src/lib/pipeline-dispatch.ts:108`). Vérifie aussi `OPERATIONS_ALERT_GITHUB_REF=main`, puis redéploie.
3. Si tu veux un gel de version, utilise un tag créé sur `main` (`worker-AAAA-MM-JJ`), jamais une branche de travail.
4. Supprime ensuite les branches `codex/*` déjà mergées.

**Terminé quand**

- [ ] Les exécutions « Immojudis Data Pipeline » affichent `main` (ou un tag de `main`) comme branche.
- [ ] `git log origin/main..origin/codex/infrastructure-worker-20261008` est vide.

### P3-02 · Réessayer automatiquement un cron qui échoue

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** OPS-01
- **Où :** `src/lib/cron-jobs.ts` (`runMonitoredCron`, `beginRun`, `operationalErrorMessage`) · `vercel.json`

**À faire**

1. Dans `runMonitoredCron`, réessaie `beginRun` et le handler jusqu'à 3 fois (attente 5 s, 20 s, 60 s) quand l'erreur est réseau ou 5xx (522, 503, `ECONNRESET`).
2. Ajoute dans `vercel.json` un second horaire de rattrapage pour `smart-alerts`, `alert-notifications` et `sale-change-monitor` (par exemple 2 h plus tard). Le handler sort immédiatement si une exécution a déjà réussi dans la journée.
3. Dans `operationalErrorMessage`, si le message est une page HTML, remplace-le par un résumé : « Supabase injoignable (HTTP 522) ».
4. Écris une exécution `failed` même quand `beginRun` échoue (au retour de la base), pour que l'échec soit visible.

**Terminé quand**

- [ ] En coupant la base 1 minute au moment du cron (test en preview), le cron réussit au rattrapage.
- [ ] Aucun message d'erreur ne contient `<!DOCTYPE html>`.

### P3-03 · Arrêter le bruit des alertes opérationnelles

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** OPS-03
- **Où :** `.github/workflows/operational-alert.yml` · `src/lib/operational-alerts.ts` · table `operational_alerts`

**À faire**

1. N'envoie une notification qu'à l'ouverture d'un incident, puis un rappel par 24 h tant qu'il reste ouvert, puis à la résolution.
2. Ajoute une colonne `reopened_at` distincte de `first_seen_at` et affiche-la.
3. Regroupe en une seule exécution GitHub les incidents ouverts au même tick, au lieu d'un job par incident.
4. Traite `valuation.queue.degraded` (ouvert depuis le 19 août) : soit tu corriges la file, soit tu relèves le seuil (365 ventes sans données suffisantes est un état normal, pas une panne).

**Terminé quand**

- [ ] Au plus une notification par incident et par jour.
- [ ] Le workflow d'alerte est vert quand aucun nouvel incident n'apparaît.

### P3-04 · Soulager la base de données

- **Qui :** Dev · **Durée estimée :** 1–2 j · **Constats :** LIVE-02
- **Où :** Supabase (projet `immojudis`) · `supabase/migrations/` · advisors performance

**À faire**

1. Débloque les 2 exécutions `sale-retention` en `running` depuis le 22 septembre : `update operational_job_runs set status='failed', error_message='Abandonné (réconciliation manuelle)' where job_name='sale-retention' and status='running' and started_at < now() - interval '1 day'`.
2. Liste les 208 index jamais utilisés (`pg_stat_user_indexes.idx_scan = 0`). Pour chacun, vérifie qu'il ne sert ni à une contrainte unique ni à une clé primaire, puis supprime-le via le script d'index concurrents (`drop index concurrently`). Ne supprime rien moins de 7 jours après une remise à zéro des statistiques.
3. Ajoute un index sur les clés étrangères listées par l'advisor `unindexed_foreign_keys`, seulement sur les tables qui reçoivent des `delete` ou des jointures fréquentes.
4. Purge ou archive les historiques : `auction_sale_history` (591 Mo) et `auction_sale_readiness_history` (349 Mo). Garde 12 mois et ajoute la règle à `run_data_retention`.
5. Corrige `evaluate_operational_health` et la purge : 582 et 263 échecs par délai dépassé. Lance `explain analyze` sur leurs requêtes, ajoute les index manquants ou découpe le travail en lots.
6. Après ces étapes, mesure de nouveau le taux de cache (cible > 99 %). S'il reste sous 99 %, monte la taille de l'instance Supabase d'un cran et ajuste le pool de connexions Auth (advisor `auth_db_connections_absolute`).

**Terminé quand**

- [ ] 0 échec par délai sur `operational-health` et `sale-retention` pendant 7 jours.
- [ ] Taux de cache > 99 %.
- [ ] Advisor `unused_index` < 30.

### P3-05 · Borner le cache GitHub Actions du pipeline

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** OPS-04
- **Où :** `.github/workflows/data-pipeline.yml:176-186, 262-271`

**À faire**

1. Avant le `actions/cache/save`, supprime de `data/documents` et `data/pdf_texts` les fichiers de plus de 14 jours, et plafonne le total à 300 Mo (les plus anciens d'abord).
2. Utilise une clé de cache stable par jour (`…-${{ steps.date.outputs.day }}`) au lieu d'une clé par exécution.
3. Supprime les anciennes entrées de cache (Settings › Actions › Caches).

**Terminé quand**

- [ ] Le cache total du dépôt reste sous 5 Go.

### P3-06 · Rendre les échecs de collecte visibles

- **Qui :** Dev data · **Durée estimée :** 1 h · **Constats :** OPS-05
- **Où :** `services/data-pipeline/src/main.py:851` · `pipeline_health.py:108-110`

**À faire**

1. Fais sortir `main.py` avec le code 2 quand au moins une source activée rend 0 annonce ou lève une erreur, et émets `::warning::Source X en échec` pour GitHub.
2. Dans le workflow, traite le code 2 comme un avertissement (étape suivante exécutée, exécution marquée en échec partiel).

**Terminé quand**

- [ ] Une source en panne apparaît en jaune ou en rouge dans GitHub Actions.

### P3-07 · Inventorier toutes les tâches planifiées

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** OPS-06
- **Où :** `vercel.json` · migrations `pg_cron` · `.github/workflows/*` · `src/app/api/cron/*`

**À faire**

1. Crée `docs/operations/planification.md` avec, pour chaque tâche : nom, système (Vercel, pg_cron, GitHub), horaire, route ou script, supervision (oui ou non), seuil d'alerte.
2. Planifie `api/cron/cnb-lawyer-directory` (mensuel) ou supprime la route ; remets sous supervision l'annuaire CNB et `precompute-valuations`.
3. Ajoute un test qui échoue si une route `src/app/api/cron/*` n'est ni dans `vercel.json` ni dans une migration `pg_cron`.

**Terminé quand**

- [ ] Le document existe et le test passe.

### P3-08 · Empêcher un recompute manuel d'annuler le pipeline

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** OPS-08
- **Où :** `.github/workflows/recompute-existing-sales.yml:57` · `data-pipeline.yml:63`

**À faire**

1. Donne au recompute son propre groupe de concurrence `immojudis-recompute` et ajoute en base un verrou applicatif (`pg_try_advisory_lock`) pris par les deux workflows.
2. Remplace l'interpolation `${{ inputs.* }}` dans les scripts shell (l. 78 et 83) par des variables `env:`.

**Terminé quand**

- [ ] Lancer un recompute pendant un pipeline n'annule rien ; le second attend le verrou.

### P3-09 · Remettre le dépôt en ordre

- **Qui :** Toi · **Durée estimée :** 1 h puis 15 min/semaine · **Constats :** OPS-07
- **Où :** GitHub › Pull requests · branches

**À faire**

1. Traite les 11 PR Dependabot : merge celles dont la CI est verte, ferme celles qui sont remplacées par une version plus récente (par exemple docling 2.126 remplacé par 2.132).
2. Corrige l'échec CodeQL de la PR 183 ou ferme-la.
3. Active l'auto-merge Dependabot pour les mises à jour patch avec CI verte.
4. Ferme la PR brouillon 185 si elle n'est plus d'actualité, et supprime les branches mergées.

**Terminé quand**

- [ ] Aucune PR Dependabot de plus de 7 jours.

### P3-10 · Ne plus journaliser les cas métier normaux comme erreurs

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** LIVE-12
- **Où :** `src/lib/sale-market-estimates.ts` (erreurs « DVF fetch failed »)

**À faire**

1. Journalise « surface compatible manquante », « adresse non géocodable », « segment non pris en charge » et « aucune vente de stationnement » au niveau `info` avec un code, et non comme erreurs.
2. Garde le niveau `error` pour les vraies pannes (réseau, base, 5xx).

**Terminé quand**

- [ ] Les erreurs Vercel sur 7 jours ne contiennent plus ces 4 messages.

### P3-11 · Accélérer l'admin

- **Qui :** Dev · **Durée estimée :** 1–2 j · **Constats :** LIVE-07, CODE-07
- **Où :** `src/routes/admin.tsx` (2 138 lignes) · `/api/admin/dashboard`, `/api/admin/pipeline`, `/api/admin/information-agent/*`

**À faire**

1. Découpe `AdminDashboardContent` en une page par vue (`/admin/operations`, `/admin/quality`…) qui ne charge que ses propres données.
2. Pagine les listes de l'agent IA (50 lignes par page) ; la page fait aujourd'hui 30 000 px.
3. Ajoute `explain analyze` sur les requêtes des routes `/api/admin/*` qui ont dépassé 300 s le 4 octobre, et indexe en conséquence.
4. Fixe un délai de 30 s par route admin, avec un message clair en cas de dépassement.

**Terminé quand**

- [ ] Chaque page admin s'affiche en moins de 3 s.

### P3-12 · Brancher un suivi d'erreurs

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** CODE-13
- **Où :** `src/app/error.tsx` · `src/app/global-error.tsx` · `instrumentation.ts`

**À faire**

1. Installe un outil de suivi d'erreurs (Sentry ou équivalent compatible Next 16) côté serveur et navigateur, avec le `requestId` déjà généré.
2. Retire le `console.error` exécuté pendant le rendu dans `error.tsx` et envoie l'erreur à l'outil dans un `useEffect`.
3. Configure une alerte email sur toute nouvelle erreur en production.

**Terminé quand**

- [ ] Une erreur volontaire en preview apparaît dans l'outil en moins d'une minute.

## Phase 4 — Sécurité et conformité

Réduire la surface d'attaque et encadrer les données personnelles.

### P4-01 · Restreindre la lecture directe des ventes via l'API Supabase

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** SEC-04, LIVE-08
- **Où :** Migrations `20260630180814_…` (grant) · policy `auction_sales_authenticated_read` · vues `v_auction_sales_discovery(_search)`

**À faire**

1. Remplace `grant select on public.auction_sales to authenticated` par un grant limité aux colonnes affichées. Exclus au minimum `raw_payload`, `lawyer_contact` et les champs internes.
2. Fais passer les lectures premium par des RPC paginées (100 lignes maximum) qui vérifient `has_analysis_access`.
3. Les deux vues `v_auction_sales_discovery` et `_search` sont des projections volontairement expurgées. Garde-les en `security_definer` si c'est nécessaire, mais documente pourquoi dans la migration et ajoute-les à une liste d'exceptions du contrôle CI ; sinon passe-les en `security_invoker=true`.
4. Relance les advisors sécurité.

**Terminé quand**

- [ ] Avec un JWT `authenticated`, `select raw_payload from auction_sales` échoue.
- [ ] Advisor `security_definer_view` : 0, ou exceptions documentées.

### P4-02 · Limiter le débit des routes coûteuses ou publiques

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** SEC-03, LIVE-10
- **Où :** `api/market-estimate` · `api/sales/[id]/weather` · `api/lawyers/directory` · `api/lawyers/featured` · `api/geographic-boundary` · `api/climascore/commune` · `api/lawyer-referrals` (POST) · `api/privacy/requests` (POST) · `api/billing/offer` · export PDF · `api/dvf-comparables` · `api/environment-context`

**À faire**

1. Réutilise `enforceUserRateLimit` (table `api_rate_limit_buckets`) et ajoute une variante par IP pour les routes anonymes.
2. Limites de départ : 30/min par utilisateur pour les calculs, 10/heure pour les POST de formulaires, 60/min par IP pour les proxys publics.
3. Météo : limite à 5 nouvelles requêtes Meteostat par utilisateur et par jour, cache par commune et par mois.
4. Annuaire des avocats : pagination (50 par page), champs minimaux (nom, barreau, ville), `Cache-Control: public, s-maxage=3600`.
5. `billing/offer` : entoure l'appel Stripe d'un try/catch et mets le résultat en cache 5 minutes.
6. Renvoie 429 avec `Retry-After`.

**Terminé quand**

- [ ] Le 31e appel par minute à `market-estimate` renvoie 429.
- [ ] L'annuaire ne renvoie jamais plus de 50 fiches par appel.

### P4-03 · Ne plus renvoyer les messages d'erreur internes

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** SEC-05
- **Où :** ≈35 routes, dont `api/lawyers/directory/route.ts:17-20`, `api/property-reports/share/[token]/route.ts:21-22`, `api/notification-preferences/unsubscribe/route.ts:23-25`, `environment-context:27-34`, `market-estimate:59-66`, `src/lib/api-route-errors.ts:17`, `auth-middleware.ts:86`

**À faire**

1. Fais passer toutes les routes par `apiError` : message générique en français et `requestId` ; le détail ne va que dans les logs.
2. Ajoute une règle ESLint ou un test qui interdit `error.message` dans un `NextResponse.json` ou un `Response.json`.

**Terminé quand**

- [ ] `grep -rn "error.message" src/app/api` ne renvoie plus de réponse client.

### P4-04 · CSP stricte

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** SEC-01 · **Après :** P3-12
- **Où :** `src/lib/security-headers.ts:24-41` · `src/proxy.ts`

**À faire**

1. Génère un nonce par requête dans `proxy.ts`, passe-le aux scripts Next (`headers().get('x-nonce')`), et remplace `script-src 'unsafe-inline'` par `'nonce-…' 'strict-dynamic'`.
2. Restreins `connect-src` à `https://sgpakxtyvenlpeihuucm.supabase.co` et `wss://sgpakxtyvenlpeihuucm.supabase.co` (supprime `*.supabase.co`).
3. Restreins `frame-src` aux domaines réellement intégrés (Stripe, Google Maps Embed, ClimaScore) au lieu de `https:`.
4. Ajoute `report-to` vers l'outil de suivi d'erreurs (P3-12), et passe une semaine en `CSP_REPORT_ONLY=true` avant d'appliquer.

**Terminé quand**

- [ ] Aucune violation CSP rapportée pendant 7 jours en mode rapport, puis CSP appliquée.

### P4-05 · Protéger le client service role

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** SEC-08
- **Où :** `src/integrations/supabase/client.server.ts` · environ 40 modules de `src/lib` qui l'importent

**À faire**

1. Installe le paquet `server-only` et ajoute `import "server-only"` en tête de `client.server.ts` et des modules qui l'importent.
2. Corrige `api/sales/ai-review/route.ts`, qui importe `DETAIL_VIEW` depuis `queries.ts` (client navigateur) : déplace la constante dans un module neutre.

**Terminé quand**

- [ ] Le build échoue si un composant client importe un module serveur.

### P4-06 · Sécuriser les workflows GitHub

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** SEC-06
- **Où :** `data-pipeline.yml:76-84` · `recompute-existing-sales.yml:68-83` · `information-agent-evidence.yml:20-29, 56`

**À faire**

1. Déplace `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` et `REPLICATE_API_TOKEN` du niveau job vers les seules étapes Python métier.
2. Remplace `ref: ${{ vars.INFORMATION_AGENT_EVIDENCE_REF || github.sha }}` par `ref: main`.
3. Ajoute `permissions: contents: read` au niveau de chaque workflow.
4. Passe les `requirements*.txt` en lockfiles hachés (`pip-compile --generate-hashes` ou `uv pip compile`) et installe avec `--require-hashes`.

**Terminé quand**

- [ ] Aucun secret dans l'environnement des étapes `pip install` et `apt-get`.

### P4-07 · Corriger les droits par défaut des fonctions SQL

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** SEC-07, LIVE-08
- **Où :** Nouvelle migration · `scripts/check-security-invariants.mjs`

**À faire**

1. Migration : `alter default privileges revoke execute on functions from public;` (sans `in schema`), puis `alter default privileges in schema public grant execute on functions to service_role;`.
2. Révoque l'exécution de `st_estimatedextent` pour `anon` et `authenticated`.
3. Active RLS sur `spatial_ref_sys` ou révoque son accès pour `anon` et `authenticated`.
4. Déplace `pg_net` et `postgis` vers le schéma `extensions` si c'est faisable sans casse (teste sur une branche Supabase).
5. Ajoute au contrôle CI : toute fonction `SECURITY DEFINER` exécutable par `anon` ou `authenticated` doit appartenir à une liste blanche.

**Terminé quand**

- [ ] Advisors `anon_security_definer_function_executable` et `rls_disabled_in_public` : 0.

### P4-08 · Corriger les petits défauts d'autorisation

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** SEC-09
- **Où :** `src/lib/sale-workspace-collaboration.ts:153-168` · `src/lib/api-keys.ts:17, 150-158` · `src/lib/property-reports.ts:491-501` · `src/lib/sale-market-estimates.ts:174-182` · `src/lib/lawyer-placement-events.ts:29-47`

**À faire**

1. Invitations : exige `email_confirmed_at` non nul, et supprime l'exception qui permet à un admin d'accepter à la place du destinataire.
2. Clés API : force `isAdmin: false` dans le contexte, n'expose plus `supabaseAdmin`, impose une expiration de 365 jours maximum (refuse une date passée).
3. Jetons de partage de rapports : stocke un hash (comme `share_token_hash` des analyses) et coupe le partage quand l'abonnement prend fin.
4. `market-estimate` : applique la même règle de « readiness » que la fiche.
5. Événements de placement avocat : dédoublonne par utilisateur, placement et jour.

**Terminé quand**

- [ ] Un test par point.

### P4-09 · Versionner et vérifier la configuration Auth

- **Qui :** Dev + Toi · **Durée estimée :** 1 h · **Constats :** SEC-10
- **Où :** `supabase/config.toml` · Supabase › Authentication › Settings

**À faire**

1. Toi : vérifie dans le tableau de bord que la confirmation d'email est activée, que le mot de passe fait au moins 12 caractères, que les URL de redirection se limitent à `https://immojudis.com/**` et aux previews, et que la protection contre les mots de passe divulgués est active.
2. Dev : recopie ces réglages dans la section `[auth]` de `supabase/config.toml` et ajoute-y la MFA (P0-02).

**Terminé quand**

- [ ] `config.toml` reflète la production.

### P4-10 · Effacement des données (RGPD) automatisé

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** SEC-11
- **Où :** `updatePrivacyRequestForAdmin` · admin › Conformité

**À faire**

1. Ajoute le bouton « Exécuter l'effacement » sur une demande d'effacement : suppression du client Stripe, puis des données applicatives (alertes, favoris, rapports, espaces), puis `auth.admin.deleteUser`.
2. Affiche dans l'admin le délai restant avant l'échéance d'un mois, et une alerte à J-7.

**Terminé quand**

- [ ] Un compte de test effacé n'existe plus ni dans `auth.users`, ni dans les tables applicatives, ni dans Stripe.

### P4-11 · Ne plus publier les pièces reçues dans un bucket public

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** BIZ-09
- **Où :** Bucket `information-agent-approved` · `src/lib/admin-information-agent.ts:333-338`

**À faire**

1. Passe le bucket en privé et sers les fichiers par des URL signées de 10 minutes, générées à la demande.
2. Avant publication, aplatis le PDF et supprime ses métadonnées (auteur, XMP).
3. Ajoute une étape obligatoire « Caviardage vérifié » (case à cocher et nom de la personne) avant de rendre une pièce visible.

**Terminé quand**

- [ ] `select public from storage.buckets where id='information-agent-approved'` renvoie `false`.

### P4-12 · Agent IA : garde-fous avant tout envoi réel

- **Qui :** Dev + juriste · **Durée estimée :** 1–2 j · **Constats :** BIZ-08
- **Où :** `emails/information-request.tsx:117-140` · `src/lib/information-agent-email-template.ts:110-115` · migration `centralize_information_agent_cases.sql:436-454` · variables `INFORMATION_AGENT_*`

**À faire**

1. Garde `INFORMATION_AGENT_OUTBOUND_ENABLED=false` en production tant que les étapes suivantes ne sont pas faites.
2. Retire de l'email l'invitation « Créer un compte professionnel » (prospection).
3. Ajoute en pied d'email : identité du responsable de traitement, origine de l'adresse (art. 14 RGPD), lien vers `/privacy`, lien d'opposition en un clic.
4. Limite à un email par destinataire et par 30 jours, toutes ventes confondues.
5. Envoie depuis un sous-domaine dédié (par exemple `info.immojudis.com`), distinct des emails transactionnels.
6. Envoie en revue humaine toute réponse non reconnue avec certitude comme une opposition ou un accord.

**Terminé quand**

- [ ] Un juriste a validé le gabarit.
- [ ] Un destinataire ne reçoit jamais 2 emails en 30 jours.

### P4-13 · Mise en relation avocat : barreau compétent et conflit d'intérêts

- **Qui :** Dev + Toi · **Durée estimée :** 1 j · **Constats :** BIZ-10
- **Où :** `src/lib/featured-lawyers.ts:100-140` · `src/lib/lawyer-referrals.ts:324` · `LawyerReferralButton.tsx`

**À faire**

1. Ne propose que des avocats inscrits au barreau du tribunal judiciaire de la vente ; supprime les replis par code postal, ville et département.
2. Exclus l'avocat poursuivant de la vente (`lawyer_name` de la vente).
3. Avant l'envoi, affiche un récapitulatif des données transmises à l'avocat et demande une confirmation.
4. Toi : fais valider le modèle (visibilité payante forfaitaire, sans lien avec le nombre de mises en relation) par l'Ordre ou un avocat conseil.

**Terminé quand**

- [ ] Pour une vente au TJ de Bordeaux, seuls des avocats du barreau de Bordeaux sont proposés.

### P4-14 · Nettoyer les variables d'environnement Vercel

- **Qui :** Dev + Toi · **Durée estimée :** 1 h · **Constats :** LIVE-09, CODE-09
- **Où :** Vercel › Environment Variables · `next.config.ts:36-49` · `.env.example` · `README.md:56-69`

**À faire**

1. Vérifie si `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD` et `POSTGRES_DATABASE` servent au runtime (`grep -rn POSTGRES_ src`). Si non, supprime-les de Vercel et change le mot de passe Postgres dans Supabase.
2. Crée `NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, puis supprime `VITE_SUPABASE_*` après le déploiement suivant.
3. Remplace `NEXT_PUBLIC_APP_URL` par `SITE_URL` (nom canonique du code).
4. Crée `src/lib/env.ts`, validé par zod, comme seule source de lecture des variables, et supprime les 7 copies de `firstFilledEnv`.

**Terminé quand**

- [ ] Plus aucune référence à `VITE_` dans le dépôt ni dans Vercel.

### P4-15 · Vérifier la clé Google ignorée par gitleaks

- **Qui :** Toi · **Durée estimée :** 15 min · **Constats :** SEC-09
- **Où :** `.gitleaksignore` · Google Cloud Console

**À faire**

1. Identifie la clé navigateur Google listée dans `.gitleaksignore`. Dans Google Cloud › APIs › Identifiants, vérifie qu'elle est limitée à l'API Maps Embed et aux référents `https://immojudis.com/*`. Sinon, restreins-la ou révoque-la.
2. Ajoute `npm run check:secrets` au workflow CI.

**Terminé quand**

- [ ] Clé restreinte ou révoquée ; gitleaks tourne en CI.

## Phase 5 — Expérience, design et référencement

Navigation, lisibilité, pages visibles par Google.

### P5-01 · Un seul en-tête sur tout le site, avec menu mobile partout

- **Qui :** Dev design · **Durée estimée :** 2 j · **Constats :** UX-01
- **Où :** `src/components/Navbar.tsx` · `src/components/search/SearchHeader.tsx`

**À faire**

1. Fusionne les 4 variantes en un composant à 2 thèmes au maximum (sombre pour l'accueil, clair ailleurs).
2. Libellés uniques : « Ventes », « Tribunaux », « Avocats », « Ressources », « Offres », plus le bloc compte (« Connexion » ou « Mon compte »).
3. Sur `/sales`, garde la barre de recherche, mais avec le même logo, le même bloc compte et un menu mobile (burger) qui donne accès à toutes les pages.
4. Écris « Immojudis » partout (ou « ImmoJudis », mais une seule forme).

**Terminé quand**

- [ ] Depuis `/sales` en mobile, on atteint Connexion, Ressources et les pages légales.

### P5-02 · Rendre les boutons et textes dorés lisibles

- **Qui :** Dev design · **Durée estimée :** ½ j · **Constats :** UX-02
- **Où :** `src/styles.css:606-613` (`.liquid-button`) · classes `text-gold` (environ 113) · `hover:bg-gold`

**À faire**

1. Sur `.liquid-button` et `hover:bg-gold`, passe le texte en marine `#132238` (contraste d'environ 6,7:1).
2. Pour les petits textes et liens, remplace `text-gold` par un jeton `--gold-text` de contraste ≥ 4,5:1 sur fond clair (par exemple `#84602E`).
3. Le bouton désactivé « Paiement indisponible » ne doit pas descendre sous 3:1 ; utilise un style gris plutôt qu'une opacité de 0,6.

**Terminé quand**

- [ ] Tous les textes passent l'outil de contraste Lighthouse (aucune alerte « Contrast »).

### P5-03 · Refaire la page de connexion

- **Qui :** Dev design · **Durée estimée :** ½ j · **Constats :** UX-03
- **Où :** `src/routes/login.tsx:154, 171, 193, 247, 360`

**À faire**

1. Un seul `<h1>`. Retire la carte « Admin » et corrige le titre « Deux parcours ».
2. Onglets « Se connecter », « Créer un compte », « Professionnel ».
3. Boutons en casse normale, sans capitales espacées. Éloigne « Mot de passe oublié ? » du bouton.
4. Ajoute un bouton afficher ou masquer le mot de passe.
5. Affiche les erreurs dans le formulaire, sous le champ concerné, en français (« Email ou mot de passe incorrect »). Jamais le message Supabase brut.

**Terminé quand**

- [ ] Une connexion échouée affiche un message en français sous le formulaire.

### P5-04 · Corriger le bouton « Créer une alerte » et l'export CSV

- **Qui :** Dev · **Durée estimée :** 2 h · **Constats :** UX-04
- **Où :** `SearchHeader.tsx:403` · `SearchPage.tsx:527-533`

**À faire**

1. Retire le cadenas « Analyse » du bouton alerte : la première alerte est gratuite.
2. Pour un visiteur non connecté, redirige vers `/login?redirect=` suivi de l'URL courante, au lieu d'un toast.
3. Même logique pour le CSV : redirection vers la connexion, puis vers l'offre si le CSV est payant.

**Terminé quand**

- [ ] Un visiteur qui clique « Créer une alerte » arrive sur la connexion puis revient sur sa recherche.

### P5-05 · Traduire tous les messages d'erreur

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** UX-05
- **Où :** `login.tsx:154` · `SavedAlerts.tsx:36,47` · `BillingActions.tsx:129,146` · `SearchPage.tsx:594,616` · `billing.ts:136`

**À faire**

1. Crée `src/lib/user-messages.ts` qui traduit les codes d'erreur (Supabase, Stripe, réseau, 429) en phrases françaises qui disent quoi faire.
2. Remplace tous les `toast.error(err.message)` par `toast.error(userMessage(err))`.
3. Vérifie que « STRIPE_ANALYSIS_PRICE_ID manquant » ne peut pas remonter jusqu'au navigateur.

**Terminé quand**

- [ ] Aucun texte anglais ni technique n'est visible lors d'une erreur.

### P5-06 · Refaire les pages « Mes alertes » et « Mes favoris »

- **Qui :** Dev design · **Durée estimée :** 1–2 j · **Constats :** UX-06
- **Où :** `src/components/SavedAlerts.tsx` · `src/components/FavoriteSales.tsx`

**À faire**

1. Utilise les mêmes cartes que le catalogue (photo ou pictogramme, ville, prix, date).
2. Affiche les critères de chaque alerte et permets de la modifier.
3. Après une suppression (alerte, zone, favori), affiche un toast « Supprimé » avec « Annuler » pendant 5 s.
4. Remplace le jargon (« évaluations bornées aux ventes chargées », « Vérifier les correspondances ») par des phrases simples.
5. Supprime le décalage `pt-28` codé en dur et utilise la mise en page commune.

**Terminé quand**

- [ ] Une alerte se modifie et une suppression s'annule.

### P5-07 · Uniformiser le vocabulaire

- **Qui :** Toi + Dev · **Durée estimée :** ½ j · **Constats :** UX-07
- **Où :** Tout `src/` et `emails/`

**À faire**

1. Toi : valide un glossaire : « enchère plafond » (ou « mise plafond », mais un seul terme), « offre Analyse » (jamais « Premium »), « favoris », « Immojudis ».
2. Dev : remplace toutes les variantes (« prix plafond », « plafond d'enchère », « enchère maximale », « Premium », « Mes ventes suivies »).
3. Passe au vouvoiement dans `BidCeilingAssistant.tsx:1017, 1019, 1146`.
4. Ajoute un test qui échoue si « Premium » réapparaît dans les textes visibles.

**Terminé quand**

- [ ] `grep -rni "premium" src/routes src/components` ne renvoie que du code, aucun texte visible.

### P5-08 · Corriger les pages 404 et erreur

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** UX-08
- **Où :** `src/app/not-found.tsx` · `src/app/error.tsx` · `src/app/global-error.tsx`

**À faire**

1. Remets les accents (« La page demandée n'existe pas ou a été déplacée », « Cette page n'a pas chargé », « Réessayer », « Retour à l'accueil »).
2. Ajoute `metadata.title = 'Page introuvable'` sur la 404 et un titre sur la page d'erreur.
3. Ajoute un lien « Voir les ventes » et un champ de recherche sur la 404.
4. Aligne `global-error.tsx` sur le thème actuel.

**Terminé quand**

- [ ] La 404 a le titre « Page introuvable - Immojudis ».

### P5-09 · Afficher le catalogue côté serveur (premier écran et SEO)

- **Qui :** Dev · **Durée estimée :** 1–2 j · **Constats :** SEO-01, UX-09, CODE-05 · **Après :** P1-01
- **Où :** `src/app/sales/page.tsx:21-56` · `src/components/search/SearchPage.tsx`

**À faire**

1. Dans `app/sales/page.tsx` (composant serveur), charge la première page de résultats selon les `searchParams` et passe-la à React Query (`HydrationBoundary`).
2. Rends des liens `<a href="/sales/{id}">` dans le HTML serveur.
3. Mets la première page sans filtre en cache 5 minutes (`use cache` + `cacheLife`).
4. Utilise le même composant pour le fallback serveur et la version hydratée : même H1 « Ventes immobilières aux enchères », mêmes couleurs, même mise en page.

**Terminé quand**

- [ ] `curl https://immojudis.com/sales | grep -c 'href="/sales/'` ≥ 24.
- [ ] Pas de saut de mise en page au chargement (CLS < 0,05).

### P5-10 · Sitemap dynamique des ventes

- **Qui :** Dev · **Durée estimée :** 2 h · **Constats :** SEO-01
- **Où :** `src/app/sitemap.ts`

**À faire**

1. Ajoute toutes les ventes publiables à venir (`/sales/{id}`) avec `lastModified = updated_at`, ainsi que `/tribunaux`.
2. Ajoute `lastModified` aux pages statiques.
3. Rends le sitemap dynamique (revalidation toutes les heures). Au-delà de 5 000 URL, découpe-le avec `generateSitemaps`.

**Terminé quand**

- [ ] `/sitemap.xml` contient plus de 2 000 URL après correction.

### P5-11 · Rendre les pages Offres et Avocats visibles par les robots

- **Qui :** Dev · **Durée estimée :** 2 h · **Constats :** SEO-02
- **Où :** `src/lib/router-compat.tsx:192` · `src/components/BillingActions.tsx` · `src/routes/avocats.tsx:57`

**À faire**

1. Entoure de `<Suspense>` uniquement le composant qui lit l'URL (`BillingActions`, filtre des avocats), pas toute la page.
2. Ou lis les `searchParams` dans la page serveur et passe-les en props.

**Terminé quand**

- [ ] `curl https://immojudis.com/accompagnement | grep -c '<h1'` = 1, idem pour `/avocats`.

### P5-12 · Fiche inexistante : vraie erreur 404

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** SEO-03
- **Où :** `src/app/sales/[id]/page.tsx`

**À faire**

1. Appelle `notFound()` côté serveur quand ni la vente ni l'aperçu public n'existe.
2. Dans `generateMetadata`, renvoie `robots: { index: false }` dans ce cas.

**Terminé quand**

- [ ] `curl -o /dev/null -w '%{http_code}' https://immojudis.com/sales/00000000-0000-0000-0000-000000000000` renvoie 404.

### P5-13 · Fiche publique : contenu propre à chaque vente

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** SEO-04
- **Où :** `src/components/SalePublicPreview.tsx:120` · `src/app/sales/[id]/page.tsx`

**À faire**

1. Affiche sans compte ce que montre déjà la carte du catalogue : type, surface, ville et département, date et heure d'audience, tribunal, vignette.
2. H1 généré : « Appartement 50 m² à Romainville (93) – vente au tribunal le 20 octobre 2026 ».
3. Remplace « Cet aperçu protège les informations détaillées » par une liste de ce que l'offre ajoute (plafond, comparables, documents).

**Terminé quand**

- [ ] Deux fiches différentes n'ont jamais le même H1.

### P5-14 · Corriger titres, descriptions et données structurées

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** SEO-05
- **Où :** `src/lib/seo.ts` · `src/app/sales/[id]/page.tsx:30-46` · `src/app/page.tsx:13-21` · `src/app/layout.tsx` · `src/app/sales/page.tsx:6-7` · `publish/page.tsx:8` · `admin/quality`

**À faire**

1. Supprime « — Immojudis » de `GENERIC_SALE_SEO_TITLE`, `admin/settings` et `reports/shared` : le gabarit du layout l'ajoute déjà.
2. Titres de fiche ≤ 60 caractères, descriptions qui commencent par une majuscule. Supprime le doublon « au tribunal Tribunal judiciaire ».
3. Accents : `/sales` « Ventes immobilières aux enchères : tribunal, notaire, État », description accentuée ; `publish` ; `admin/quality`.
4. JSON-LD : URL absolues (`https://immojudis.com/...`), `availability` = `SoldOut` après l'audience, `image` et `startDate` sur les fiches ; ajoute un bloc `Organization` avec logo.
5. Open Graph : `og:locale=fr_FR`, `siteName`, `twitter:card=summary_large_image`, image OG sur `/ressources`, canonical sur `/tribunaux`.
6. Supprime `document.title` réécrit dans `routes/sales.$id.tsx` et tous les blocs `head()` hérités de TanStack (voir P6-01).

**Terminé quand**

- [ ] Aucun titre ne contient « Immojudis - Immojudis ».
- [ ] Le test des résultats enrichis de Google valide une fiche.

### P5-15 · Refaire l'annonce exemple

- **Qui :** Toi + Dev · **Durée estimée :** ½ j · **Constats :** SEO-06, LIVE-11
- **Où :** `/annonce-exemple`

**À faire**

1. Utilise les mêmes chiffres que l'accueil (ou mets à jour l'accueil).
2. Renseigne une source pour chaque champ, corrige « auprès du tribunal judiciaire », harmonise la surface.
3. Remplace la date fixe par une date relative (aujourd'hui + 21 jours) et une adresse fictive.
4. Indexe la page (retire `noindex`) avec un bandeau « Exemple fictif ».

**Terminé quand**

- [ ] Les chiffres de l'accueil et de l'exemple concordent.

### P5-16 · Unifier le système visuel

- **Qui :** Dev design · **Durée estimée :** 2–3 j · **Constats :** UX-10
- **Où :** `src/styles.css` (5 183 lignes, 129 hex) · environ 573 classes `text-/bg-/border-[#hex]`

**À faire**

1. Remplace `#132238` (183 occurrences) par le jeton `--brand-navy`, puis chaque couleur répétée par un jeton.
2. Retire le sarcelle `#0f766e` (hors palette) ou ajoute-le officiellement à la palette.
3. Crée les primitives `Card`, `Eyebrow`, `Button` et `Badge` dans `src/components/ui` et utilise-les partout.
4. Supprime la couche `styles.css:373-425` qui traduit les classes sombres de l'admin : écris directement les classes claires.
5. Ajoute une règle ESLint qui interdit les couleurs `[#...]` dans les classes.

**Terminé quand**

- [ ] Moins de 20 couleurs en dur hors des jetons.

### P5-17 · Refaire la page Offres

- **Qui :** Toi + Dev · **Durée estimée :** 1 j · **Constats :** UX-11, PROD-04 · **Après :** P7-02
- **Où :** `src/routes/accompagnement.tsx:39-52` · `src/lib/plans.ts`

**À faire**

1. Trois bénéfices concrets en tête : enchère plafond chiffrée, alertes, comparables de ventes réelles.
2. Tableau comparatif Découverte / Analyse, aligné sur les droits réels de `plans.ts` (voir P7-02).
3. Retire les noms de fournisseurs (Stripe, Meteostat, ClimaScore) et « Historique météo » de la liste principale.
4. Ajoute une FAQ de 5 questions : résiliation, essai, remboursement, couverture géographique, différence avec un avocat.
5. Renomme l'URL en `/offres`, avec une redirection 301 depuis `/accompagnement`.

**Terminé quand**

- [ ] La page présente le comparatif, la FAQ et le prix TTC.

### P5-18 · Accessibilité

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** UX-12
- **Où :** `src/app/layout.tsx` · `accompagnement.tsx` (DecisionEquation) · `SearchHeader.tsx:445` · `AuthGate.tsx:75`

**À faire**

1. Ajoute un lien « Aller au contenu » global dans le layout, et l'attribut `id="contenu"` sur `<main>`.
2. Équation du plafond : ajoute une phrase `sr-only` (« Enchère plafond = valeur estimée moins marge de sécurité moins frais »).
3. Aligne `aria-label` sur le texte visible (« Agrandir la carte »).
4. Corrige le texte de `AuthGate` : « Cette page est réservée aux comptes connectés ».

**Terminé quand**

- [ ] Lighthouse Accessibilité ≥ 95 sur `/`, `/sales` et une fiche.

### P5-19 · Ajustements mobile

- **Qui :** Dev · **Durée estimée :** 2 h · **Constats :** UX-13
- **Où :** `Navbar.tsx:510` · `providers.tsx:20` · filtres mobile de `/sales`

**À faire**

1. Masque le slogan sous 480 px.
2. Garde un seul bouton « Filtres » (la barre collante du bas).
3. Place les toasts en `bottom-center` sous 640 px.
4. Filtres mobile : de vrais libellés au-dessus des champs (pas seulement « Ex. Bordeaux »), « Mise à prix » une seule fois.

**Terminé quand**

- [ ] Aucun texte tronqué à 390 px de large.

### P5-20 · Réécrire « Comment ça marche » et le contact

- **Qui :** Toi + Dev · **Durée estimée :** ½ j · **Constats :** UX-14
- **Où :** `/comment-ca-marche` · `src/routes/contact.tsx:82,97` · `src/app/layout.tsx:9-16`

**À faire**

1. Réécris « Comment ça marche » en 4 étapes illustrées (trouver une vente, comprendre le bien, fixer son plafond, se faire accompagner) et retire les limites internes.
2. Ajoute un formulaire de contact (nom, email, sujet, message), avec limite de débit et envoi vers ton email via Resend.
3. Ne charge que les graisses de Cormorant Garamond réellement utilisées (vérifie avec une recherche sur `font-display` et les poids).

**Terminé quand**

- [ ] Le formulaire de contact envoie bien l'email.

### P5-21 · Corriger la carte du catalogue

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** LIVE-03, LIVE-13 · **Après :** P1-08
- **Où :** Composants carte de `src/components/search` (MapPanel)

**À faire**

1. Cadrage initial sur la France métropolitaine (ou sur la zone choisie en P1-07), jamais sur l'Afrique du Nord.
2. Corrige le libellé de groupe « 220K€ » : un groupe affiche un nombre de ventes.
3. Charge tous les points (identifiant et coordonnées seulement) au lieu d'un échantillon de 300, avec un regroupement côté serveur si besoin.
4. Charge Mapbox seulement quand la carte devient visible (import dynamique).

**Terminé quand**

- [ ] « X annonces situées sur Y » avec X ≥ 90 % de Y après P1-08.

### P5-22 · Passe de finition

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** LIVE-13
- **Où :** Tout le site

**À faire**

1. Ajoute `public/favicon.ico` et une icône Apple en PNG 180×180, plus un `manifest.webmanifest`.
2. Corrige ou retire la couche `data.geopf.fr/wmts` (404) sur les fiches.
3. Supprime les 4 préchargements CSS inutilisés signalés en console.
4. Désactive la télémétrie Mapbox (`mapboxgl.config.EVENTS_URL = null` ou option équivalente), ou soumets-la au consentement.
5. Donne une explication différente à chacun des badges « Recoupé », « Vérifié » et « En cours de vérification ».

**Terminé quand**

- [ ] Aucun avertissement en console sur les pages publiques.

## Phase 6 — Dette technique et outillage

Ce qui ralentit chaque évolution. À traiter au fil de l'eau.

### P6-01 · Terminer la migration vers Next.js (supprimer le shim TanStack)

- **Qui :** Dev · **Durée estimée :** 1–2 sem · **Constats :** CODE-02, CODE-05
- **Où :** `src/routes/*` (25 fichiers) · `src/lib/router-compat.tsx` (importé par 67 fichiers)

**À faire**

1. Migre page par page : déplace le contenu de `src/routes/x.tsx` dans `src/app/x/page.tsx` en composant serveur, et isole les parties interactives dans de petits composants `"use client"`.
2. Commence par les pages statiques : `legal`, `privacy`, `conditions-generales`, `a-propos`, `contact`, `index`, `comment-ca-marche`.
3. Remplace `Link`, `useNavigate` et `useSearch` du shim par `next/link`, `useRouter` et `useSearchParams`.
4. Supprime les blocs `head()` et `createFileRoute`, puis `router-compat.tsx` et les entrées `.vinxi`, `.tanstack` et `.nitro` du `.gitignore`.
5. Renomme les fichiers `*.functions.ts` selon les conventions du dépôt.

**Terminé quand**

- [ ] `src/routes/` et `router-compat.tsx` n'existent plus.
- [ ] Le JS de l'accueil passe sous 200 Ko.

### P6-02 · Session en cookies pour le rendu serveur

- **Qui :** Dev · **Durée estimée :** 2–3 j · **Constats :** CODE-03, SEC-01
- **Où :** `src/integrations/supabase/client.ts:27-35` · `src/proxy.ts` · `src/lib/queries.ts:552`

**À faire**

1. Remplace le stockage `localStorage` par `@supabase/ssr` (cookies `httpOnly` gérés par `proxy.ts`).
2. Lis la session côté serveur dans les pages, et précharge droits et données via `HydrationBoundary`.
3. Supprime le `return null` quand `typeof window === 'undefined'` dans `getSaleById`.
4. Prévois la migration des sessions existantes : une reconnexion forcée est acceptable avec 3 comptes.

**Terminé quand**

- [ ] Le refresh token n'est plus lisible en JavaScript.
- [ ] La fiche d'un abonné s'affiche complète dès le HTML serveur.

### P6-03 · Générer les types de la base et typer le client

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** CODE-04
- **Où :** `src/integrations/supabase/types.ts` · `client.ts:22` · `package.json` · `.github/workflows/ci.yml`

**À faire**

1. Ajoute le script `"db:types": "supabase gen types typescript --local > src/integrations/supabase/types.ts"`.
2. En CI, après `supabase db reset`, régénère les types et fais échouer le job si le fichier diffère.
3. Type le client navigateur : `createClient<Database>(...)`.
4. Supprime progressivement les 98 `as unknown as` hors tests (commence par `queries.ts` et `information-agent-inbound.ts`).

**Terminé quand**

- [ ] La CI échoue si les types sont périmés.
- [ ] Moins de 20 `as unknown as` hors tests.

### P6-04 · Supprimer le code mort

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** CODE-06
- **Où :** `SaleDetailView.tsx` · `TribunalStatisticsDashboard.tsx` · `SaleTribunalHistory.tsx` · `ListingQualityNotice.tsx` · `sale-detail/FactReliabilityBadge.tsx` · `lib/tribunal-sale-statistics.ts` · `lib/tribunal-statistics-client.ts` · `queries.ts:186-230` · `scripts/check-build-budgets.mjs:32` · `@radix-ui/react-popover` · `scripts/build-licitor-collector.py` · `scripts/check-secrets-policy-canary.mjs`

**À faire**

1. Supprime ces fichiers, leurs tests et les mocks qui les visent (`SalePublicPreview.test.tsx:32`, `SimplifiedSaleDetailView.integration.test.tsx:74`).
2. Supprime les branches « legacy » de `queries.ts` (`getSalesFromLegacyPreview` et suivantes).
3. Désinstalle `@radix-ui/react-popover`, déclare `@radix-ui/react-focus-scope`, et passe `tailwindcss`, `@tailwindcss/postcss` et `tw-animate-css` en `devDependencies`.
4. Ajoute `knip` en CI pour détecter le code et les dépendances inutilisés.

**Terminé quand**

- [ ] `npx knip` ne signale plus rien de ces fichiers.

### P6-05 · Découper les fichiers géants

- **Qui :** Dev · **Durée estimée :** 1–2 sem (au fil de l'eau) · **Constats :** CODE-07, DATA-10
- **Où :** `SimplifiedSaleDetailView.tsx` (2 252 l.) · `BidCeilingAssistant.tsx` (1 749) · `information-agent-inbound.ts` (3 066) · `market.functions.ts` (1 685) · `client-api.ts` (1 613) · `supabase_client.py` (5 856) · `main.run_pipeline` (588 l.)

**À faire**

1. Applique la limite de 1 500 lignes à tout `src/**` dans `check-build-budgets.mjs`, avec une liste d'exceptions temporaires datées.
2. Découpe par onglet ou section (fiche), par étape (assistant de plafond, ingestion d'email), par agrégat (repository Python).
3. Publie une API de connexion Postgres (`connect()`) au lieu des 22 imports de `_postgres_connect`.
4. Découpe à chaque fois que tu touches un de ces fichiers pour une autre tâche.

**Terminé quand**

- [ ] Aucun fichier de plus de 1 500 lignes hors liste d'exceptions.

### P6-06 · Mettre en place une stratégie de cache

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** CODE-08
- **Où :** `api/geographic-boundary/route.ts:7` · `src/integrations/supabase/client.ts:35` · `next.config.ts`

**À faire**

1. Retire `dynamic = "force-dynamic"` de `geographic-boundary` pour que le `revalidate: 86400` s'applique.
2. Active `cacheComponents` (lis la doc Next 16 dans `node_modules/next/dist/docs/`) et mets en cache l'aperçu public des fiches (`use cache`, `cacheLife('hours')`, `cacheTag('sale-'+id)`).
3. Invalide le tag de la fiche quand le pipeline la met à jour (route de revalidation appelée par le pipeline).
4. Supprime les `export const runtime = "nodejs"` redondants.

**Terminé quand**

- [ ] Une fiche publique servie deux fois de suite ne déclenche qu'une requête Supabase.

### P6-07 · Synchroniser la documentation de l'API

- **Qui :** Dev · **Durée estimée :** ½ j · **Constats :** CODE-10
- **Où :** `openapi.yaml` · `src/app/api/v1/*`

**À faire**

1. Ajoute les 5 routes manquantes : `sales/{id}/adjudication-statistics`, `land-report`, `urbanisme-cadastre`, `tribunals/listing-statistics`, `tribunals/adjudication-statistics`.
2. Ajoute un test qui compare les chemins d'`openapi.yaml` aux `route.ts` de `/api/v1` et échoue sur tout écart.

**Terminé quand**

- [ ] Le test passe.

### P6-08 · Factoriser les helpers et supprimer les requêtes en boucle

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** CODE-11
- **Où :** `asRecord` ×16, `stringValue` ×14, `numberValue` ×12, `clamp` ×7, `escapeHtml` ×5 · `sale-retention.ts:55-63` · `information-agent-contribution.ts:378,446` · `SearchPage.tsx:259-287` · `information-agent-inbound.ts:258-289,1800-1929`

**À faire**

1. Crée `src/lib/guards.ts` avec ces fonctions et remplace toutes les copies.
2. Valide le payload Resend avec un schéma zod au lieu de 14 casts.
3. Purge : regroupe par bucket (`storage.remove([...])`), puis un seul `delete().in('id', ids)`.
4. Catalogue : récupère le total dans la même requête (`count: 'estimated'`) au lieu de 3 requêtes sur les mêmes filtres.
5. Crée `src/lib/query-keys.ts` (fabrique de clés React Query) et remplace les 48 chaînes libres.

**Terminé quand**

- [ ] Une seule définition de chaque helper.

### P6-09 · Outillage, CI et tests

- **Qui :** Dev · **Durée estimée :** 1–2 j · **Constats :** CODE-12
- **Où :** `eslint.config.js` · `.github/workflows/ci.yml` · `playwright.config.ts` · `vitest.config.ts` · `.npmrc`

**À faire**

1. ESLint : ajoute `eslint-config-next`, lint les `.mjs`, remplace `globals.browser` par des globals par dossier, passe à `defineConfig`. Sors Prettier d'ESLint (`prettier --check .` séparé), puis corrige les 48 fichiers non formatés.
2. CI : lance tsc, lint, vitest et build en jobs parallèles. Mets en cache `.next/cache` et les navigateurs Playwright. Remplace les 3 `npm install -g npm@11.18.0` par corepack.
3. E2E : admin sur Chromium seul ; parcours publics (catalogue, fiche, connexion, alerte, offre) sur desktop et mobile ; réutilise l'artefact de build.
4. Ajoute `@vitest/coverage-v8` avec un seuil de départ de 60 % sur `src/lib`.
5. Python : une seule version (3.12) partout, `requires-python` à jour, `pip-audit` sur les 4 fichiers de dépendances, versions de `pydantic` alignées entre pipeline et collecteur.
6. Assouplis `engine-strict` ou documente l'installation de Node 24 dans le README.

**Terminé quand**

- [ ] La CI tourne en moins de 6 minutes.
- [ ] Au moins 5 tests E2E couvrent le parcours public.

### P6-10 · API Next 16 dépréciées et petites corrections

- **Qui :** Dev · **Durée estimée :** 2 h · **Constats :** CODE-13
- **Où :** `PhotoGallery.tsx:61,71,147` · `PropertyImage.tsx:19` · `ressources/page.tsx:74` · `ressources/[slug]/page.tsx:130` · `error.tsx` · `global-error.tsx` · `PropertyPage.tsx:57-60` · `proxy.ts:16` · imports `lucide-react/dist/esm/icons/*` (395)

**À faire**

1. Remplace `<Image priority>` par `preload` et `reset` par `retry`, selon la doc Next 16.
2. Échappe `<` dans le JSON-LD de `PropertyPage.tsx`, comme sur les autres pages.
3. Exclus `/media` et les fichiers statiques du matcher de `proxy.ts`.
4. Remplace les imports profonds lucide par `import { X } from "lucide-react"` et supprime `src/types/lucide-icons.d.ts`.

**Terminé quand**

- [ ] Aucun avertissement de dépréciation au build.

### P6-11 · Archiver la documentation obsolète et unifier le schéma

- **Qui :** Dev · **Durée estimée :** 2 h · **Constats :** CODE-14
- **Où :** `IMPLEMENTATION_STATUS.md` · `design-qa.md` · `sql/vercel_app_setup.sql` · `services/data-pipeline/sql/schema.sql` · `docs/design` (16 Mo) · `.vercelignore` · `README.md`

**À faire**

1. Déplace `IMPLEMENTATION_STATUS.md` et `design-qa.md` dans `docs/archive/`.
2. Supprime `sql/vercel_app_setup.sql` et `services/data-pipeline/sql/schema.sql`, ou marque-les « obsolète, voir supabase/migrations ».
3. Ajoute `docs/` au `.vercelignore`.
4. Mets à jour le README : variables `NEXT_PUBLIC_*`, Node 24, commandes de migration, sans `VITE_`.

**Terminé quand**

- [ ] Le README permet d'installer le projet sans erreur.

## Phase 7 — Produit et périmètre

Décisions qui réduisent le travail inutile.

### P7-01 · Fixer les conditions de lancement et geler le reste

- **Qui :** Toi · **Durée estimée :** 1 h · **Constats :** LIVE-04, PROD-03
- **Où :** Décision produit · `docs/roadmaps/`

**À faire**

1. Écris la liste des conditions de lancement : phase 0 faite, P1-01 à P1-17 faites, P2-01 à P2-07 faites, P3-01 à P3-04 faites.
2. Gèle le chantier Outcome Graph (environ 30 tables, flags `TRIBUNAL_STATISTICS_ENABLED`, `OUTCOME_EVALUATION_ENABLED`, `JUDILIBRE_ENABLED` et `JUSTICE_ACTIVITY_ENABLED` fermés) : arrête les workflows `outcome-*` et sors son code de `main` dans une branche d'archive, ou laisse-le mais sans nouveau développement.
3. Réduis la fréquence de collecte si 15 minutes n'apportent rien avec 3 utilisateurs (par exemple toutes les heures), pour soulager la base et les coûts.

**Terminé quand**

- [ ] Liste de lancement écrite.
- [ ] Aucune PR « Outcome Graph » avant le lancement.

### P7-02 · Aligner ce qui est vendu sur ce qui est livré

- **Qui :** Toi + Dev · **Durée estimée :** 1 j · **Constats :** PROD-01, PROD-04
- **Où :** `src/lib/plans.ts` · `src/lib/client-api.ts` · `/api/cron/sale-change-monitor` · `.env.example`

**À faire**

1. Liste les droits de `plans.ts` (environ 40). Pour chacun : visible dans l'interface (garder), à brancher avant le lancement (planifier), ou retiré (supprimer droit, route et cron).
2. Fonctionnalités sans interface à trancher : clés API, collaboration à 25 personnes, changements d'annonces (`sale-change-monitor`), suivi d'audience, historique, analytique de marché, comparables DVF, backtest, rafraîchissement à la demande, route `/api/bid-ceiling`.
3. Ajoute `ADJUDICATION_PRICE_STATISTICS_ENABLED` à `.env.example` et au contrôle d'environnement, avec sa signification.
4. Si `/api/cron/sale-change-monitor` ne sert à rien, retire-le de `vercel.json`.

**Terminé quand**

- [ ] Chaque droit de `plans.ts` correspond à un écran existant.

### P7-03 · Masquer les pilotes non validés

- **Qui :** Dev · **Durée estimée :** 1 h · **Constats :** PROD-06
- **Où :** `src/components/SimplifiedSaleDetailView.tsx:950-957` · filtres « Chez le notaire » et « Domaniales »

**À faire**

1. Masque les modules et filtres notarial et domanial derrière un flag fermé tant que leurs sources sont instables.
2. Rouvre-les quand le taux de fiches vérifiées dépasse 90 % sur 30 jours (visible dans `/admin/operations`).

**Terminé quand**

- [ ] Les filtres « Chez le notaire » et « Domaniales » n'apparaissent plus tant que le flag est fermé.

### P7-04 · Facturation pour les professionnels et essai unique

- **Qui :** Dev · **Durée estimée :** 1 j · **Constats :** BIZ-11 · **Après :** P1-15
- **Où :** `src/app/api/billing/checkout` · Stripe Checkout

**À faire**

1. Active dans Stripe Checkout la collecte de l'adresse de facturation et du numéro de TVA (`tax_id_collection`).
2. N'accorde l'essai de 7 jours qu'une fois par moyen de paiement (empreinte de carte Stripe) et non par compte.
3. Vérifie que Stripe envoie un rappel 3 jours avant la fin de l'essai.

**Terminé quand**

- [ ] Un second compte avec la même carte n'obtient pas d'essai.
