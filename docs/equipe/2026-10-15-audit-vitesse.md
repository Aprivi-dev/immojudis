# Audit de vitesse — 15/10/2026

Mission : mesurer la vitesse de chargement et d'affichage d'Immojudis et proposer des
correctifs. Agent : `performance-web`. Aucun fichier de code modifié, rien écrit en base.

## Conditions de mesure

- Production `https://immojudis.com`, 15/10/2026 entre 18 h 45 et 19 h 15 UTC.
- Lighthouse 12.8.2, Chrome headless 141. Mobile : Moto G Power émulé, 4G simulée
  (1,6 Mbit/s, 150 ms), processeur ralenti 4 fois. Bureau : preset « desktop ».
- Médianes de 2 à 4 essais par page ; 5 essais sur environ 45 écartés (erreur 502 du proxy
  du bac à sable, pas de la production).
- Le conteneur est aux États-Unis (CDN iad1) : les temps de réponse sont pessimistes pour
  un visiteur en France.
- Build local (`npm run build`, `npm run build:budgets`) : réussi du premier coup.

## Résumé

Le serveur va bien : les pages publiques, fiches comprises, sont préfabriquées et servies
par le CDN en 0,1 à 0,3 s. Le problème est le poids envoyé au navigateur :

- `/sales` sur mobile : score 51 à 59, affichage principal (LCP) simulé à 10 s, à cause des
  vignettes cartographiques (1,1 Mo au premier écran).
- `/sales` sur bureau : score 49, la carte bloque le navigateur pendant son initialisation.
- Fiches avec photo : LCP de 3,3 à 5,9 s (objectif : 2,5 s).
- Accueil et pages de contenu : élément principal chargé trop tard (LCP de 3,5 à 4,4 s).
- Toutes les pages : environ 1 Mo de JavaScript décompressé, dont `supabase-js` même pour
  un visiteur anonyme.
- Budgets de build : ils passent à 99 % du plafond et ne comptent pas le JavaScript commun.

## Mesures

### Mobile

| Page                                  | Score      | LCP                | TBT     | CLS   | Poids   |
| ------------------------------------- | ---------- | ------------------ | ------- | ----- | ------- |
| Accueil `/`                           | 86 [75-93] | 3,5 s [2,8-5,2]    | 184 ms  | 0,078 | 0,6 Mo  |
| `/sales`                              | 57 [51-59] | 10,5 s [10,1-10,6] | 568 ms  | ≤0,03 | 1,9 Mo  |
| Fiche sans photo                      | 92 [89-94] | 2,5 s [2,2-2,9]    | 258 ms  | 0     | 0,6 Mo  |
| Fiche, photo notaires.fr (optimisée)  | 83 [68-92] | 3,3 s [2,4-5,4]    | 366 ms  | 0     | 0,66 Mo |
| Fiche, photo vench.fr (non optimisée) | 69-82      | 3,8-5,9 s          | ~330 ms | 0     | 0,68 Mo |
| `/ventes-immobilieres-judiciaires`    | 78 [62-83] | 4,4 s [3,9-5,0]    | 214 ms  | 0     | 0,64 Mo |
| Article `/ressources/…`               | 90 [76-94] | 3,3 s [2,6-5,0]    | 170 ms  | 0     | 0,6 Mo  |
| `/offres`                             | 82 [80-91] | 2,3 s [1,6-2,3]    | 630 ms  | 0     | 0,57 Mo |

### Bureau

Accueil 100, fiche 100, guide 99, article 97, `/offres` 100. **`/sales` : 49** (TBT 4,2 s,
4,7 Mo en 102 requêtes ; TBT surestimé car le navigateur de test n'a pas de carte
graphique).

### Serveur

| Page                            | Cache CDN                     | Temps de réponse            |
| ------------------------------- | ----------------------------- | --------------------------- |
| `/`, guide, articles, `/offres` | HIT                           | 0,08-0,26 s                 |
| `/sales/<id>`                   | MISS à la 1re visite puis HIT | 0,56-0,84 s puis ~0,1 s     |
| `/sales`                        | dynamique                     | 0,19-0,26 s (1,2 s à froid) |
| `/avocats`, `/annonce-exemple`  | dynamique                     | 0,30-0,94 s                 |

Coût du proxy (`src/proxy.ts`) : 15 à 30 ms par page, négligeable.

## Propositions

Numérotées V1 à V14 pour ne pas les confondre avec les propositions adjuge.info.
Priorité : Critique / Important / Suggestion. Effort : S < 1 h, M < 1 jour, L > 1 jour.

