# Visibilité du catalogue sans relire `raw_payload` — pose, dérive, retour arrière

La visibilité publique d'une annonce (vues `v_auction_sales_app` et `v_auction_sales_discovery`, politique
`auction_sales_authenticated_read`, aperçu, recherche v1 à v4, sitemap, résumé, fiche, calendrier,
activité des tribunaux, copies de photos, miroir de photos du pipeline) ne lit plus que des colonnes
de `public.auction_sales` :

| Colonne                        | Rôle                                                                | Maintenue par                                     |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------- |
| `catalogue_quarantined`        | `coalesce(raw_payload->>'publication_quarantine', '') <> ''`        | `zzzz_…_projection_*` puis `zzzzz_…_visibility_*` |
| `catalogue_expiry_deadline`    | date limite matérialisée (existante)                                | `zzzz_auction_sales_retention_deadline_*`         |
| `catalogue_expiry_fallback`    | `sale_catalogue_expiry(...)`, quand la date limite est nulle        | `zzzzz_auction_sales_catalogue_visibility_*`      |
| `catalogue_state_observed_at`  | `state_listing.observed_at` d'une fiche de l'État active, sans date | `zzzzz_auction_sales_catalogue_visibility_*`      |
| `catalogue_state_end_estimate` | `state_listing.listing_end_estimate` de cette fiche                 | `zzzzz_auction_sales_catalogue_visibility_*`      |

`raw_payload` reste la source de vérité de la quarantaine. Le déclencheur `zzzzz_…` la recalcule à
**chaque** insertion et à chaque écriture de `catalogue_quarantined`, `raw_payload`, `sale_date`,
`sale_procedure` ou des colonnes de date limite : une écriture directe de la colonne est corrigée.
Seule une écriture faite **déclencheurs désactivés** (`alter table … disable trigger`,
`session_replication_role = replica`) peut laisser la colonne en dérive : c'est ce que la requête ci-dessous
détecte.

## Pose

Trois migrations, à appliquer dans l'ordre, **hors collecte** (mettre la collecte en pause ou attendre la
fin d'un passage), l'une après l'autre :

