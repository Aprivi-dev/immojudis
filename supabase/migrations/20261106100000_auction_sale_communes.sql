begin;

set local lock_timeout = '5s';

-- Code commune de chaque vente (pépite v2, compte-rendu docs/equipe/2026-10-26-pepite-v2-inondation-loyers.md,
-- proposition n° 2). Jusqu'ici le code INSEE n'était pas stocké sur la vente : il était résolu au rendu, et les
-- arrondissements (751xx, 132xx, 693xx) ne se joignaient pas aux profils GASPAR, qui sont indexés sur la commune
-- (75056, 13055, 69123).
--
-- POURQUOI UNE TABLE LIÉE ET PAS UNE COLONNE DE auction_sales : ajouter une colonne à la collecte aurait obligé le
-- pipeline à l'écrire (UPSERT_COLUMNS) avant que la migration soit appliquée en production, et la remplir sur les
-- ventes existantes aurait réécrit toutes les lignes de auction_sales (une vingtaine de déclencheurs : projection du
-- catalogue, invalidations, date de contenu, rétention…). Une table liée se remplit sans toucher à une seule ligne de
-- la vente ; la colonne `location` et les autres colonnes internes de auction_sales ne sont pas concernées, et
-- l'invariant `auction-sales-column-grants` (aucune colonne interne ouverte à authenticated) reste vrai : aucune
-- colonne n'est ajoutée à auction_sales, aucune vue v_auction_sales_* ne change.
--
-- ALIMENTATION :
--   * le pipeline pose `raw_payload.commune` ({insee, arrondissement_insee, source}) à chaque géocodage
--     (services/data-pipeline/src/commune_insee.py) : d'abord le code commune du résultat BAN accepté
--     (raw_payload.geocode.citycode), à défaut la commune retrouvée par code postal et nom (reference_communes) ;
--   * le traitement planifié /api/cron/sale-flood-risk recopie ce code ici (src/lib/sale-communes-sync.server.ts) ;
--   * le remplissage initial des ventes existantes est la migration suivante (20261106100100), en SQL pur.
--
-- DEUX CODES : `commune_insee` est celui de la COMMUNE (75056 pour le 8e arrondissement de Paris) : c'est lui que
-- GASPAR (Géorisques) comprend ; `arrondissement_insee` garde l'arrondissement (75108), dont les loyers ANIL ont
-- besoin. `arrondissement_insee` est nul hors Paris, Lyon et Marseille.
--
-- DROITS : table privée, comme auction_sale_pepites (20261104100000) : aucun droit pour anon ni authenticated,
-- lecture et écriture par le rôle de service. La table suit la vente : suppression en cascade avec elle
-- (public.purge_expired_auction_sales supprime la vente, donc cette ligne).
--
-- RETOUR ARRIÈRE (à passer par une migration de retour arrière revue) : drop table public.auction_sale_communes,
-- après avoir retiré les lectures de src/lib/flood-risk-store.server.ts (le traitement se termine alors proprement :
-- skipped "not_migrated").

create table if not exists public.auction_sale_communes (
  sale_id uuid primary key references public.auction_sales(id) on delete cascade,
  commune_insee text not null check (commune_insee ~ '^[0-9][0-9AB][0-9]{3}$'),
  arrondissement_insee text,
  source text not null check (source in ('geocode', 'reference_communes')),
  resolved_at timestamptz not null default now(),
  -- Un arrondissement n'existe que pour Paris, Lyon et Marseille, et se rattache à SA commune.
  constraint auction_sale_communes_arrondissement_check check (
    arrondissement_insee is null
    or (commune_insee = '75056' and arrondissement_insee ~ '^751(0[1-9]|1[0-9]|20)$')
    or (commune_insee = '13055' and arrondissement_insee ~ '^132(0[1-9]|1[0-6])$')
    or (commune_insee = '69123' and arrondissement_insee ~ '^6938[1-9]$')
  )
);

comment on table public.auction_sale_communes is
  'Code commune de chaque vente (alimenté par le pipeline : raw_payload.commune ; remplissage initial : migration 20261106100100). Privé : aucun droit pour anon ni authenticated. Supprimé avec la vente.';
comment on column public.auction_sale_communes.commune_insee is
  'Code INSEE de la commune au sens de GASPAR : les arrondissements de Paris, Lyon et Marseille sont ramenés à 75056, 69123 et 13055.';
comment on column public.auction_sale_communes.arrondissement_insee is
  'Code de l''arrondissement (751xx, 132xx, 693xx) quand la vente en a un ; nul sinon. Gardé à part pour les loyers ANIL, qui sont publiés par arrondissement.';
comment on column public.auction_sale_communes.source is
  'D''où vient le code : geocode (résultat BAN accepté, raw_payload.geocode.citycode) ou reference_communes (repli par code postal et nom de commune).';
comment on column public.auction_sale_communes.resolved_at is
  'Date à laquelle le code a été posé ou modifié.';

alter table public.auction_sale_communes enable row level security;

revoke all on table public.auction_sale_communes from public, anon, authenticated;
grant select, insert, update on table public.auction_sale_communes to service_role;

drop policy if exists auction_sale_communes_service_role on public.auction_sale_communes;
create policy auction_sale_communes_service_role
  on public.auction_sale_communes
  for all to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';

commit;