| N°  | Proposition                                                                                                                                                                                         | Priorité   | Effort | Gain attendu                                       | Avis du chef                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| V1  | `/sales` : vignettes Mapbox des cartes en 400×300 au lieu de 512×384 @2x, et `content-visibility: auto` avec taille réservée sur les cartes                                                         | Critique   | S      | −450 Ko au premier écran, LCP mobile sous 5 s      | garder                                                                              |
| V1b | Faire passer les vignettes Mapbox par `next/image` (AVIF/WebP)                                                                                                                                      | Critique   | M      | jusqu'à −900 Ko                                    | discutable : conditions d'utilisation de Mapbox (mise en cache) et jeton dans l'URL |
| V2  | `/sales` bureau : initialiser la carte après le premier affichage de la liste, cadre réservé                                                                                                        | Important  | M      | navigateur nettement moins bloqué                  | garder                                                                              |
| V3  | Accueil : photo du dossier d'exemple en `loading="eager"` + `fetchPriority="high"`                                                                                                                  | Important  | S      | LCP ~2,0-2,3 s au lieu de 3,5 s                    | garder                                                                              |
| V4  | Fiches : photos vench.fr optimisées par notre serveur d'images (chemin étroit `/vignettes/*.jpg`)                                                                                                   | Important  | S      | −0,4 à −0,8 s de LCP                               | garder (liste d'hôtes toujours étroite)                                             |
| V5  | Avant d'appliquer la CSP stricte : tester `experimental.sri` pour garder les pages en cache                                                                                                         | Important  | M      | pas de régression le jour de l'activation          | discutable : option expérimentale, utile seulement avant la bascule CSP             |
| V6  | Pages de contenu (18 pages) : précharger l'image de fond `cloud-background.webp`, ou la supprimer (presque invisible sous le dégradé)                                                               | Important  | S      | −1,5 à −2,5 s de LCP sur le guide                  | garder (préchargement ; la suppression est un choix visuel)                         |
| V7  | JavaScript commun : charger `supabase-js` seulement s'il y a une session ou à la première action ; Sonner, menus Radix, Analytics à la demande ; budget de build qui compte le JS réellement chargé | Important  | M-L    | −20 % de JS transféré, TBT −50 à −100 ms           | garder                                                                              |
| V8  | Parcours connecté : paralléliser les appels de la fiche (profil, droits, déblocage, fiche) et de la recherche avancée (paquets de 100 lus en série)                                                 | Important  | M-L    | 100 à 300 ms par aller-retour supprimé             | garder (à mesurer avant/après)                                                      |
| V9  | Cache longue durée pour `/media/*` et `/brand/*`                                                                                                                                                    | Suggestion | S      | visites répétées : −0,5 à −1 Mo                    | garder                                                                              |
| V10 | Ne plus appeler `get_withdrawn_catalogue_sources` à chaque page vue ; `prefetch={false}` vers les pages dynamiques                                                                                  | Suggestion | S      | −2 requêtes Supabase et −4 appels serveur par page | garder                                                                              |
| V11 | Réchauffer la fiche après publication ou revalidation                                                                                                                                               | Suggestion | S-M    | −0,4 à −0,6 s à la 1re visite (souvent Googlebot)  | garder                                                                              |
| V12 | Polices et CSS : ne précharger l'italique que là où il sert, alléger `styles.css`, réduire le décalage de police de l'accueil                                                                       | Suggestion | M      | FCP −0,2 à −0,4 s                                  | discutable : gain modeste pour l'effort                                             |
| V13 | `next/font/local` au lieu de `next/font/google` (build sans dépendance réseau)                                                                                                                      | Suggestion | S      | robustesse des builds                              | garder                                                                              |
| V14 | `/avocats` statique (paramètres lus côté navigateur)                                                                                                                                                | Suggestion | M      | −0,1 à −0,3 s                                      | discutable : priorité faible                                                        |

### Vérifications du chef

- V1 : `src/lib/mapbox.ts:82` construit toujours une URL `…/${width}x${height}@2x`.
- V2 : `src/components/search/SearchPage.tsx:169` — `mapVisible = isDesktop || mobileMapOpen`.
- V3 : `src/components/CinematicHome.tsx:69-75` — `<Image fill>` sans `loading` ni
  `fetchPriority` (chargement différé par défaut).
- V4 : `src/lib/listing-photo-source.ts` n'autorise que avoventes.fr et
  media.immobilier.notaires.fr.
- V6 : `src/styles.css:423-429` — fond `cloud-background.webp` sous un dégradé à 74-96 %.
- V7, V10 : `src/app/providers.tsx` importe `supabase` et appelle `loadWithdrawnSources` à
  chaque montage.
- V9 : `next.config.ts` n'ajoute que les en-têtes de sécurité, aucune règle de cache.

### Dépendances

- V1 et V3 touchent `SearchResults.tsx` et `CinematicHome.tsx`, en cours de modification
  pour les propositions adjuge.info validées : à faire après leur fusion.

## Ce qui n'a pas pu être mesuré

- Données terrain (CrUX / PageSpeed Insights) : API saturée (429). Voir Vercel Speed
  Insights dans quelques jours.
- INP : remplacé par le TBT (pas d'interactions réelles).
- Parcours connecté : pas de compte de test ; V8 repose sur la lecture du code.
- Carte sur bureau : pas de carte graphique, blocage surestimé.
- Requêtes Supabase et index : pas d'accès SQL.

Rapports bruts (scratchpad de session, non versionnés) : Lighthouse, temps de réponse,
journal du build et des budgets.