1. `20261027100000_catalogue_visibility_columns.sql` : trois colonnes nulles. Verrou
   `ACCESS EXCLUSIVE` sur `auction_sales` pendant quelques millisecondes (jusqu'au `COMMIT`), aucune
   lecture de `raw_payload`.
2. `20261027100100_catalogue_visibility_projection.sql` : fonctions, déclencheurs, rattrapage des
   lignes existantes. Verrou `SHARE ROW EXCLUSIVE` : le catalogue reste lisible, les écritures attendent
   quelques secondes (le rattrapage lit `raw_payload->>'publication_quarantine'` de chaque ligne).
3. `20261027100200_catalogue_visibility_without_raw_payload.sql` : droits de colonnes, politique, vues
   et fonctions. Ne lit aucune ligne. Elle échoue sans effet si une définition n'a pas la forme attendue
   ou si une fonction perd son `SECURITY DEFINER`, son `search_path` ou ses droits.

Chacune commence par `lock_timeout = 5s` : un verrou non obtenu fait échouer la migration sans rien
changer. Relancer hors collecte. Les trois sont rejouables.

**Avant la troisième**, enregistrer les définitions actuelles (voir « Retour arrière »).

## Les trois clés de quarantaine (20261028110200)

Le pipeline met une vente en quarantaine si l'une de **trois** clés de `raw_payload` est vraie
(`_QUARANTINE_PAYLOAD_KEYS`, `src/admission.py`) : `publication_quarantine`,
`publication_identity_conflict` (posée par `hold_identity`) et `source_identity_mismatch`. Jusqu'à
cette migration, `catalogue_quarantined` ne lisait que la première. La règle est maintenant dans
`app_private.catalogue_quarantine_from_payload(raw_payload)` (vrai comme en Python : chaîne non vide,
`true`, nombre non nul, tableau ou objet non vide), lue par les deux déclencheurs de projection.

**Effet à l'application** : une vente qui ne porte que `publication_identity_conflict` ou
`source_identity_mismatch`, sans `publication_quarantine`, et dont le statut n'est pas `quarantined`,
quitte le catalogue public. À compter **avant** d'appliquer (lecture seule, hors pointe) :

```sql
select count(*) filter (where coalesce(status, 'unknown') in ('upcoming', 'unknown', 'postponed')
                          and not catalogue_quarantined) as deviendront_masquees,
       count(*) filter (where catalogue_quarantined) as deja_masquees
from public.auction_sales
where coalesce(raw_payload ->> 'publication_identity_conflict', '') not in ('', '{}', 'null')
   or coalesce(raw_payload ->> 'source_identity_mismatch', '') not in ('', 'false', '0', '[]', '{}', 'null');
```

La migration recalcule la colonne des lignes concernées (`app_private.repair_catalogue_quarantine_drift()`,
sans déclencher le journal des ventes ni la relecture IA : une bascule qu'elle provoque ne passe donc pas
par les déclencheurs, le cache public se renouvelle à son échéance). Cette fonction se rejoue à tout moment
(`select app_private.repair_catalogue_quarantine_drift();`, hors pointe : verrou `SHARE ROW EXCLUSIVE`) ;
elle remplace le « rejouer 20261027100100 » de la section suivante.

## Surveillance (`python -m src.pipeline_health --report-only`)

Le rapport de la fin de chaque collecte contient `catalogue_projection` (des comptes, rien d'autre) :

| Clé                               | Sens                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `quarantine_drift_48h`            | lignes modifiées depuis 48 h dont la colonne diffère de la règle ; **non nul : rapport dégradé**                                |
| `quarantine_drift_full`           | la même sur toutes les lignes, le lundi (UTC) seulement (`PIPELINE_HEALTH_FULL_DRIFT` la force ou la coupe) ; non nul : dégradé |
| `status_quarantined_without_flag` | ventes `status = 'quarantined'` dont `catalogue_quarantined` vaut faux (masquées par leur statut seul)                          |
| `state_listings_leaving_7d`       | fiches de l'État visibles qui sortiront du catalogue sous 7 jours (observées il y a 7 à 14 jours)                               |

Avant la migration, la dérive est mesurée sur `publication_quarantine` seule (`quarantine_rule`). Si les
colonnes manquent, `available` vaut faux et le rapport continue.

## Requête de dérive (lecture seule)

À lancer après la pose, puis après toute opération qui désactive les déclencheurs de `auction_sales`
(rattrapage, import, réparation manuelle). Elle lit `raw_payload` de toutes les lignes : hors pointe.

```sql
select count(*) as lignes_en_derive
from public.auction_sales
where catalogue_quarantined
        is distinct from (coalesce(raw_payload ->> 'publication_quarantine', '') <> '');
```

Le résultat attendu est `0`. Pour voir les lignes :

```sql
select id, catalogue_quarantined, raw_payload ->> 'publication_quarantine' as marqueur
from public.auction_sales
where catalogue_quarantined
        is distinct from (coalesce(raw_payload ->> 'publication_quarantine', '') <> '')
limit 50;
```

Les trois colonnes de repli se contrôlent sans lire `raw_payload` des lignes à date limite
matérialisée :

```sql
select count(*) as lignes_de_repli_en_derive
from public.auction_sales sale
where case
        when coalesce(sale.catalogue_expiry_materialized, false)
             and sale.catalogue_expiry_deadline is not null
          then sale.catalogue_expiry_fallback is not null
            or sale.catalogue_state_observed_at is not null
            or sale.catalogue_state_end_estimate is not null
        else exists (
          select 1
          from app_private.catalogue_visibility_projection(
            sale.catalogue_expiry_materialized, sale.catalogue_expiry_deadline, sale.sale_date,
            sale.raw_payload, sale.sale_procedure
          ) projection
          where sale.catalogue_expiry_fallback is distinct from projection.expiry
             or sale.catalogue_state_observed_at is distinct from projection.state_observed_at
             or sale.catalogue_state_end_estimate is distinct from projection.state_end_estimate
        )
      end;
```

**Si le résultat n'est pas `0`** : une annonce marquée `publication_quarantine` peut être publique. La
corriger tout de suite, hors collecte, en rejouant `20261027100100_catalogue_visibility_projection.sql`
(son rattrapage recalcule les quatre colonnes des seules lignes en dérive, sans déclencher le journal des
ventes), puis relancer la requête. Chercher ensuite qui a écrit hors déclencheur.

## Contrôle d'équivalence (lecture seule)

Compare, ligne à ligne, l'ancien prédicat (`sale_catalogue_entry_is_live_materialized` et
`raw_payload->>'publication_quarantine'`) au nouveau (colonnes seules), en recalculant à la volée les
valeurs de repli. Les trois compteurs doivent valoir `0`. Il lit `raw_payload` de toutes les lignes :
hors pointe, avec un `statement_timeout` large. Une fiche de l'État dont la date est impossible
(`2026-02-30`, fuseau `+99:00`) ferait lever l'ancien prédicat, donc cette requête aussi : c'est la
raison pour laquelle l'ancien prédicat ne doit plus rester en service.

```sql
with prep as (
  select
    s.id,
    coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed') as status_ok,
    s.catalogue_expiry_materialized as materialized,
    s.catalogue_expiry_deadline as deadline,
    s.sale_date,
    s.catalogue_quarantined as quarantined_column,
    coalesce(s.raw_payload ->> 'publication_quarantine', '') <> '' as quarantined_payload,
    coalesce(app_private.sale_catalogue_entry_is_live_materialized(
      s.catalogue_expiry_materialized, s.catalogue_expiry_deadline, s.sale_date,
      s.raw_payload, s.sale_procedure
    ), false) as old_live,
    (s.catalogue_expiry_materialized and s.catalogue_expiry_deadline is not null) as fast_path,
    s.raw_payload,
    s.sale_procedure
  from public.auction_sales s
),
proj as (
  select
    p.*,
    case when not p.fast_path then app_private.sale_catalogue_expiry(
      p.sale_date,
      (case
        when jsonb_typeof(coalesce(p.raw_payload, '{}'::jsonb)) = 'object'
          then coalesce(p.raw_payload, '{}'::jsonb)
        else '{}'::jsonb
       end) || jsonb_build_object('sale_procedure', coalesce(p.sale_procedure, '{}'::jsonb))
    ) end as expiry_fallback,
    (not p.fast_path
      and p.sale_date is null
      and jsonb_typeof(p.raw_payload -> 'state_listing') = 'object'
      and coalesce(p.raw_payload ->> 'source_name', '') = 'cessions_etat'
      and coalesce(p.raw_payload -> 'state_listing' ->> 'active', '') = 'true'
      and coalesce(p.raw_payload -> 'state_listing' ->> 'observed_at', '')
        ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
      and coalesce(p.raw_payload -> 'state_listing' ->> 'listing_end_estimate', '')
        ~ '^(\d{4}-\d{2}-\d{2})?$') as state_ok
  from prep p
),
vals as (
  select
    q.*,
    case when q.state_ok then (q.raw_payload -> 'state_listing' ->> 'observed_at')::timestamptz end
      as state_observed_at,
    case when q.state_ok
      then nullif(q.raw_payload -> 'state_listing' ->> 'listing_end_estimate', '')::date end
      as state_end_estimate
  from proj q
),
final as (
  select
    v.*,
    case
      when not coalesce(v.materialized, false) then false
      when v.deadline is not null then v.deadline > current_timestamp
      when v.sale_date is null then coalesce(
        v.state_observed_at > current_timestamp - interval '14 days'
        and v.state_observed_at <= current_timestamp + interval '1 day'
        and (
          v.state_end_estimate is null
          or v.state_end_estimate >= (current_timestamp at time zone 'Europe/Paris')::date
        ),
        false
      )
      else coalesce(v.expiry_fallback > current_timestamp, false)
    end as new_live
  from vals v
)
select
  count(*) filter (
    where (f.status_ok and f.old_live and not f.quarantined_payload)
      is distinct from (f.status_ok and f.new_live and not f.quarantined_column)
  ) as visibilite_differente,
  count(*) filter (where f.quarantined_column is distinct from f.quarantined_payload)
    as quarantaine_differente,
  count(*) filter (where not f.materialized) as lignes_non_materialisees,
  count(*) filter (
    where f.expiry_fallback is distinct from s.catalogue_expiry_fallback
       or f.state_observed_at is distinct from s.catalogue_state_observed_at
       or f.state_end_estimate is distinct from s.catalogue_state_end_estimate
  ) as colonnes_de_repli_differentes
from final f
join public.auction_sales s on s.id = f.id;
```

Le test `supabase/tests/470_catalogue_visibility_without_raw_payload.sql` exécute le même corps de requête
sur un jeu d'essai (quarantaine, sans date, dates passées et futures, procédure de vente, bornes de la
fiche de l'État, valeurs impossibles).

## Retour arrière

Les migrations ne se défont pas : on restaure les définitions précédentes. Les colonnes et les
déclencheurs peuvent rester (ils ne coûtent qu'une lecture de `raw_payload` par écriture concernée et
ne sont lus par aucune vue une fois les anciennes définitions restaurées).

**1. Avant d'appliquer la troisième migration**, enregistrer les définitions actuelles (en lecture, sur
la base de production, avec `SUPABASE_DB_URL`) :

