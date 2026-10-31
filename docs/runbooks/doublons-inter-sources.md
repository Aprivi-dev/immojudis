# Alerte `catalogue.duplicates.cross_source` (avertissement, puis critique)

Le catalogue public compte trop de **groupes de doublons inter-sources** : des ventes visibles qui ont le même
jour de vente (heure de Paris), la même mise à prix (à l'euro près) et la même ville normalisée, et qui viennent
d'au moins deux sources différentes (`source_name`). C'est le signe que la fusion du pipeline ne rapproche plus
les annonces (variable `DEDUPE_RECONCILE_ENABLED` coupée ou repassée à `false`, nouvelle source mal rapprochée,
clé de rapprochement cassée). Le 31/10/2026, avant l'activation de la fusion, il y avait 72 groupes (152 lignes).

Seuils (`app_private.cross_source_duplicate_thresholds()`) : avertissement à partir de **30 groupes**, critique à
partir de **150**. Ce sont des signaux, pas des verdicts : deux lots distincts de même prix, même jour et même
ville vendus par deux sources forment un groupe sans être un doublon. **Les seuils sont à recaler** sur la
première mesure faite après l'activation de la fusion (changer la fonction par une migration).

## Diagnostic

1. Le nombre : `select details from operational_alerts where alert_key = 'catalogue.duplicates.cross_source';`
   (`groups`, `lines`, seuils).
2. La liste des groupes, avec les ventes concernées (rôle de service ; aucune donnée personnelle) :

   ```sql
   select d.*, array_agg(s.id order by s.source_name) as sale_ids,
          array_agg(distinct s.source_name) as sources
   from app_private.cross_source_duplicate_groups() d
   join public.auction_sales s
     on (s.sale_date at time zone 'Europe/Paris')::date = d.sale_day
    and round(s.starting_price_eur)::bigint = d.starting_price_eur
    and app_private.normalize_commune_name(s.city) = d.city_key
    and app_private.auction_sale_is_publicly_visible(s.id)
   group by d.sale_day, d.starting_price_eur, d.city_key, d.line_count, d.source_count
   order by d.line_count desc, d.sale_day;
   ```

3. Relire quelques groupes à la main (même adresse, même surface, même tribunal ?). Une majorité de vrais
   doublons confirme une panne de la fusion ; une majorité de lots distincts demande de relever le seuil.
4. La fusion tourne-t-elle ? Variable de dépôt `DEDUPE_RECONCILE_ENABLED` (Settings → Secrets and variables →
   Actions → Variables), puis le résumé du dernier passage de `data-pipeline.yml`.

## Actions

- Fusion coupée : relancer la procédure de `docs/runbooks/chantier-f-reparations-donnees.md` (liste des paires
  par le workflow `dedupe-candidates`, relecture, puis `DEDUPE_RECONCILE_ENABLED=true`). Ne pas fusionner à la
  main en base.
- Une source nouvelle ou modifiée rapproche mal : corriger la clé de rapprochement du pipeline
  (`services/data-pipeline/src/dedupe.py`), pas la valeur du seuil.
- Seuil trop bas pour le bruit normal : le relever par migration, en notant la mesure qui le justifie.

## Fermeture

Automatique : le nombre de groupes repasse sous le seuil d'avertissement, l'alerte devient inactive puis se ferme
deux heures plus tard.
