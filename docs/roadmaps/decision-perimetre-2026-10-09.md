# Décision : périmètre géographique du produit

Date : 9 octobre 2026. Origine : constat LIVE-03 / PROD-05 de l'audit du même jour.

## Constat

- La description du projet annonçait la Nouvelle-Aquitaine, mais la collecte,
  le catalogue, la recherche, les statistiques et la carte fonctionnent à
  l'échelle de la France (`TARGET_DEPARTMENTS` vide = France entière,
  catalogue intitulé « France entière »).
- En production, 163 ventes sur 2 830 (environ 6 %) se situent en
  Nouvelle-Aquitaine.

## Décision

**Le périmètre est la France entière.** Aucune vente n'est exclue ni
désactivée, et aucune collecte n'est restreinte.

Raisons :

1. C'est l'état réel du produit : restreindre à une région supprimerait environ
   94 % du catalogue et casserait les statistiques nationales.
2. C'est réversible : fixer `TARGET_DEPARTMENTS` (liste de codes séparés par des
   virgules) restreint la collecte sans migration.
3. Annoncer la région sans la couvrir serait une promesse fausse ; annoncer la
   France sans l'avouer serait l'inverse. L'aligner sur la réalité règle les
   deux.

## Conséquences

- Les textes (`package.json`, pages publiques) parlent de la France ; la
  couverture inégale selon les sources est dite clairement
  (`/comment-ca-marche`, section « Couverture et limites »).
- Les données de référence locales (loyers, prix) doivent exister pour tous les
  départements, sinon la valeur n'est pas affichée (tâche P2-02).
- Le département et les coordonnées manquants sont complétés par le pipeline
  (tâche P1-08).

## Revenir à une région

1. Définir `TARGET_DEPARTMENTS` dans les workflows `data-pipeline.yml` et
   `recompute-existing-sales.yml` (variable de dépôt).
2. Masquer les ventes hors zone du catalogue avec un statut dédié, sans les
   supprimer.
3. Remettre le nom de la région dans les textes publics.
