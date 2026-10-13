# Première session de l'équipe : état des lieux avant ouverture au public

Date : 13/10/2026. Chef d'orchestre : `/equipe`.

**Mission.** Faire auditer Immojudis par chaque spécialiste sur son domaine, avant l'ouverture au
public prévue par `docs/roadmaps/conditions-de-lancement-2026-10-10.md`, et en tirer une liste
d'actions priorisées à valider. Le chantier Outcome Graph (statistiques tribunaux, JudiLibre,
activité de la justice) est gelé et n'a pas été audité.

**Agents lancés (9 sur 10).** `code-reviewer`, `data-pipeline`, `qualite-donnees` (deux passes),
`ux-designer`, `seo-expert`, `juridique-rgpd`, `testeur-qa`, `product-explorer`,
`redacteur-contenu` (propositions seulement). Le `developpeur` n'intervient qu'après validation.

**Statut.** Aucun fichier de code ni de contenu modifié. Aucune écriture en base : `qualite-donnees`
n'a fait que des SELECT limités.

## Synthèse

Le socle est sain. Aucune faille bloquante n'a été trouvée côté sécurité : routes admin et cron
protégées, webhook Stripe signé et idempotent, RLS et invariants au vert, aucun secret commité.
Toutes les suites passent :

| Vérification                       | Résultat                                           |
| ---------------------------------- | -------------------------------------------------- |
| `npx tsc --noEmit`                 | OK                                                 |
| `npm run lint`                     | OK                                                 |
| `npm test`                         | 2 621 tests OK, 7 ignorés                          |
| `npm run test:security-invariants` | OK (23 invariants)                                 |
| Playwright desktop + mobile        | 65 OK, 5 ignorés volontairement, 0 échec           |
| Pipeline `ruff` + `pytest`         | OK, 3 289 tests (les 127 tests PostgreSQL : en CI) |

Les audits ont été faits sous Node 22 (le projet exige Node 24). Cela n'a eu aucun effet sur les
résultats, à part un crash de worker Vitest isolé.

Les vrais sujets avant ouverture sont ailleurs :

1. **Fiabilité des données affichées.**
   - Sur 1 968 ventes à venir visibles, 21 % n'ont pas de département et 40 % pas de
     coordonnées.
   - Une même vente apparaît souvent plusieurs fois (doublons entre sources).
   - Des valeurs sont fausses : département Licitor, surfaces « hors Carrez », lots clonés,
     point GPS fantôme.
2. **Promesses non tenues.** Les pages commerciales vendent les « statistiques des tribunaux »,
   qui sont gelées, et un email hebdomadaire gratuit que le code ne permet pas d'activer.
3. **Parcours de paiement.**
   - Réabonnement impossible après un paiement abandonné.
   - Accès accordé sur un paiement inabouti.
   - Pas de message de confirmation après le paiement.
4. **Calcul de l'enchère plafond (cœur de l'offre).** Trois bugs reproductibles, et aucun test
   d'interface.
5. **Conformité.** Mentions légales non imposées au build. Noms de particuliers visibles par les
   comptes connectés. CGV et politique de confidentialité en retard sur le code.

## Conflits entre agents et arbitrages

- **« Statistiques des tribunaux » sur `/offres`.**
  - L'UX proposait « (bientôt) » pour garder le texte indexable.
  - Le juridique y voit une pratique commerciale trompeuse.
  - **Tranché : retrait** tant que le drapeau est fermé. La ligne n'a pas de valeur SEO propre.
- **Noindex de toutes les fiches (juridique).** **Écarté.** La seconde passe de
  `qualite-donnees` montre que le visiteur non connecté ne voit aucun texte libre de la source.
  Les fiches publiques sont générées à partir de données structurées
  (`get_public_sale_details`, `src/lib/public-sale-description.ts`). Le risque est limité aux
  comptes connectés : point 7.
- **Doublons (point 12).** Le code refuse volontairement de fusionner sur « commune + date +
  prix », pour ne pas confondre deux lots distincts (`services/data-pipeline/src/dedupe.py:284-287`).
  - On garde la fusion par identifiant d'annonce commun Vench / Petites Affiches, qui est sûre.
  - La clé de repli plus large reste discutable : à concevoir avec contrôle sur un échantillon.
- **Pages départements et tribunaux.** Le SEO (point 2 du rapport SEO) et le produit (B3) les
  proposent tous les deux. Effort L et nouveau périmètre : **reporté après lancement**.
- **Article sur les frais et simulateur public.** Le `redacteur-contenu` et le `product-explorer`
  les proposent tous les deux. Ils dépendent du barème d'émoluments et des droits de mutation,
  que le plan correctif marque « à confirmer sur Légifrance par un juriste » : **discutable**
  tant que ce n'est pas fait.

## Tableau des propositions

Priorités : Critique / Haute / Moyenne / Basse. Effort : S < 1 h, M < 1 jour, L > 1 jour.

### A. Lancement : paiement, conformité, confiance