```sql
-- psql "$SUPABASE_DB_URL" -X -f enregistrer-definitions.sql
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\o definitions-avant-s0.sql
select 'begin;';
select pg_get_functiondef(p.oid) || ';'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'app_private'
  and p.proname in (
    'auction_sale_is_publicly_visible', 'search_auction_sales_preview',
    'search_auction_sales_preview_v2', 'search_auction_sales_preview_v3',
    'search_auction_sales_preview_v4', 'list_public_sale_sitemap_entries',
    'get_public_sale_summary', 'get_public_sale_details', 'get_public_tribunal_activity',
    'get_public_sale_indexability', 'get_public_sale_calendar_event', 'sale_photo_mirrors',
    'set_catalogue_raw_columns_hidden'
  )
order by p.oid::regprocedure::text;
select format(
  'create or replace view public.%I%s as %s;',
  c.relname,
  case when c.reloptions is null then '' else ' with (' || array_to_string(c.reloptions, ', ') || ')' end,
  rtrim(pg_get_viewdef(c.oid, true), E';\n ')
)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('v_auction_sales_app', 'v_auction_sales_discovery')
order by c.relname;
select format(
  'alter policy %I on public.auction_sales using (%s);',
  polname, pg_get_expr(polqual, polrelid)
)
from pg_policy
where polrelid = 'public.auction_sales'::regclass
  and polname = 'auction_sales_authenticated_read';
select 'commit;';
\o
```

