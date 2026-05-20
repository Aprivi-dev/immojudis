# Roadmap des 10 fonctionnalités

10 chantiers, ordonnés par valeur immédiate × effort. À livrer en 4 phases. Chaque phase est indépendante et déployable.

## Phase 1 — Quick wins UX (≈ 1 itération)

Tout est purement frontend, aucune nouvelle API, pas de migration.

1. **Compte à rebours** jusqu'à la date de vente
   - Composant `<SaleCountdown />` (jours / heures / minutes)
   - Affiché sur `SaleCard` (chip compact) et page détail (encart aside)
   - Styles : vert > 30j, ambre 7-30j, rouge < 7j, gris si passé

2. **Vue Nouveautés** — `/sales/new`
   - Nouvelle route, réutilise `getSales` avec filtre `created_at >= now-7d`
   - Tri par défaut `created_at DESC`
   - Lien dans la Navbar
   - Badge "Nouveau" sur les `SaleCard` (< 7 jours)

3. **Filtres avancés** (extension du formulaire existant)
   - Rendement min estimé (calcul côté client basé sur prix + surface — voir §6)
   - Prix au m² max
   - Distance autour d'une adresse → géocoding via Mapbox (token déjà présent), filtre haversine côté client
   - Persistés dans l'URL comme les autres filtres

## Phase 2 — Outils décisionnels (≈ 1 itération)

4. **Calculateur de rentabilité** (page détail, encart pliable)
   - Inputs éditables avec valeurs par défaut intelligentes :
     - Loyer mensuel estimé (€/m² par département, table statique simple)
     - Charges annuelles (~ 1 % du prix)
     - Taxe foncière (~ 0,5 % du prix)
     - Frais d'enchère = 10 % de la mise à prix (réglable)
     - Travaux (input libre)
   - Sorties : prix total acquisition, loyer annuel, rendement brut %, rendement net %
   - 100 % client, pas de persistance (on stocke en `localStorage` pour confort)

5. **Estimation prix de marché via DVF**
   - Server function `getDvfEstimate({ lat, lng, propertyType, surface })`
   - Appel à l'API publique data.gouv (https://api.gouv.fr/documentations/api-dvf)
   - Rayon ~ 500 m, fenêtre 24 mois, filtre par type
   - Retourne : médiane €/m², nombre de transactions, écart avec la mise à prix
   - Affichage sous forme de carte "DVF" dans l'analyse d'investissement avec verdict (sous-évalué / cohérent / au-dessus)

6. **Comparateur d'annonces** — `/compare`
   - Sélection via bouton "Comparer" sur `SaleCard` (max 3, stockés en `localStorage`)
   - Badge flottant en bas d'écran "X annonces sélectionnées → Comparer"
   - Page tableau côte à côte : prix, surface, €/m², rendement estimé, score, risques, date de vente
   - Surligne la meilleure valeur par ligne

## Phase 3 — SEO & longue traîne (≈ 1 itération)

7. **Page tribunal** — `/tribunaux/$slug`
   - Loader qui matche `slug` ↔ `tribunals.code` (slug = kebab-case du code)
   - Liste des ventes du tribunal + bloc info (nom canonique, ville)
   - `head()` SEO : titre = "Ventes aux enchères au Tribunal de [Ville]"
   - Index `/tribunaux` listant tous les tribunaux avec compteur

8. **Pages ville / département** — `/ventes/$slug`
   - Une seule route polymorphe, slug peut matcher un département (numéro ou nom) ou une ville
   - Liste des ventes correspondantes + carte si géoloc
   - `head()` dynamique pour SEO long-tail
   - Sitemap dynamique : ajout d'une entrée par département + top 50 villes les plus actives

9. **Export PDF d'une fiche**
   - Bouton sur la page détail
   - Génération **client** avec `pdf-lib` (compatible Worker runtime, pas de native deps)
   - Contenu : titre, adresse, mise à prix, date, surfaces, caractéristiques, risques, lien source, QR vers l'annonce
   - Fichier `enchere-<id>.pdf` téléchargeable

## Phase 4 — PWA (à clarifier avant)

10. **PWA + notifications push**
    - ⚠️ Recommandation Lovable explicite : les service workers cassent la preview iframe. Solution adaptée :
      - **a) manifest seul** (installable, icônes, `display: standalone`) — fonctionne dans la preview, suffit pour "ajouter à l'écran d'accueil"
      - **b) PWA complète + push** — nécessite un backend de push (VAPID + table `push_subscriptions`), seulement actif en build publié, désactivé en preview
    - Question à trancher : (a) installable seul, ou (b) push complet ?

## Détails techniques

- Toutes les nouvelles routes : `head()` SEO complet (title, description, og:*) dès la création
- Toutes les nouvelles routes : importées dans aucun fichier, le plugin TanStack régénère `routeTree.gen.ts`
- DVF : pas de clé API requise, mais cache côté serveur via en-tête `Cache-Control: public, max-age=86400`
- Comparateur, calculateur, filtres distance : stockage `localStorage` (pas besoin de DB)
- PDF : `pdf-lib` (pure JS, Worker-safe)
- Aucune nouvelle migration SQL nécessaire pour les phases 1-3
- Phase 4 (b) seulement : table `push_subscriptions` + edge route `/api/public/push-send`

## Proposition de démarrage

Je commence par la **Phase 1** (compte à rebours, vue Nouveautés, filtres avancés) qui est la plus rapide et la plus visible. On enchaîne sur la 2 ensuite.

**Avant de lancer**, confirme-moi :
- OK pour Phase 1 d'abord ?
- Pour la PWA (point 10) : option (a) installable simple, ou (b) push complet plus tard ?
