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

| Mesure (production, mobile 4G, 3 essais) | Score | Affichage principal (LCP) |
| ---------------------------------------- | ----- | ------------------------- |
| `/sales` telle quelle, 1re carte sans photo | 57 | 9,1 s |
| Même page, photos des sources bloquées | 61 | 9,1 s (aucun gain) |
| Même page, vignettes Mapbox bloquées | 78 | 2,7 s |
| `/sales` quand la 1re carte a une photo | 89 | 2,6 s |

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

| Scénario | Aujourd'hui | Catalogue stable (ventes purgées) | Un an sans aucune purge |
| -------- | ----------- | --------------------------------- | ----------------------- |
| Originaux | 1,9 Go | 2,5 Go | 19,5 Go |
| WebP, une taille (1 200 px) | 0,44 Go | 0,57 Go | 4,5 Go |
| WebP, deux tailles (640 + 1 600 px) | 0,73 Go | 0,95 Go | 7,5 Go |

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

| N° | Proposition | Priorité | Effort |
| -- | ----------- | -------- | ------ |
| P1 | Afficher la vignette de la 1re carte dès le HTML, sans attendre le JavaScript (la cacher seulement en cas d'erreur). Gain attendu : LCP de 9 s à environ 2,7 s quand la 1re carte n'a pas de photo. | Critique | S |
| P2 | Mettre en production les vignettes Mapbox allégées de la PR #269 (environ −850 Ko sur la page 1), puis remesurer. | Critique | Fusion de la PR #269 |
| P3 | Décider du sort de l'optimiseur pour notaires.fr, Avoventes et vench.fr (garder, retirer, ou garder en attendant les accords). | Important | S |
| P4 | Ne pas héberger les photos pour l'instant. Y revenir source par source après une autorisation écrite, en commençant par la photo principale. | Important | Aucun |
| P5 | Ajouter un crédit visible « Photo : via [source] » avec lien vers l'annonce d'origine. | Suggestion | S |

## Limites

- Mesures prises depuis un conteneur situé aux États-Unis : les temps vers les hôtes français sont
  pessimistes. Aucune donnée de terrain (CrUX).
- L'ordre de `/sales` a changé pendant la mesure : le score dépend de ce qui arrive en tête de liste.
- La cause du délai d'affichage (P1) est déduite du code et de Lighthouse, pas encore confirmée par
  un correctif mesuré.
- Les citations des conditions d'utilisation des sources viennent d'un outil de résumé : à relire
  sur les pages avant tout courrier.