Conserver `definitions-avant-s0.sql` hors du dépôt (il contient le code des fonctions, pas de donnée).
Ces définitions peuvent aussi se reconstituer sans sauvegarde : la dernière migration qui définit chaque
objet avant `20261027100000` (`git log -- supabase/migrations`) ou une restauration à un instant donné
(PITR) de la base.

**2. Pour revenir en arrière**, hors collecte :

```bash
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f definitions-avant-s0.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
revoke select (
  catalogue_expiry_fallback, catalogue_state_observed_at, catalogue_state_end_estimate,
  catalogue_quarantined
) on table public.auction_sales from authenticated;
SQL
```

Le premier fichier restaure en une transaction les douze fonctions, la fonction dormante
`set_catalogue_raw_columns_hidden`, les deux vues et la politique. Le second retire le droit de lecture des
quatre colonnes (il n'existait pas avant). Le miroir de photos du pipeline utilise alors
`sale_catalogue_projection_is_live`, que ce retour arrière ne retire pas : il continue de fonctionner.
Si le pipeline doit lui aussi revenir en arrière, rétablir `CANDIDATES_SQL` de
`services/data-pipeline/src/photo_mirror.py` à sa version précédente.

**3. Suppression complète** (seulement si on abandonne la projection) : après le retour arrière, après
avoir rétabli `CANDIDATES_SQL` du pipeline (il lit les colonnes supprimées ci-dessous), et dans une
transaction hors collecte,

```sql
drop trigger if exists zzzzz_auction_sales_catalogue_visibility_insert on public.auction_sales;
drop trigger if exists zzzzz_auction_sales_catalogue_visibility_update on public.auction_sales;
drop function if exists app_private.sync_auction_sale_catalogue_visibility();
drop function if exists app_private.sale_catalogue_projection_is_live(
  boolean, timestamptz, timestamptz, timestamptz, timestamptz, date
);
drop function if exists app_private.catalogue_visibility_projection(
  boolean, timestamptz, timestamptz, jsonb, jsonb
);
alter table public.auction_sales
  drop column if exists catalogue_expiry_fallback,
  drop column if exists catalogue_state_observed_at,
  drop column if exists catalogue_state_end_estimate;
```

La colonne `catalogue_quarantined` et ses déclencheurs `zzzz_…_projection_*` datent de
`20261009180000` et restent.

## Invalidation du cache public après un retrait

Une vente qui quitte le catalogue (retrait, annulation, quarantaine, date passée, fusion de doublons)
doit sortir de `/sales`, de sa fiche, de l'aperçu `/api/catalogue/preview` et de l'export `.ics` sans
attendre 5 à 10 minutes. Le chemin complet :

1. **Base** : un déclencheur de `public.auction_sales` (`20261028100000_catalogue_invalidations.sql`)
   écrit l'identifiant de la vente dans `app_private.catalogue_invalidations (id, sale_id, at)` quand
   une vente visible cesse de l'être (statut, `catalogue_quarantined`, date limite : le même prédicat
   que les vues, `app_private.sale_catalogue_projection_is_live`) ou quand une ligne visible est
   supprimée. L'écriture est dans la transaction de la modification : aucun chemin d'écriture (collecte,
   fusion, réparation manuelle, rattrapage) ne l'oublie, et rien n'existe avant le COMMIT. Une vente qui
   devient visible, ou qui change sans cesser d'être visible, n'écrit rien.
