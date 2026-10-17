# Lenteur de `/sales` : diagnostic complet

Date : 17/10/2026. Demande du propriétaire : « je ne comprends toujours pas pourquoi la page `/sales` met autant de
temps à charger ».

Méthode :

- Agent `performance-web` : mesures en production après la fusion de la PR #272, sur mobile 4G bridée et sur bureau, en
  Lighthouse et en Playwright, avec la lecture du code.
- Chef d'orchestre :
  - données de vrais visiteurs (Vercel Speed Insights) et journaux Vercel ;
  - requêtes de la base, avec `pg_stat_statements` et `EXPLAIN ANALYZE`, en lecture seule.

Aucun fichier de code n'a été modifié et rien n'a été écrit en base.

## Verdict

Il y a trois causes, d'impacts différents.

1. **La base de données relit les données brutes des annonces à chaque recherche.** C'est la cause la plus forte, et
   elle n'avait jamais été vue.
   - Pour décider si une annonce est encore visible, plusieurs requêtes lisent le champ `raw_payload` de chaque annonce.
     Ce champ pèse en moyenne 218 Ko et jusqu'à 2,7 Mo.
   - Visiteur connecté : la seule lecture du nombre de points de la carte prend **5,4 s** dans la base. La vue
     `v_auction_sales_app` lit `raw_payload->>'publication_quarantine'` pour chaque ligne.
   - Visiteur anonyme : la recherche publique (`search_auction_sales_preview_v3`) prend **0,6 s**, et 0,87 s en moyenne en
     production (217 appels, jusqu'à 2,7 s). Le chemin de secours y relit `raw_payload` pour les 193 annonces sans date
     limite précalculée. Sans ce chemin, le filtre prend 0,016 s au lieu de 1,3 s.
2. **Sur mobile, le premier écran envoie trop de poids d'un coup.**
   - Le premier écran télécharge 780 Ko, dont 419 Ko de JavaScript.
   - Le temps d'affichage dépend alors directement du débit :

     | Débit      | Affichage principal |
     | ---------- | ------------------- |
     | 9 Mbit/s   | 2,1 s               |
     | 1,6 Mbit/s | 4,4 s               |
     | 0,4 Mbit/s | 13,8 s              |

3. **Chaque clic attend deux appels Supabase en série, et la carte bloque le bureau.**
   - Un filtre, un tri ou un changement de page prend 1,4 à 2,7 s. La recherche puis les copies de photos sont demandées
     l'une après l'autre, chacune précédée d'une vérification CORS.
   - La carte Mapbox GL pèse 513 Ko et bloque le bureau environ 1 s sur un vrai ordinateur (estimation).

Ce qui va bien :

- Le serveur répond vite : 0,15 à 0,25 s depuis la France, estimé.
- La liste est dans le HTML.
- La fonction tourne à Paris et la base est en Irlande.

## Ce que voient les visiteurs

Données réelles Vercel Speed Insights, du 10 au 17/10 :

| Mesure                         | Valeur                              |
| ------------------------------ | ----------------------------------- |
| Visites de `/sales` mesurées   | 10                                  |
| Affichage principal (LCP, p75) | 9,5 s (15,8 s mobile, 6,2 s bureau) |
| Premier affichage (FCP, p75)   | 1,2 s                               |
| Réponse du serveur (TTFB, p75) | 0,03 s                              |

Pour comparer, l'accueil est à 0,7 s de LCP et la fiche d'une vente à 2,4 s. Réserve : l'échantillon est très petit et
contient probablement nos propres tests des 15 et 16/10, faits avant les correctifs.

Mesures de laboratoire après la PR #272, visiteur anonyme :

| Étape                                        | Mobile 4G bridée   | Bureau             |
| -------------------------------------------- | ------------------ | ------------------ |
| Liste visible                                | 3,9 s              | 1,1 s              |
| Élément principal affiché                    | 4,4 s              | 1,0 s (Lighthouse) |
| Liste cliquable                              | 5,0 s              | 1,3 s              |
| Carte prête                                  | (bouton « Carte ») | 3,7 à 4,5 s        |
| Clic sur un filtre ou une page, liste à jour | 2,2 à 2,75 s       | 1,4 à 2,0 s        |

Parcours connecté :

- Il n'a pas été mesuré dans le navigateur, faute de compte de test.
- Le code montre que, dès que le compte est reconnu, la liste servie dans le HTML est remplacée par un squelette. Au moins
  7 allers-retours suivent, en série : session, profil, droits, liste en deux requêtes, décompte, carte, copies de photos.
- La base ajoute 5,4 s pour les points de la carte.

C'est l'hypothèse la plus probable pour ce que ressent le propriétaire, s'il navigue connecté.

## Propositions

| N°  | Proposition                                                                                                                                                                                                                                                                                                                                                                                                            | Gain attendu                                                                                                                                                          | Effort   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S0  | **Base : ne plus lire `raw_payload` pour décider de la visibilité.** La vue `v_auction_sales_app` (et la vue « découverte ») utiliserait la colonne `catalogue_quarantined`, déjà présente, au lieu de `raw_payload->>'publication_quarantine'`. Le résultat « encore visible » serait précalculé pour les 193 annonces sans date limite. Migration avec tests pgTAP prouvant que les mêmes annonces restent masquées. | Carte et décompte connectés : de 5,4 s à moins de 0,1 s (estimé). Recherche publique : de 0,6–0,9 s à moins de 0,1 s (estimé). Chaque clic gagne environ 0,5 à 0,8 s. | M        |
| S1  | Alléger le premier écran mobile. Retirer le fond décoratif du squelette (51 Ko). Une seule image prioritaire au lieu de deux (33 Ko). Ne précharger l'italique de la police que sur l'accueil (39 Ko). Préconnexion vers Mapbox.                                                                                                                                                                                       | Affichage principal en 4G : −0,6 s (de 4,0 à 3,4 s, mesuré). Sur connexion lente : −2,2 s.                                                                            | S        |
| S2  | Ne charger le module Supabase qu'à la première recherche ou pour un visiteur connecté.                                                                                                                                                                                                                                                                                                                                 | −63 Ko de JavaScript, −0,2 s en 4G, −1,1 s sur connexion lente (mesuré).                                                                                              | M        |
| S3  | Un seul aller-retour par clic. Lancer la recherche des copies de photos sans bloquer la liste (S). Mieux : passer par une route de notre domaine qui renvoie liste et copies ensemble (M).                                                                                                                                                                                                                             | Clic : de 1,4–2,7 s à environ 0,5–1,0 s (estimé, avec S0).                                                                                                            | S puis M |
| S4  | Parcours connecté : garder la liste affichée pendant la vérification du compte, et lancer session, profil et droits en parallèle. À mesurer d'abord avec un compte de test.                                                                                                                                                                                                                                            | −1 à −2 s (estimé).                                                                                                                                                   | M à L    |
| S5  | Carte du bureau : ne charger Mapbox GL qu'au premier geste ou au clic sur « Voir la carte ». Décision produit.                                                                                                                                                                                                                                                                                                         | −513 Ko, environ −1 s de blocage sur bureau (estimé).                                                                                                                 | M        |
| S6  | Servir `/sales` sans filtre depuis le cache de Vercel (rafraîchi toutes les 5 minutes) plutôt que par une fonction à chaque visite.                                                                                                                                                                                                                                                                                    | −0,2 à −0,3 s, plus de démarrage à froid (estimé).                                                                                                                    | M        |
| S7  | CSP en mode rapport : 35 violations par page. Une requête sur Chrome, jusqu'à 35 sur Safari et Firefox. Décision de sécurité.                                                                                                                                                                                                                                                                                          | Moins de requêtes sur Safari et Firefox.                                                                                                                              | S à M    |

Ordre conseillé : S0, puis S1 et S3 (premier pas), puis S2, puis S4 une fois mesuré. S5 à S7 se décident à part.

## Limites

- Les mesures du navigateur ont été prises depuis les États-Unis, sur une machine sans carte graphique. Le blocage de la
  carte et les temps réseau sont pessimistes.
- Les gains de S0 sont estimés à partir des plans d'exécution. Ils seront remesurés après le correctif.
- Le plan Vercel Hobby limite la mesure : les journaux ne sont gardés qu'une heure et il n'y a pas de métriques de
  fonction.
- Le parcours connecté et Safari n'ont pas été testés dans le navigateur.
