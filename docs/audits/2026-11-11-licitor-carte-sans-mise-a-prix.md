# Licitor : inventaire refusé par une carte sans mise à prix (10 et 11/11/2026)

Note rédigée le 11/11/2026 avec le correctif (branche `claude/licitor-carte-sans-mise-a-prix`). Aucune
requête vers le site ni écriture en base : pages enregistrées par le diagnostic et fixtures fictives.

## Cause

Depuis le 10/11/2026 à 06:00 UTC, une annonce Licitor est publiée en quatre cartes de lot (une URL par
lot) dont deux ont un bloc prix vide (`<p class="Initial"></p>`). Le lecteur des listes
(`_list_item_container`, `services/data-pipeline/src/sources/licitor.py`) cherchait « Mise à prix » dans
le lien de la carte, puis remontait de parent en parent : pour ces deux cartes il arrivait à
`<ul class="AdResults">` et lisait le texte de toute la liste. Deux effets :

- l'empreinte de la carte lue différait de celle de la preuve de catalogue (`src/catalogue_proof.py`),
  qui refusait à juste titre l'inventaire (`no_matching_total_or_terminal_page_proof`) ; sans inventaire
  complet, les ventes retirées de Licitor avant leur audience ne sont plus repérées ;
- les deux lots prenaient la commune, le titre et la mise à prix de la première carte de leur page (une
  autre annonce). Ils sont en quarantaine multi-lots, donc jamais visibles.

## Correctif

- La remontée s'arrête au premier parent qui porte un autre lien d'annonce : la carte est alors le lien
  lui-même, celui que lit la preuve. Une carte sans prix garde sa commune et son titre, sa mise à prix
  reste vide. La fiche détaillée fournit la mise à prix quand elle désigne le lot ; sinon le lot reste
  sans prix et en quarantaine.
- La preuve de catalogue n'est pas modifiée : égalité stricte des empreintes et des comptes.
- Sur les 14 pages réelles enregistrées (67 cartes) : 65 cartes lues à l'identique, 2 corrigées, plus
  aucun écart d'empreinte entre le lecteur et la preuve.
- Avoventes, même famille (carte `[data-link]` sans « Mise à prix » écartée par le lecteur, comptée par
  la preuve) : non modifié. Une telle carte n'a jamais été observée et la mise à prix Avoventes ne vient
  que de la carte : la conduite à tenir reste à décider.

## Après la mise en ligne

1. Premier passage Licitor (un inventaire toutes les 12 h) : l'inventaire doit redevenir complet et le
   run réussir. Les deux lots sont relus avec leur propre carte ; leurs lignes stockées (texte des
   annonces voisines dans `source_lots` et `lots_publics`) sont réécrites à ce passage.
2. Retraits : une vente n'est retirée qu'après deux inventaires complets sans elle, distants d'au moins
   12 h. Une vente disparue pendant la panne est comptée absente une première fois à ce premier
   inventaire, et retirée au plus tôt à l'inventaire complet suivant, 12 h plus tard. Une vente déjà
   comptée absente une fois avant la panne peut être retirée dès le premier inventaire complet.
3. Plafond : si plus de 15 % des ventes visibles de la source devaient être retirées d'un coup, rien
   n'est retiré et l'alerte `catalogue.source_absence.licitor` est levée. Peu probable après deux jours
   sans inventaire, mais à surveiller : dans ce cas, examiner les ventes à la main.

## Requêtes de contrôle (lecture seule, comptages ; non exécutées lors du correctif)

```sql
-- 1. Inventaire redevenu complet ? Attendu : vrai, 0 échec, 0 partition refusée.
select last_inventory_complete_at >= now() - interval '13 hours' as inventaire_recent,
       consecutive_failures as echecs_consecutifs,
       (select count(*) from jsonb_array_elements(coverage -> 'certificate' -> 'partitions') as p
         where p -> 'reasons' <> '[]'::jsonb) as partitions_refusees
from public.auction_source_state where source_name = 'licitor';

-- 2. Les quatre lots de l'annonce : quatre communes, aucun lot visible sans avoir été désigné.
select count(*) as lots, count(distinct city) as communes,
       count(*) filter (where starting_price_eur is not null) as avec_mise_a_prix,
       count(*) filter (where app_private.auction_sale_is_publicly_visible(id)) as visibles
from public.auction_sales where source_name = 'licitor' and external_id = '110621';

-- 3. Compteurs d'absence : 1 après le premier inventaire complet, 2 avant un retrait.
select state, absent_inventories, count(*) from app_private.auction_sale_source_presence
where source_name = 'licitor' group by 1, 2 order by 1, 2;

-- 4. Retraits pour absence depuis la mise en ligne (aucun avant le deuxième inventaire complet,
--    sauf ventes déjà comptées absentes avant la panne).
select count(*) from public.auction_sales
where source_name = 'licitor' and status = 'withdrawn'
  and (raw_payload -> 'source_absence' ->> 'withdrawn_at')::timestamptz >= timestamptz '2026-11-11 00:00+00';
```
