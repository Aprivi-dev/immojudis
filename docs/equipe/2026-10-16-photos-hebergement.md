# Héberger les photos des annonces : analyse

Date : 16/10/2026. Mission : vérifier si les photos chargées depuis les sites sources expliquent
la lenteur de `/sales`, puis étudier leur hébergement chez nous (stockage, coût, droit).

Agents : `performance-web` (mesures en production), `qualite-donnees` (volume et poids, SQL en
lecture seule), `data-pipeline` (architecture), `juridique-rgpd` (droit). Aucun fichier de code
modifié, rien écrit en base.

## Verdict

**Les photos des sources ne sont pas la cause principale de la lenteur de `/sales`.** L'hébergement
ne ferait presque rien gagner au premier affichage. La vraie cause est la vignette Mapbox de la
première carte, quand celle-ci n'a pas de photo.

| Mesure (production, mobile 4G, 3 essais)    | Score | Affichage principal (LCP) |
| ------------------------------------------- | ----- | ------------------------- |
| `/sales` telle quelle, 1re carte sans photo | 57    | 9,1 s                     |
| Même page, photos des sources bloquées      | 61    | 9,1 s (aucun gain)        |
| Même page, vignettes Mapbox bloquées        | 78    | 2,7 s                     |
| `/sales` quand la 1re carte a une photo     | 89    | 2,6 s                     |

Simulation « photos hébergées chez nous » (Playwright, mobile en 4G réellement bridée, 3 essais) :
27 photos vench.fr et licitor.com servies en WebP 640 px, 45 Ko en moyenne. Premier affichage
(FCP) de 1,79 à 1,64 s, LCP de 2,15 à 2,06 s, fin du chargement de 5,9 à 5,8 s. Même en
remplaçant toutes les photos par une image grise de 1,3 Ko, le gain plafonne à 0,3 s de FCP et
0,6 à 0,9 s de LCP. Sur bureau, le gain est nul. **Gain de l'hébergement : faible.**

Deux causes, sans rapport avec les photos des sources :

1. **La vignette Mapbox reste invisible jusqu'à l'exécution du JavaScript.** Le HTML l'envoie avec
   `opacity-0` et `SaleVisual.tsx` ne l'affiche qu'après `onLoad` (lignes 197 à 234). L'image est
   arrivée mais reste cachée 5,5 s sur 9 s.
2. **Les vignettes Mapbox de la production sont lourdes** : PNG 1024×768, 185 Ko chacune, pour une
   case de 386×290. La PR #269 les passe en WebP 400×300 (55 Ko sur écran haute densité). Elle
   n'est pas encore en production.

Part des photos des sources dans le poids de la page 1 (défilement complet) : 10,5 % (272 Ko sur
2 584 Ko), contre 47 % pour les vignettes Mapbox et 21 % pour le JavaScript. Exception : sur la
page 2, deux photos vench.fr de 723 et 545 Ko pèsent 36 % de la page. Elles sont plus bas dans la
page : elles ralentissent le défilement, pas le premier affichage.

## Stockage, si l'on hébergeait quand même

| Scénario                            | Aujourd'hui | Catalogue stable (ventes purgées) | Un an sans aucune purge |
| ----------------------------------- | ----------- | --------------------------------- | ----------------------- |
| Originaux                           | 1,9 Go      | 2,5 Go                            | 19,5 Go                 |
| WebP, une taille (1 200 px)         | 0,44 Go     | 0,57 Go                           | 4,5 Go                  |
| WebP, deux tailles (640 + 1 600 px) | 0,73 Go     | 0,95 Go                           | 7,5 Go                  |

- Catalogue : 1 675 ventes à venir, 1 166 avec photo, environ 5 300 photos. Les photos de
  notaires.fr en font 60 %.
- Coût de stockage : quelques centimes par mois, compris dans les 100 Go de Supabase Pro.
- La bande passante est incluse jusqu'à environ 250 000 vues de `/sales` par mois en vignettes.
- Petites Affiches bloque les téléchargements automatiques (Cloudflare) : ses photos ne pourraient
  pas être copiées.
- La purge des ventes devrait aussi supprimer les fichiers (`sale_retention_storage_queue`, à
  étendre).
- Estimation du travail : 5 à 8 jours pour la copie complète.
- Effet de bord : le retrait d'une source, qui teste aujourd'hui l'hôte de l'URL, ne masquerait
  plus ses photos copiées.

## Droit (à faire valider par un avocat)

- Le lien direct est défendable (CJUE Svensson, BestWater). La copie hébergée est une
  reproduction : elle demande l'autorisation des titulaires (CJUE Renckhoff, C-161/17), et s'y
  ajoute le droit des bases de données (CPI L. 342-1 et L. 342-2).
- Notaires.fr, Avoventes, Vench et Info-enchères interdisent la reproduction sans autorisation
  écrite. Licitor n'a donné qu'un accord oral, qui portait sur les statistiques. Aucune source ne
  nous autorise par écrit.
- L'optimiseur d'images de Vercel (`/_next/image`) garde déjà une copie réduite en cache pour
  notaires.fr et Avoventes. La PR #269 y ajoute les vignettes vench.fr. Avis de l'agent : orange à
  rouge sans accord écrit.

## Propositions

