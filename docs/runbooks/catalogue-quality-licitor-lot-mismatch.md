# Alerte `catalogue.quality.licitor_lot_mismatch` (avertissement)

Une vente Licitor **en ligne** affiche une mise à prix différente (d'un euro ou plus) de celle de sa propre carte de
liste (`raw_payload->'source_lots'->0->>'starting_price_eur'`). Cas d'origine (audit qualité du 03/11/2026,
#407) : sur une annonce à plusieurs lots, la mise à prix ou la commune d'un autre lot recopiée sur la fiche.
Mesure de la sentinelle qualité (`app_private.catalogue_quality_metrics`, migration `20261111100000`), évaluée à
chaque passage d'`operational-health` (toutes les 30 minutes). Seuil : 0, une vente suffit.

Depuis `20261201100000`, l'alerte ne s'ouvre que si une vente discordante est présente sur **deux évaluations
consécutives** : un cas transitoire (page à plusieurs lots recalculée entre deux passages) ne sonne plus. Chaque
évaluation garde sa mesure dans `auction_pipeline_observations` (`source_name = 'catalogue-quality-licitor-lot'`,
90 jours). Détails : `count`, `previous_count`, `example_sale_ids` (cinq au plus), `licitor_live`,
`without_card`, `unreadable_card`.

## Diagnostic

1. Mesure du moment, en lecture seule :
   `select app_private.catalogue_quality_metrics() -> 'metrics' -> 'licitor_lot_mismatch';`
2. Historique des évaluations (le cas est-il persistant ?) :
   `select observed_at, metrics->'count', metrics->'example_sale_ids' from auction_pipeline_observations
where source_name = 'catalogue-quality-licitor-lot' order by observed_at desc limit 12;`
3. Les ventes en exemple :

```sql
select id, source_url, lot_number, city, starting_price_eur,
       raw_payload->'source_lots'->0->>'starting_price_eur' as carte,
       raw_payload->'source_lots' as lots, updated_at
  from public.auction_sales
 where id in (<example_sale_ids>);
```

4. Ouvrir l'annonce Licitor (`source_url`) : quelle valeur la page donne-t-elle pour ce lot ?

## Décision

- **La fiche porte la valeur d'un autre lot** (cas d'origine) : c'est un vrai défaut, visible des visiteurs.
  Faire relire la fiche par la collecte (tâche `source_detail` de la vente, ou prochain inventaire Licitor) ; si
  la relecture reproduit l'erreur, c'est le décodage multi-lots (`services/data-pipeline/src/sources/licitor.py`)
  qu'il faut corriger. Ne jamais écrire la mise à prix à la main dans `auction_sales`.
- **La carte est fausse ou ambiguë** (la page elle-même donne une autre mise à prix au lot) : défaut de la source.
  Le noter ; la règle ne prévoit pas de liste de ventes reconnues pour cette mesure (contrairement au prix au m²,
  `price_per_m2_acknowledged_sale_ids`). En ajouter une se fait par une migration de
  `app_private.catalogue_quality_thresholds()` et de la mesure, sur décision du propriétaire.
- **Cas disparu à l'évaluation suivante** : transitoire, rien à faire ; l'alerte ne s'ouvre plus pour ce cas.

## Quand acquitter

Il n'y a pas d'acquittement : l'alerte devient inactive dès qu'aucune vente discordante n'est mesurée et se ferme
deux heures plus tard. Ne pas passer la ligne en `resolved` à la main : une vente encore discordante la rouvre
au passage suivant.