2. **Pipeline** : `python -m src.cache_invalidation --flush`, étape « Invalidate public cache » de
   `data-pipeline.yml` (après « Finalize unfinished run », `if: always()`, `continue-on-error`). Elle lit
   au plus 100 identifiants à la fois (`for update skip locked`), appelle
   `POST {SITE_URL}/api/pipeline/revalidate-sale` avec `Authorization: Bearer $CRON_SECRET` (10 s au plus
   par appel, aucune redirection suivie) et ne supprime les lignes que sur une réponse 2xx. Au premier
   échec le passage s'arrête et le suivant reprend ; au plus 20 lots (2 000 lignes) par passage. Elle ne
   lève jamais : la collecte ne dépend pas de l'invalidation. Les compteurs sont journalisés (une ligne
   JSON `{"event": "cache_invalidation", "batches", "rows_read", "requests_ok", "requests_failed",
"rows_deleted", …}`) et un échec pose une annotation `::warning title=Invalidate public cache::` dans
   le résumé du workflow.
3. **Site** : `revalidate-sale` expire l'étiquette de la fiche, la fiche, l'étiquette `public-catalogue`
   (première page, cache de données) et la page statique `/sales/defaut`, puis, une fois la réponse
   envoyée, préchauffe les fiches (24 au plus) **et `/sales`** (l'adresse publique, que le proxy réécrit
   vers la page qui vient d'expirer : `/sales/defaut` demandée en direct redirige vers `/sales`).

### À poser par le propriétaire

| Où                                       | Quoi                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GitHub, **variable de dépôt** `SITE_URL` | `https://immojudis.com` (origine publique, sans chemin ; https obligatoire, sinon l'étape saute sans rien envoyer)        |
| GitHub, **secret** `CRON_SECRET`         | la même valeur que `CRON_SECRET` sur Vercel (elle protège déjà les routes cron et `revalidate-sale`)                      |
| Base, migration `20261028100000`         | à appliquer **hors collecte** (verrou court `SHARE ROW EXCLUSIVE` sur `auction_sales`), par « Apply Supabase Migrations » |

Sans `SITE_URL` ou `CRON_SECRET`, l'étape journalise `skipped` et rend la main : les lignes restent dans
la boîte d'envoi et partiront dès que les deux seront posés. Avant la migration, la table n'existe pas :
l'étape journalise l'erreur (`error`) et rend la main. Le secret n'est vu que par cette étape
(`services/data-pipeline/tests/test_workflow_security.py`).

Les workflows manuels qui écrivent dans `auction_sales` (recalcul, balayage de doublons) laissent aussi
leurs lignes dans la boîte d'envoi : la prochaine collecte planifiée les envoie.

### Suivi (lecture seule)

```sql
-- Lignes en attente, et la plus ancienne (attendu : 0 juste après une collecte).
select count(*) as en_attente, min(at) as plus_ancienne
from app_private.catalogue_invalidations;
```

Une ligne qui reste plus de 2 heures signale un site qui répond mal (voir l'annotation du workflow) :
vérifier `SITE_URL`, `CRON_SECRET` (réponse 401) et le déploiement. Pour envoyer à la main une vente :
`curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H "content-type: application/json"
-d '{"saleIds":["<uuid>"]}' https://immojudis.com/api/pipeline/revalidate-sale`.

### Ce que `revalidate-sale` ne peut pas purger : le CDN de l'aperçu et de l'export `.ics`

Les réponses de `/api/catalogue/preview` et de `/api/sales/<id>/calendar` sont gardées par le CDN de
Vercel (`Cache-Control: public, s-maxage=…`). La purge par étiquette (`invalidateByTag` de
`@vercel/functions`, en-tête `Vercel-Cache-Tag`) **n'est pas disponible** : `@vercel/functions` n'est ni
une dépendance du dépôt ni présent dans `node_modules/`, et la documentation de Next.js livrée avec le
dépôt n'en parle pas. Faute de purge, les durées de garde ont été ramenées à **60 s** (elles valaient
300 s pour la première page et l'export, 120 s pour une recherche filtrée), avec
`stale-while-revalidate=60` : une vente retirée disparaît de l'aperçu et de l'export au plus 60 s (puis
une seule réponse périmée de plus, servie pendant le rafraîchissement) après la purge du cache de données.

Pour reprendre la purge par étiquette plus tard : ajouter `@vercel/functions` aux dépendances, poser sur les
deux routes un en-tête `Vercel-Cache-Tag`, appeler `invalidateByTag` dans `revalidate-sale`, puis relever
les durées. À faire après avoir lu la documentation Vercel de la version utilisée (et vérifié le plan).

### Retour arrière

Désactiver l'étape suffit à arrêter l'envoi (les lignes s'accumulent, sans effet sur le site). Pour
retirer le mécanisme : supprimer les déclencheurs `zzzzzz_auction_sales_catalogue_invalidation_update` et
`…_delete` de `public.auction_sales`, puis les fonctions `app_private.queue_catalogue_invalidation()` et
`app_private.auction_sale_columns_are_catalogue_visible(…)`, puis la table
`app_private.catalogue_invalidations`.

## Dates de modification des fiches et date de l'accueil

Le sitemap (`lastmod`) et le JSON-LD (`dateModified`) annonçaient `auction_sales.updated_at`, qui bouge à
chaque passage de la collecte : une date fausse. Depuis le 19/10/2026 :

- **`content_changed_at`** (`20261028100100` colonne, `20261028100200` déclencheur BEFORE UPDATE) : date du
  dernier changement d'un champ **visible** (mise à prix, date de vente, statut, adresse / code postal /
  ville, surface, pièces, photo principale `catalogue_thumbnail_url`). Nulle au départ, nulle tant qu'aucun
  changement n'a été vu, sans rattrapage : « pas de date » se dit par l'absence de date. Il n'existe pas
  de colonne « nombre de photos » (il se lit dans `raw_payload`, que le déclencheur ne relit pas) : la
  photo principale est suivie à la place. Une écriture qui renseigne elle-même la colonne l'emporte.
- **Fonctions publiques** (`20261028100300`) : `list_public_sale_sitemap_entries` et
  `get_public_sale_summary` rendent `content_changed_at` à la place de `updated_at` (la colonne technique
  ne sort plus de la base). Le site n'émet aucune date quand elle est nulle ou absente (base pas encore
  migrée) : l'ordre de déploiement du site et des migrations est sans importance.
- **`/sales`** n'a plus de `lastmod` (aucune date fiable pour une page de classement).
- **Accueil** : « N ventes à venir · **données vérifiées le …** ». La date est celle de la dernière
  collecte réussie, `max(auction_source_state.last_publication_complete_at)` (`20261028100400`,
  `get_public_catalogue_verified_at` : une ligne agrégée, aucune relecture des ventes). Sans la fonction ou
  sans collecte réussie, la ligne n'a pas de date.

Couverture après quelques jours (lecture seule) :

```sql
select count(*) filter (where content_changed_at is not null) as datees, count(*) as total
from public.auction_sales;
```

## Charge : règle de pare-feu Vercel, quotas et journaux du limiteur

Le code borne ce qu'une requête peut coûter ; la règle de pare-feu borne combien de requêtes arrivent.

**Dans le code (déjà posé)**

- `GET /api/catalogue/preview` : `limit` ∈ {24, 50, 100} (tout autre : 400), `minPrice` / `maxPrice` entiers
  de 0 à 100 000 000 € (le navigateur arrondit et plafonne sa saisie avant d'appeler). Une adresse de plus
  ne peut plus ouvrir une entrée de cache par valeur fantaisiste.
- Limiteur par IP (`src/lib/rate-limit.ts`) : une requête **sans adresse exploitable** (jamais le cas
  derrière Vercel) ne partage plus un seau « unknown » avec toutes les autres ; chaque empreinte
  (`user-agent` + `accept-language`) a son seau dédié, au quota très bas de 10 par fenêtre.
- Un échec du limiteur ouvre toujours le service (comportement inchangé), mais il est journalisé en une
  ligne JSON avec les compteurs de l'instance : `{"scope":"rate-limit","event":"ip_limiter_failure",
"outcome":"fail_open","reason":"exception"|"rpc_error","bucket":"…","failures":N,"calls":M,
"unidentified":K,"since":"…"}`. Rechercher `ip_limiter_failure` dans les journaux Vercel (une heure de
  rétention sur le plan Hobby) ; `failures` qui monte d'un appel à l'autre = limiteur durablement en panne,
  donc plus de limite. `ip_unidentified` (première occurrence, puis toutes les 100) signale des requêtes
  sans adresse : à examiner, elles ne devraient pas exister.

**Règle de pare-feu à poser par le propriétaire** (action dans le tableau de bord Vercel, non faite par le
code). Projet → Firewall → Rules → nouvelle règle de limitation de débit :

| Champ           | Valeur proposée                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| Nom             | `catalogue-rate-limit`                                                                               |
| Conditions      | chemin **est** `/sales`, **ou commence par** `/sales/`, **ou commence par** `/api/catalogue/`        |
| Clé de comptage | adresse IP                                                                                           |
| Seuil / fenêtre | 300 requêtes par minute (au-dessus du quota de 180 par minute de l'aperçu, qui reste la limite fine) |
| Action          | refuser (429) ou défi, pour 10 minutes                                                               |

Le seuil est volontairement plus haut que ceux du code : le pare-feu coupe l'abus massif avant qu'il ne
réveille une fonction, le code garde la limite fine. Les robots légitimes font bien moins de 300 requêtes
par minute sur ces chemins. Les noms et options exacts de l'écran, et les quotas de règles, dépendent du
plan Vercel : à vérifier à la création. Après la pose, relancer « Production smoke » (il vérifie que `/sales`
reste servie depuis le cache, sans cookie).