| N°  | Agent                    | Proposition                                                                                                                                                                                                 | Priorité | Effort | Avis du chef                                 |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------- |
| 1   | code-reviewer            | Réabonnement impossible après un paiement Stripe abandonné : le bouton devient « Gérer mon abonnement »                                                                                                     | Haute    | S      | garder                                       |
| 2   | code-reviewer            | Les statuts Stripe `incomplete` et `unpaid` donnent l'accès Analyse                                                                                                                                         | Haute    | S-M    | garder                                       |
| 3   | code-reviewer, juridique | Le build de production échoue si une mention légale ou `ADMIN_MFA_REQUIRED` manque ; remplacer le repli visible « À renseigner »                                                                            | Haute    | S      | garder                                       |
| 4   | code-reviewer            | Liens de désinscription et emails d'alerte cassés si seule `SUPABASE_SECRET_KEY` est définie                                                                                                                | Haute    | S      | garder                                       |
| 5   | juridique, UX, SEO       | Retirer les « Statistiques des tribunaux » (offres, comparatif, CGV, onglet et carte verrouillée de la fiche, explorateur payant de `/tribunaux`) ; `/tribunaux` : titre fidèle, noindex si vide            | Haute    | S      | garder                                       |
| 6   | product, juridique       | Email hebdomadaire gratuit promis mais impossible à activer : case de consentement non pré-cochée en Découverte                                                                                             | Haute    | M      | garder                                       |
| 7   | juridique, qualité       | Masquer les noms de particuliers dans les textes bruts (5 ventes) ; fermer `raw_payload` et `observations` aux comptes connectés                                                                            | Haute    | M      | garder                                       |
| 8   | juridique                | CGV : bouton « Résilier », garantie légale de conformité, prix, un seul chemin de résiliation                                                                                                               | Haute    | M      | garder (texte à faire valider par un avocat) |
| 9   | juridique                | Confidentialité : Mapbox, IA et service d'erreurs dans les destinataires ; traitement des annonces ; retrait sans compte ; formulaire de contact ; phrase d'inscription ; opposition à la mesure d'audience | Haute    | M      | garder                                       |
| 10  | juridique                | Annuaire des avocats : retirer « Spécialistes », indiquer la mise en avant payante                                                                                                                          | Moyenne  | S      | garder                                       |

### B. Données affichées

| N°  | Agent           | Proposition                                                                                                                                    | Priorité | Effort | Avis du chef                              |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------- |
| 11  | qualite-donnees | Département et coordonnées Petites Affiches : réparation depuis le géocodage déjà stocké, puis déduction du département dans tous les parseurs | Critique | S+M    | garder                                    |
| 12  | qualite-donnees | Doublons entre sources : fusion par identifiant commun Vench / Petites Affiches, puis clé de repli prudente                                    | Critique | M      | garder (identifiant) / discutable (repli) |
| 13  | qualite-donnees | Licitor : département détecté par sous-chaîne (« Orglandes » donne 40, « Vienne (Isère) » donne 86)                                            | Haute    | S      | garder                                    |
| 14  | qualite-donnees | Surfaces « hors Carrez » ou de parking retenues comme surface du bien (« Appartement 4 m² »)                                                   | Haute    | M      | garder                                    |
| 15  | qualite-donnees | Point GPS fantôme Info-Enchères sur 5 ventes                                                                                                   | Haute    | S      | garder                                    |
| 16  | qualite-donnees | Licitor multi-lots : le lot 2 copie l'adresse et le prix du lot 1                                                                              | Haute    | M      | garder (confirmer la cause d'abord)       |
| 17  | qualite-donnees | Dates invraisemblables (2029, 2044) : « date à confirmer »                                                                                     | Moyenne  | S      | garder                                    |
| 18  | qualite-donnees | Libellés de tribunal et de ville pollués : rattachement au référentiel                                                                         | Moyenne  | S      | garder                                    |

### C. Pipeline de collecte

