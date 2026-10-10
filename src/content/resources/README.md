# Articles du blog Immojudis

Le blog public est accessible sur `/ressources`. Le guide historique reste sur
`/ventes-immobilieres-judiciaires`, avec ses ancres existantes.

Pour ajouter un article :

1. Créer un fichier JSON dans ce dossier en reprenant la structure d’un article existant.
2. Choisir un `slug` unique, une date `publishedAt` au format `AAAA-MM-JJ` et des identifiants
   `sections[].id` uniques dans l’article pour le sommaire.
3. Importer le fichier dans `src/lib/resource-articles.ts` et ajouter une entrée `defineArticle`
   à `RESOURCE_ARTICLES`, avec une image locale disponible dans `public`.
4. Vérifier les affirmations et renseigner les sources officielles dans `sources`.
5. Lancer `npm run build` et vérifier l’article et son filtre dans le navigateur.

L’index, les catégories, le temps de lecture, les liens de lecture, les métadonnées,
les routes statiques et le sitemap utilisent ce registre. Les paragraphes restent du texte
simple ; les listes, tableaux et encadrés ont leurs champs dédiés. Aucun HTML n’est exécuté
depuis les fichiers JSON. La mise en ligne d’un nouvel article nécessite un déploiement.
