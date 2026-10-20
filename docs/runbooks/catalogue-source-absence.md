# Alerte `catalogue.source_absence.<source>` (critique)

Le retrait des ventes absentes d'une source (`20261028110100`, fonction de retrait par source) s'est
**bloqué** : plus de 15 % des ventes visibles de la source sont absentes de ses deux derniers inventaires
complets. Un coup si large ressemble à un inventaire tronqué, pas à des ventes disparues : **aucun retrait**
n'a été fait. L'évidence donne `population`, `candidates`, `share` et `sample_sale_ids`.

## Diagnostic

1. `select details from operational_alerts where alert_key = 'catalogue.source_absence.<source>';`
2. Ouvrir à la main quelques `sample_sale_ids` (page de la vente et source d'origine) : l'annonce existe-t-elle
   encore chez la source ?
3. Contrôler l'inventaire de la source (`docs/runbooks/pipeline-source-drop.md`) : nombre d'annonces,
   pagination, décodage.

## Actions

- Inventaire tronqué : corriger l'inventaire ; au passage suivant la part repasse sous 15 % et l'alerte se
  ferme sans retrait.
- Ventes réellement disparues en masse (la source a tout retiré) : décision du propriétaire, avec
  l'application explicite de la fonction de retrait ; jamais en masse sans relecture des identifiants.

## Fermeture

Automatique : la fonction ferme l'alerte au premier passage sans blocage.