| N°  | Agent         | Proposition                                                                                                                    | Priorité | Effort | Avis du chef                 |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ---------------------------- |
| 19  | data-pipeline | L'alerte critique `.missed` (seuil de 12 h) s'ouvrira à chaque cycle de 12 h : seuil à 18 h, plus un test d'invariant          | Haute    | S      | garder                       |
| 20  | data-pipeline | Une seule fiche en erreur relance la collecte toutes les 30 min à 6 h ; « 401 » ou « 403 » dans une URL suspend la source 24 h | Haute    | S-M    | garder                       |
| 21  | data-pipeline | Lectures de pièces en échec relancées toutes les 12 h sans limite                                                              | Moyenne  | S      | garder                       |
| 22  | data-pipeline | Cache des PDF sauvegardé seulement par le premier run du jour                                                                  | Moyenne  | M      | discutable (mesurer d'abord) |
| 23  | data-pipeline | Synchronisation des références Justice bloquante à froid ; documentation encore à 6 h ; `pytest` en production                 | Basse    | S      | garder                       |

### D. Calcul de l'enchère plafond

| N°  | Agent      | Proposition                                                                                                   | Priorité | Effort | Avis du chef |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------ |
| 24  | testeur-qa | « Maison avec terrain » dans le titre : pas de plafond ni d'estimation                                        | Haute    | S      | garder       |
| 25  | testeur-qa | Panneau des hypothèses : vider un champ réinjecte la valeur par défaut (« 50007 »)                            | Haute    | S      | garder       |
| 26  | testeur-qa | Projet « Louer » sans loyer de référence (77 départements) : aucun avertissement                              | Haute    | M      | garder       |
| 27  | testeur-qa | `formatPrice` affiche « 0 € », « NaN € » ou « ∞ € »                                                           | Moyenne  | S      | garder       |
| 28  | testeur-qa | Tris « Distance » et « Chambres » : balayage du catalogue côté navigateur                                     | Moyenne  | M      | garder       |
| 29  | testeur-qa | Pagination vide, message en double sur un lien expiré, ancien moteur `/api/bid-ceiling` inutilisé à supprimer | Basse    | S      | garder       |
| 30  | testeur-qa | Tests à ajouter : plafond, compte et récupération du mot de passe, favoris, alertes et comparaison            | Moyenne  | M      | garder       |

### E. Parcours et interface

| N°  | Agent                 | Proposition                                                                                                                             | Priorité | Effort | Avis du chef |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------ |
| 31  | ux-designer           | Cœur, cloche et export pour un visiteur : ouvrir « Créer un compte » avec le motif, pas « Se connecter »                                | Haute    | S      | garder       |
| 32  | product-explorer      | Fiche pour un visiteur : remplacer « Pas encore d'estimation » par une invitation à créer un compte                                     | Haute    | S      | garder       |
| 33  | ux-designer           | Après inscription : écran de confirmation et bouton « Renvoyer l'email » au lieu d'un toast                                             | Haute    | M      | garder       |
| 34  | ux-designer           | Plafond : hypothèses sous le chiffre (travaux, marge, source de la valeur), libellés clairs, mini-glossaire                             | Haute    | M      | garder       |
| 35  | ux, code, qa, product | `/offres` : pas d'« indisponible » au chargement, erreur distincte de « fermé », message après paiement, « Me prévenir de l'ouverture » | Haute    | M      | garder       |
| 36  | ux-designer           | Comparateur sur mobile ; ajouter prix au m² et occupation                                                                               | Moyenne  | M      | garder       |
| 37  | ux-designer           | Cibles tactiles de 44 px ; champs en 16 px contre le zoom d'iOS                                                                         | Moyenne  | S      | garder       |
| 38  | ux-designer           | Aucun résultat : boutons d'action ; « Effacer les filtres » sur mobile                                                                  | Moyenne  | S      | garder       |
| 39  | ux-designer           | Carte : « 500 affichés sur N », libellés compréhensibles                                                                                | Moyenne  | S      | garder       |
| 40  | ux-designer           | Favoris : un seul vocabulaire (pas « Suivre », qui promet une notification)                                                             | Basse    | S      | garder       |

### F. Référencement et performance

| N°  | Agent            | Proposition                                                                                       | Priorité | Effort | Avis du chef                                 |
| --- | ---------------- | ------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------- |
| 41  | seo-expert       | Origine canonique stricte en production, noindex hors production, `immojudis.fr` vers `.com`      | Critique | S      | garder                                       |
| 42  | seo-expert, code | Vraie erreur 404 pour une vente inconnue ou passée (aujourd'hui 200 à cause de `app/loading.tsx`) | Haute    | S      | garder                                       |
| 43  | seo-expert       | Sitemap : `/offres` au lieu de `/accompagnement` (redirigé) ; adresse de retour du portail Stripe | Moyenne  | S      | garder                                       |
| 44  | seo-expert       | `og:url` faux, image de partage absente sur les fiches, canonical en minuscules                   | Moyenne  | S      | garder                                       |
| 45  | code-reviewer    | `get_public_tribunal_activity` relit `raw_payload` (requête lente pour les visiteurs)             | Moyenne  | S      | garder                                       |
| 46  | seo-expert       | Métadonnées des pages éditoriales, sitemap en erreur 5xx si la base échoue, nettoyage de `robots` | Basse    | S      | garder                                       |
| 47  | seo-expert       | Accueil : deux images prioritaires, police du titre non préchargée                                | Moyenne  | S      | discutable (mesurer avec Lighthouse d'abord) |

### G. Contenus

| N°  | Agent                | Proposition                                                                                                                                                                                  | Priorité | Effort | Avis du chef                   |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------ |
| 48  | rédacteur, juridique | Harmoniser le vocabulaire (« enchère plafond », « Immojudis ») ; réécrire À propos ; FAQ et lexique du guide ; corriger le juridique (R. 322-41, surenchère, expulsion, date de mise à jour) | Haute    | M      | garder                         |
| 49  | redacteur-contenu    | Emails : alertes avec date, mise à prix et type de vente ; fin d'essai avec montant ; impayé                                                                                                 | Moyenne  | M      | garder                         |
| 50  | redacteur-contenu    | Article « Le jour de l'audience et le rôle de l'avocat »                                                                                                                                     | Haute    | M      | garder                         |
| 51  | redacteur-contenu    | Article « Après l'adjudication : surenchère, paiement, consignation »                                                                                                                        | Haute    | M      | garder                         |
| 52  | redacteur-contenu    | Article « Ventes notariales et domaniales »                                                                                                                                                  | Haute    | L      | garder                         |
| 53  | redacteur-contenu    | Article « Lire le cahier des conditions de vente et préparer la visite »                                                                                                                     | Moyenne  | M      | garder                         |
| 54  | redacteur-contenu    | Article « Financer un achat aux enchères »                                                                                                                                                   | Moyenne  | M      | garder                         |
| 55  | redacteur-contenu    | Article sur les frais, avec correction de l'exemple irréaliste à 9 500 €                                                                                                                     | Haute    | L      | discutable (barème à valider)  |
| 56  | product-explorer     | Simulateur public « coût total à la mise à prix »                                                                                                                                            | Haute    | M      | discutable (barème à valider)  |
| 57  | product-explorer     | Mesure de l'entonnoir (inscription, alerte, offres, paiement)                                                                                                                                | Moyenne  | M      | discutable (RGPD, plan Vercel) |

Pour les points 11, 13, 15, 16 et 17 : le `developpeur` écrit le correctif et le script de
réparation, avec ses tests. **L'application en production reste à votre main** : aucun agent
n'écrit dans la base de production.

### Après le lancement (pour mémoire, pas à valider maintenant)

- Agenda et rappels d'audience et de visite pour les favoris, avec export `.ics`.
- « Mes dossiers » : plafond et notes enregistrés sur le compte, pas seulement dans le
  navigateur.
- Pages par département et par tribunal, avec la liste des ventes à venir.
- Alertes de changement sur les favoris : report, retrait, baisse de mise à prix.

## Points écartés

- **Noindex de toutes les fiches** (juridique) : les visiteurs ne voient aucun texte libre de la
  source.
- **RLS sur `spatial_ref_sys`** (qualite-donnees) : table de référence PostGIS, publique par
  nature. Activer la RLS sans règle risque de casser les fonctions géographiques.
- **« (bientôt) » sur les statistiques des tribunaux** (UX) : remplacé par le retrait (point 5).
- **Notifications push** (product) : prématuré tant que les emails d'alerte ne fonctionnent pas.
- **Pages départements et tribunaux avant le lancement** (SEO, product) : effort L, reporté.
- **Faute « un enchère plafond »** (rédacteur) : introuvable dans le code actuel.

## Décisions et actions qui vous reviennent (hors code)

1. **Licitor** (Critique) : licence écrite ou retrait de la source. Un accord oral sur les
   statistiques de prix ne couvre ni la collecte des annonces, textes, photos et PDF, ni leur
   réaffichage dans une offre payante (CPI L. 341-1 et L. 342-1).
2. **Mentions légales** : fournir raison sociale, forme, capital, adresse, SIREN/RCS, TVA,
   directeur de la publication, email, téléphone et médiateur de la consommation, puis
   redéployer. Confirmer le régime de TVA (franchise ou non).
3. **Vérifications en production**, quelques minutes chacune :
   - `SITE_URL` est bien défini ;
   - quelle clé Supabase est définie (`SUPABASE_SECRET_KEY` ou `SUPABASE_SERVICE_ROLE_KEY`) ;
   - `curl -I` sur une vente inexistante renvoie bien 404.
4. **Relais « Paris »** pour Petites Affiches et Cessions de l'État : documenter son motif. S'il
   contourne un blocage, le retirer.
5. **Données personnelles** : décider d'une AIPD et documenter la mise en balance de l'intérêt
   légitime pour les personnes citées dans les annonces.
6. **Avocats** : faire valider le contrat de visibilité (RIN art. 10 et 11, C. consom. L. 111-7).
7. **Barème** : faire valider par un juriste les émoluments et les droits de mutation de
   `src/lib/profitability.ts`.
8. **Email aux professionnels** (agent d'information, envoi coupé aujourd'hui) : garder ou
   retirer l'invitation au compte pro avant d'activer l'envoi.
9. **Gel de l'Outcome Graph** : des migrations postérieures au gel du 10/10 existent
   (`20261014100000` à `20261019120000`, dont l'historique Licitor automatique et les
   scénarios d'enchères des tribunaux). L'historique Licitor tourne à chaque unité
   d'enrichissement. Confirmé voulu par le propriétaire (décision 14).

## Détail par point (preuves)

Tous les points marqués « garder » ont été ouverts dans le code par le chef d'orchestre, sauf
mention contraire.

1. `src/components/BillingActions.tsx:160` : `managesBilling = hasAnalysis || hasStripeCustomer`.
   `ensureStripeCustomer` pose `stripe_customer_id` dès l'ouverture du paiement
   (`src/lib/billing.ts:166`). Correctif : n'ouvrir le portail que si un abonnement Stripe réel
   existe, et ajouter un test.
2. `src/lib/billing.ts:513-516` : `incomplete`, `unpaid` et `past_due` sont tous convertis en
   `past_due`. La grâce est calculée sur `current_period_end + 7 jours`
   (`20261009181000_stripe_subscription_ordering_and_grace.sql`). À valider en mode test Stripe.
3. `package.json` (build) n'appelle que `verify-required-env.mjs`. `verify-production-env.mjs`
   n'exige les mentions qu'avec Stripe. Repli visible : `src/lib/legal-documents.ts:108`.
   `ADMIN_MFA_REQUIRED` vaut `false` par défaut (`admin-mfa.ts:22`).
4. `src/lib/email-unsubscribe-token.ts:20-27` ne lit que `EMAIL_UNSUBSCRIBE_SECRET` ou
   `SUPABASE_SERVICE_ROLE_KEY`. Le reste du code accepte aussi `SUPABASE_SECRET_KEY`.
5. `src/app/offres/offers-page.tsx:80`, `src/lib/offer-comparison.ts:99-102`,
   `src/routes/conditions-generales.tsx:61-63`,
   `src/components/sale-detail/ListingStatistics.tsx:358-366` (carte affichée même à un
   abonné), `src/components/SimplifiedSaleDetailView.tsx:485` (`showStatistics={isTribunalSale}`),
   `src/app/tribunaux/page.tsx`, `PremiumAdjudicationExplorer.tsx`.
6. `src/components/AlertNotificationPanel.tsx:46` (`emailAvailable = hasAnalysisAccess`).
   `consentSource: "alert_creation"` n'est utilisé nulle part. Promesses dans
   `SavedAlerts.tsx:199` et `offers-page.tsx:58` et `:70`. Le consentement reste explicite,
   horodaté et révocable : à inscrire au registre RGPD.
7. Les textes bruts `description`, `source_description`, `source_blocks` et `risks` sont
   affichés aux comptes connectés sans filtre (`scrub_public_text` ne vise que le texte de repli
   et les noms d'avocats). 5 ventes nomment un occupant, un locataire ou un créancier, dont une
   avec un enfant mineur ; 15 lignes `observations` ont une personne physique probable.
   Correctif : filtre serveur avant affichage, réparation des 5 ventes, puis étape 2 de
   `20261010003000_restrict_auction_sales_columns.sql`.
8. `src/routes/conditions-generales.tsx:64-67`, `:97-123` et `:178-200`. Références : C. consom.
   L. 215-1-1 et D. 215-1 (résiliation en ligne), L. 224-25-12 et suivants (conformité),
   L. 612-1 (médiateur). Non vérifié sur Légifrance.
9. `src/routes/privacy.tsx:17-72`, `:147-157` et `:169-178` ; `login-page.tsx:385-393` ;
   `ContactForm.tsx`. Base légale de l'« enquête dossier » incohérente avec le registre.
10. `src/app/avocats/lawyer-directory-page.tsx:226` « Spécialistes en droit immobilier » ;
    sélection filtrée sur `paid_placement_status` (`lawyer-referrals.ts:342`).
11. Ventes à venir visibles : 1 968. Département absent sur 410 (Petites Affiches : 76 %).
    Coordonnées absentes sur 790. `petites_affiches.py:405` : `fallback_department` vaut `None`
    sans filtre. Le géocodage « municipality » est stocké dans `raw_payload->'geocode'` mais pas
    recopié.
12. `dedupe.py:284-330` exige un numéro de rue. Environ 508 groupes « même commune, même jour,
    même prix », soit une estimation haute de 1 077 lignes en trop. Les 4 groupes ouverts sont
    de vrais doublons.
13. `services/data-pipeline/src/sources/licitor.py:635-649` : `if name in lowered` sur
    « landes » et « vienne ». Ventes `a523e55d`, `91d90d56`, `27008c6f`, `c1c62d33`.
14. Aucune occurrence de « hors Carrez » dans `services/data-pipeline/src`. Ventes `6d4e4095`
    (4,16 m² au lieu de 63,83 m²), `b1220a90`, `db26a41e`, `0e09aa58`.
15. Point (44.40655, 6.061187) sur `5ed06bd5`, `8ff95700` et 3 ventes en quarantaine. Le filtre
    existe déjà (`info_encheres.py:739-749`) mais les lignes anciennes n'ont pas été réparées.
16. 9 annonces Licitor multi-lots, 2 confirmées fausses à la source (`dc67982d`, `4d5cc8d0`).
    Non vérifié par le chef.
17. 11 ventes visibles au-delà de 8 mois (jusqu'en 2044). `774a1109` est en statut `past` avec
    une date future.
18. 16 libellés de tribunal mal nettoyés, 25 villes contenant du texte. Non vérifié par le chef.
19. `20260929234000_optimize_pipeline_health_observe.sql:174-178` : seuil `interval '12 hours'`,
    inchangé depuis la cadence de 12 h (`autonomous_runner.py:25`).
20. `autonomous_runner.py:209-210` : un problème suffit à incrémenter `failures`. La détection
    `'403' in str(e)` porte sur des messages qui contiennent l'URL. `next_attempt` (ligne 60)
    donne 30 min à 6 h.
21. `document_reading.py:380` : pas de compteur de tentatives.
22. `.github/workflows/data-pipeline.yml:204-206` et `:328-339`. Ampleur non mesurée.
23. `data-pipeline.yml:240-241` ; `docs/runbooks/pipeline-autonomy-progress.md:17` ;
    `docs/pipeline-reliability.md:4-5` ; `freshness.py:61-62` ; `requirements.txt:11`.
24. `src/lib/surface.ts:110-113` : la regex `terrain|parcelle` porte sur `property_type` et le
    titre (`typeText`, ligne 43), alors que `isLandOnlySurface` ne regarde que le type.
25. `src/components/ceiling/CeilingHypothesesPanel.tsx:45` (`value ?? défaut`) et `:241`
    (le champ vide renvoie `null`).
26. `src/lib/rent-reference.ts:12-37` (24 départements) ; `bid-ceiling-engine.ts:279`. Non
    vérifié par le chef.
27. `src/lib/format/numbers.ts:1-8` ne teste que `null`.
28. `src/lib/search/search-filters.ts:159-160`.
29. `SearchPagination.tsx:30-31` ; `PasswordRecovery.tsx:21-27` et `:108-130` ;
    `src/lib/bid-ceiling.ts` et `src/app/api/bid-ceiling/route.ts` (non appelés par l'interface).
30. Plan de tests dans le rapport QA, §4 : `e2e/bid-ceiling.spec.ts`,
    `e2e/account-recovery.spec.ts`, `e2e/favorites-alerts-compare.spec.ts`, plus des tests
    unitaires.
31. `src/lib/navigation.ts:37-41` (`loginPathWithRedirect` sans `mode`) ; `SearchPage.tsx:564`
    et `:645` ; `SearchResults.tsx:754-760` ; `FavoriteButton.tsx:50-55`.
32. `SaleDetailDecisionPanels.tsx:141-171` appelle `fetchValuePreview` sans vérifier la
    connexion. La route exige un compte (`value-preview/route.ts:25`). À confirmer en navigateur.
33. `src/app/login/login-page.tsx:171-175` et `:376-382`.
34. `SaleListing.tsx:390-397` ; `CeilingPlanner.tsx:97-104`, `:251` contre `:458`, `:401-410`.
35. `BillingActions.tsx:45` (`offerConfigured` initialisé à `false`) ; la valeur
    `checkout=success` n'est lue nulle part ; une erreur réseau s'affiche comme « non ouvert »
    (`offers-page.tsx:40`).
36. `SaleComparisonBar.tsx:46` ; `SaleComparisonDialog.tsx:36` et `:60` ;
    `SaleComparisonTable.tsx:63` et `:70`.
37. `SearchResults.tsx:718` et `:808` (32 px) ; `src/styles.css:612-616` (0,875 rem) ;
    `SaleCountdown.tsx:69` (10 px).
38. `SearchFilters.tsx:43-54` ; `SearchHeader.tsx:130-137`.
39. `SearchPage.tsx:357` (`.slice(0, 500)`) et `:888` ; `MapPanel.tsx:1069-1109` et `:1152`.
40. `FavoriteButton.tsx:101-109` ; `FavoriteSales.tsx:181-186`.
41. `src/lib/site-url.ts:1-7` : repli sur `VERCEL_URL`. `robots.ts:17-27` autorise tout, dans
    tous les environnements. `scripts/verify-production-env.mjs` accepte `VERCEL_URL`.
    `immojudis.fr` dans `admin-publication-requests.ts:308` et `SavedSaleComparisons.tsx:354`.
42. Le commentaire de `src/app/sales/[id]/page.tsx:25-28` reconnaît un statut 200. Le QA
    confirme le même comportement sur `/comparaisons/zzz`.
43. `src/app/sitemap.ts:19` ; `next.config.ts:71` ; `src/lib/billing.ts:406`.
44. `src/app/layout.tsx:49-60` ; `src/app/sales/[id]/page.tsx:54-65`.
45. `supabase/migrations/20261017130000_public_tribunal_activity_rpc.sql:51`.
46. Pages légales, `ventes-immobilieres-judiciaires/page.tsx`, `sitemap.ts:39-45`,
    `robots.ts:23` et `:26`.
47. `CinematicHome.tsx:18-26` et `:68-76` ; `HomeDiscovery.tsx:131-137` ; `layout.tsx:12-21`.
48. Inventaire et citations dans le rapport du rédacteur (§2) ; corrections juridiques dans le
    rapport juridique (point 10).
49. `src/lib/email-alerts.ts:256` et `:326` (« ImmoJudis ») ; `src/lib/billing-notices.ts:126`
    (« dans 3 jours » en dur).
50. à 54. Plans détaillés dans le rapport du rédacteur. Tous contiennent des informations
    juridiques et seront relus par `juridique-rgpd` avant publication.
51. `src/content/resources/prix-plafond-encheres-immobilieres.json:64` et `:71` (9 500 € de
    frais pour un plafond d'environ 158 000 €).
52. `computeAcquisitionCosts` (`src/lib/profitability.ts:144`) existe mais n'est exposé qu'en
    offre Analyse.
53. Seuls `<Analytics />` et `<SpeedInsights />` sont présents dans `layout.tsx`.

## Lots conseillés

- **Lot 1, avant ouverture, petits efforts** : 1, 2, 3, 4, 5, 13, 15, 19, 20, 24, 25, 27, 31,
  32, 41, 42, 43.
- **Lot 2, avant ouverture, efforts moyens** : 6, 7, 8, 9, 11, 12 (identifiant commun), 14,
  26, 33, 34, 35, 48.
- **Lot 3, juste après** : le reste des « garder ».

## Exécution

**Validation de l'utilisateur** : toutes les propositions des agents `code-reviewer`,
`qualite-donnees`, `data-pipeline`, `testeur-qa`, `ux-designer`, `product-explorer`, `seo-expert`
et `redacteur-contenu`. Les points propres à `juridique-rgpd` (8, 9, 10) n'ont pas été validés et
ne sont pas faits. Les points 3, 5, 6 et 7, partagés avec un agent validé, ont été faits.

Branche : `equipe/premiere-session-2026-10-13` (283 fichiers, environ 18 300 lignes ajoutées et
2 000 retirées).

### Chantiers

| Chantier                      | Points                                               | Résultat                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Paiement et offres         | 1, 2, 3, 4, 5 (offres), 35                           | Fait                                                                                                                                             |
| B. Recherche, compte, alertes | 6, 28, 29, 31, 33, 36 à 40, 30 (e2e compte, favoris) | Fait                                                                                                                                             |
| C. Fiche et enchère plafond   | 24 à 27, 29, 32, 34, 5 (fiche), 30 (e2e plafond)     | Fait ; 2 scénarios e2e restent en Vitest (fiche lue côté serveur)                                                                                |
| D. Référencement              | 41 à 47, 5 (`/tribunaux`)                            | Fait                                                                                                                                             |
| E. Robustesse du pipeline     | 19 à 23                                              | Fait ; cache sauvegardé seulement s'il change                                                                                                    |
| F. Exactitude des données     | 11 à 18                                              | Fait, sauf 16 : cause confirmée, quarantaine ciblée livrée, le choix « une ligne par lot ou un agrégat » reste à trancher                        |
| G. Données personnelles       | 7                                                    | Filtre à l'écriture, rapports filtrés, script de réparation ; révocation des colonnes internes non faite (elle casserait la fiche, étape à part) |
| H. Contenus                   | 48 à 55                                              | Fait ; relu par `juridique-rgpd` puis corrigé (12 corrections)                                                                                   |
| I. Simulateur de frais        | 56                                                   | Fait (`/simulateur-frais-encheres`)                                                                                                              |
| J. Finitions                  | 57, restes d'intégration                             | Fait (mise à prix à 0, tri chambres côté serveur, occupation des comparaisons, liens, événements anonymes)                                       |

### Relectures

- `juridique-rgpd` sur les contenus : aucun point critique ; la divergence sur la surenchère
  notariale est tranchée (légale en saisie et licitation, contractuelle en vente notariale
  volontaire) ; 12 corrections appliquées.
- `code-reviewer` sur l'ensemble : aucun point critique ; défauts corrigés ensuite :
  - le filtre des noms transformait un occupant sans titre en « locataire » : il écrit désormais
    « un occupant » ;
  - expressions régulières à coût quadratique : réécrites, avec un test de performance ;
  - le balayage des doublons pouvait supprimer une annonce sur une simple collision d'identifiant :
    il exige maintenant le même lieu et un fait concordant ; deux annonces fusionnées en mémoire
    ne passent plus en quarantaine ;
  - les réparations de données étaient rangées avec les migrations : elles sont dans
    `supabase/repairs/`, en mode comptage par défaut ;
  - le département n'est plus déduit du tribunal ;
  - « Me prévenir de l'ouverture » ne promet plus d'envoi, le consentement est posé côté serveur,
    la purge est ajoutée à `run_data_retention` ;
  - `/tribunaux` ne passe plus en noindex sur une panne de base ;
  - le garde-fou d'origine canonique refuse `localhost`, `http://` et les valeurs fictives ;
  - la migration du seuil de 18 h est rejouable ;
  - l'abonnement en retard de paiement affiche la fin réelle du délai de grâce.
- Défaut **antérieur à la session**, non corrigé, en attente de décision : un événement Stripe
  tardif de l'ancien abonnement peut écraser un nouvel abonnement
  (`20261009181000_stripe_subscription_ordering_and_grace.sql:131-152`, `billing.ts`).

### Vérifications finales (branche fusionnée)

| Vérification                       | Résultat                                                             |
| ---------------------------------- | -------------------------------------------------------------------- |
| `npx tsc --noEmit`                 | OK                                                                   |
| `npm run lint`                     | OK                                                                   |
| `npm test` (Vitest)                | 3 170 OK, 7 ignorés                                                  |
| `npm run test:security-invariants` | OK (25 contrôles, dont 2 nouveaux)                                   |
| `npm run check:migrations`         | OK                                                                   |
| Pipeline `ruff` + `pytest`         | OK, 3 729 tests (tests PostgreSQL : en CI)                           |
| Playwright                         | specs nouveaux passés par leurs auteurs (desktop et mobile Chromium) |

Non exécuté ici : le test pgTAP `supabase/tests/457_offer_opening_notifications.sql` et le test
PostgreSQL de la migration 18 h (à faire tourner en CI avec base).

### À faire par le propriétaire, dans l'ordre

1. **Avant de déployer** : décider du balayage des doublons. Il fusionnera puis supprimera les
   doublons confirmés à la collecte suivante ; `DEDUPE_RECONCILE_ENABLED=false` permet de choisir
   le moment.
2. **Variables Vercel** : `SITE_URL` (obligatoire, sinon le build de production échoue),
   `NEXT_PUBLIC_LEGAL_*`, `ADMIN_MFA_REQUIRED=true`. À défaut, `ALLOW_INCOMPLETE_LAUNCH_CONFIG=true`
   laisse passer les mentions légales et la double authentification, jamais l'origine canonique.
3. **Migrations** (`Apply Supabase Migrations`) : `20261020100000` (demandes d'ouverture),
   `20261020110045` (`/tribunaux`), `20261020120019` (seuil 18 h), `20261020120021` (tentatives de
   lecture, **avant** le déploiement du code Python), puis régénérer les types (`db:types`).
4. **Réparations** (`supabase/repairs/README.md`) : 130001, 130002, 130003 en comptage, relecture,
   puis `-v apply=1` ; ensuite `recompute-existing-sales` en `dry_run=true` puis `false`.
5. **Données personnelles** : `python -m src.redact_personal_data` (comptage), puis `--apply`,
   puis `--check` ; ensuite `--all-statuses`. Planifier à part la révocation de `raw_payload` et
   `observations` (vue en definer, et tables `properties` et `judicial_sales`).
6. **Vercel Analytics** : vérifier que l'offre Vercel accepte les événements personnalisés.
7. **Juridique** : barème des émoluments et des droits de mutation (dont les départements à 5,81 %),
   CGV (délai de grâce de 7 jours, version à changer en une fois avec le point 8), contrat de
   visibilité des avocats, licence Licitor.

### Points d'attention

- Les scénarios d'enchères de la fiche (PR #226) sont masqués avec l'onglet « Statistiques » tant
  que le drapeau des statistiques est fermé (données Licitor, licence non réglée).
- Le texte des CGV a changé (retrait des statistiques) sans changement de version
  (`2026-10-03.1`) : aucune vente n'a encore eu lieu.
- Une date de vente invraisemblable est désormais vidée (« date à confirmer ») : 11 ventes
  sortent de la liste des ventes à venir après recalcul.
- Le tri « Chambres » en aperçu public retombe sur la pertinence (la fonction publique ne le
  connaît pas).
- Limites connues du filtre des noms : enseigne en deux mots après « loué à » remplacée à tort ;
  second nom après « aux époux » non retiré.

## Décisions du propriétaire (13/10/2026, après le bilan)

Le propriétaire suit toutes les recommandations du chef d'orchestre.

| N°  | Décision                                                                       | Réponse | Suite                                         |
| --- | ------------------------------------------------------------------------------ | ------- | --------------------------------------------- |
| 1   | Corriger l'écrasement d'un nouvel abonnement par un événement Stripe tardif    | Oui     | Chantier K                                    |
| 2   | Publier la branche et ouvrir une pull request en brouillon                     | Oui     | PR #238                                       |
| 3   | Corriger les CGV (résiliation, garantie légale, délai de grâce, version)       | Oui     | Chantier L                                    |
| 4   | Mettre à jour la politique de confidentialité                                  | Oui     | Chantier L                                    |
| 5   | Annuaire : retirer « Spécialistes », signaler les profils payants              | Oui     | Chantier L                                    |
| 6   | Fermer plus tard l'accès aux colonnes internes (`raw_payload`, `observations`) | Oui     | Chantier séparé, à planifier                  |
| 7   | `DEDUPE_RECONCILE_ENABLED=false` au premier déploiement                        | Oui     | Livré : coupé par défaut dans le workflow     |
| 8   | Dates invraisemblables en « date à confirmer »                                 | Oui     | Livré                                         |
| 9   | Scénarios d'enchères masqués tant que la licence Licitor n'est pas réglée      | Oui     | Livré                                         |
| 10  | Retirer Licitor du catalogue sans licence écrite                               | Oui     | Chantier M                                    |
| 11  | Une fiche par lot pour les annonces Licitor multi-lots                         | Oui     | Reporté au retour de Licitor (source retirée) |
| 12  | Départements à 5,81 % dans le simulateur après confirmation officielle         | Oui     | En attente de la source officielle            |
| 13  | Retirer l'invitation au compte pro des emails aux professionnels               | Oui     | Chantier L                                    |
| 14  | Ajouts Outcome Graph postérieurs au gel du 10/10 voulus ?                      | Oui     | Confirmé, rien à désactiver                   |
| 15  | Index pour la recherche par numéro d'annonce                                   | Non     | —                                             |

## Exécution après les décisions (13/10/2026, suite)

| Chantier                                 | Décision    | Résultat                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K. Abonnement Stripe écrasé              | 1           | Un événement tardif d'un ancien abonnement est ignoré (`superseded_subscription`) ; migration `20261021100000`                                                                                                                                                                                                                         |
| L. Textes juridiques                     | 3, 4, 5, 13 | CGV (durée indéterminée, garantie légale, délai de grâce), confidentialité, inscription, contact, annuaire, emails aux professionnels purement informatifs                                                                                                                                                                             |
| N. Bouton « Résilier mon abonnement »    | 3           | Ouvre directement le formulaire de résiliation du portail Stripe ; CGV, FAQ et emails alignés                                                                                                                                                                                                                                          |
| M. Retrait de Licitor                    | 10          | Interrupteur unique en base (`set_catalogue_source_withdrawal`), retrait par défaut, collecte arrêtée, ventes Licitor seules masquées, contenus Licitor retirés des ventes fusionnées ; migration `20261021110000`                                                                                                                     |
| O. Corrections de la relecture juridique | 3, 4, 5     | Avocat nommé avant consentement avec mention exacte de la mise en avant payante ; API bridée aux données affichées ; vocabulaire unique ; classement expliqué ; email de confirmation de résiliation ; interrupteur d'opposition à la mesure d'audience ; garde-fou prix affiché = prix facturé ; IGN et API Adresse dans la politique |

Corrections apportées pendant la CI de la PR #238 :

- page d'accueil : le texte de consentement chargeait `zod` (582 Ko > 555 Ko), sorti dans un module léger (526 Ko) ; plafond total relevé une fois à 5,40 Mo ;
- tests pgTAP 453 (colonne de quarantaine) et 457 (nombre d'assertions) ;
- formulaire d'administration des mises en relation : champs rétrécissables sur mobile (bouton masqué par le débordement) ;
- conflit avec #237 (README) résolu.

Vérifications sur la branche finale : `tsc`, lint, 3 301 tests Vitest, invariants de sécurité, build et budgets,
`check:migrations` et pipeline (3 744 tests) au vert.

### Nouvelles actions du propriétaire

1. **Stripe** : portail client, résiliation activée et « en fin de période » (sinon les CGV §2 et §5 sont
   inexactes) ; relances d'impayé et sort de l'abonnement après suspension à fixer puis à écrire au §4.
2. **Migrations supplémentaires** : `20261021100000` (Stripe) et `20261021110000` (retrait de Licitor : l'appliquer
   retire Licitor ; à rejouer d'abord sur une copie, verrou court sur `auction_sales`).
3. **Avant de rouvrir Licitor** : licence écrite, puis `select public.set_catalogue_source_withdrawal('licitor', false);`.
   Garder fermés les drapeaux de statistiques des tribunaux tant que Licitor est retiré.
4. **À faire valider par un avocat** : qualification du contrat, modèle de mise en avant payante des avocats
   (RIN 19.4.2, 11.3, 10 ; C. conso. L. 111-7, L. 121-4), exemption de consentement de la mesure d'audience,
   durées de conservation (contact, mises en relation, adresses opposées), textes issus de Licitor dans les ventes
   fusionnées.
5. **Point 14** (ajouts Outcome Graph après le gel) : confirmé voulu par le propriétaire le 13/10, rien à désactiver.
6. Le repli de géocodage appelle encore `api-adresse.data.gouv.fr`, peut-être arrêté au profit de
   `data.geopf.fr/geocodage` : à vérifier.