| N°  | Proposition                                                                                                                                                                                         | Priorité   | Effort               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------- |
| P1  | Afficher la vignette de la 1re carte dès le HTML, sans attendre le JavaScript (la cacher seulement en cas d'erreur). Gain attendu : LCP de 9 s à environ 2,7 s quand la 1re carte n'a pas de photo. | Critique   | S                    |
| P2  | Mettre en production les vignettes Mapbox allégées de la PR #269 (environ −850 Ko sur la page 1), puis remesurer.                                                                                   | Critique   | Fusion de la PR #269 |
| P3  | Décider du sort de l'optimiseur pour notaires.fr, Avoventes et vench.fr (garder, retirer, ou garder en attendant les accords).                                                                      | Important  | S                    |
| P4  | Ne pas héberger les photos pour l'instant. Y revenir source par source après une autorisation écrite, en commençant par la photo principale.                                                        | Important  | Aucun                |
| P5  | Ajouter un crédit visible « Photo : via [source] » avec lien vers l'annonce d'origine.                                                                                                              | Suggestion | S                    |

## Limites

- Mesures prises depuis un conteneur situé aux États-Unis : les temps vers les hôtes français sont
  pessimistes. Aucune donnée de terrain (CrUX).
- L'ordre de `/sales` a changé pendant la mesure : le score dépend de ce qui arrive en tête de liste.
- La cause du délai d'affichage (P1) est déduite du code et de Lighthouse, pas encore confirmée par
  un correctif mesuré.
- Les citations des conditions d'utilisation des sources viennent d'un outil de résumé : à relire
  sur les pages avant tout courrier.

## Décision du propriétaire (16/10/2026)

« ok pour P1/P2/P3/P5 et du coup testons d'heberger les images ».

- P1 : en cours.
- P2 : PR #269 fusionnée.
- P3 : optimiseur conservé pour notaires.fr, Avoventes et Vench (« Garder les trois »).
- P5 : en cours.
- P4 écartée : test d'hébergement de la **photo principale de chaque vente, pour toutes les
  sources** téléchargeables, désactivable par interrupteur (pipeline et site).

## Exécution (16/10/2026)

- PR #269 (vitesse) puis PR #270 (P1, P5 et test d'hébergement) fusionnées sur accord du
  propriétaire (« Tu fusionnes et tu lances le test »).
- Migration `20261026100000_sale_photo_mirrors.sql` appliquée en production par le workflow
  « Apply Supabase Migrations ». Le premier essai a été annulé par un verrou pris par une collecte en
  cours, sans rien modifier. Le second essai a réussi.
- Variable de dépôt `PHOTO_MIRROR_ENABLED=true` créée par le propriétaire, puis rattrapage lancé
  (« Photo Mirror Backfill »). Après 6 minutes : 220 copies, de 40 à 60 Ko en moyenne pour la version
  640 px. Petites Affiches est bloqué, comme prévu.
- `NEXT_PUBLIC_PHOTO_MIRROR=on` sur Vercel (production), puis redéploiement. 18 copies sont servies sur
  la page 1 de `/sales`.

### Remesure de `/sales` (production, 14 h à 15 h UTC)

| Mesure                                              | Avant         | Après                           |
| --------------------------------------------------- | ------------- | ------------------------------- |
| Poids de la page 1 après défilement (mobile)        | 2 584 Ko      | 1 829 Ko (−29 %)                |
| Poids de la page 2 après défilement (mobile)        | 3 485 Ko      | 1 838 Ko (−47 %)                |
| Vignette Mapbox                                     | 173 Ko        | 46 Ko (−73 %)                   |
| LCP mobile, 1re carte Mapbox (4G réellement bridée) | 9,1 s         | ≈ 3 s                           |
| Lighthouse mobile, page 1 (1re carte photo)         | 89, LCP 2,6 s | 78, LCP 4,7 s (instable)        |
| Lighthouse bureau                                   | 61            | 59 (TBT 4,3 s, carte Mapbox GL) |

- P1 a supprimé le délai d'affichage de la vignette Mapbox.
- Le LCP mobile de la page 1 est instable : la photo s'affiche vers 3,4 s, puis son élément grandit de
  5 % vers 6 s une fois sur deux.
- Les copies sont servies depuis le cache Cloudflare de Supabase (HIT) en 0,15 à 0,22 s.

Propositions suivantes :

- Q1 : stabiliser le LCP mobile. Validé.
- Q2 : différer la carte Mapbox GL sur bureau. Non retenu pour l'instant.
- Q3 : préconnexion vers Supabase, cache d'un an des copies, qualité WebP. Validé.

### Q4 : liste de `/sales` recréée à l'hydratation (17/10/2026)

- Q4 a été validé par le propriétaire (« tu corriges la dispersion passagère »).
- **Cause.** Le premier rendu client de l'authentification ne concordait pas avec le HTML serveur, si bien que React recréait la liste déjà affichée.
- **Correctif.** L'état d'authentification est lu dans un magasin partagé. Il vaut « vérification en cours » pendant l'hydratation, comme dans le HTML serveur.
- **Résultats :**
  - liste recréée 0 fois sur 12 essais, contre 10 fois sur 10 avant ;
  - une seule entrée LCP ;
  - CLS mobile à 0.
- **Effet de bord.** Un CLS bureau de 0,03 apparaît, sous le seuil de 0,1. Il existait déjà, mais la recréation le masquait.
- **Accessibilité.** Le contrôle Axe de la fiche d'exemple a révélé un défaut ancien, lui aussi masqué jusque-là : des étiquettes sans rôle sur le plan cadastral. Il est corrigé.
- **Relecture de code.** Aucun point bloquant. Les tests ont été renforcés : déconnexion, changement de compte, montage après le chargement, vérification unique de l'identité.
- **Limite documentée dans le code.** Un composant monté pendant le changement d'identité peut voir une fois l'état précédent. Aucune décision d'accès ne repose sur cet état côté client.
