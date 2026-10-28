begin;

set local lock_timeout = '5s';

-- Repli départemental calculé sur la carte de l'ANIL (compte-rendu du 27/10/2026, proposition n° 47).
--
-- POURQUOI : le repli de src/lib/rent-reference.ts ne couvre que 24 départements (table codée en dur) : la Corse, les
-- départements d'outre-mer et la plupart des départements ruraux n'avaient « Loyer de référence indisponible » dès
-- que la commune n'avait pas de ligne ANIL. Chaque ligne d'anil_rents porte déjà son département : la médiane par
-- département et par segment s'en déduit, et sert de repli AVANT la table codée en dur (marquée « indicative »,
-- avec le millésime de la carte).
--
-- Une fonction plutôt qu'une vue : la table anil_rents reste fermée à l'API de données, la fonction est réservée
-- au rôle de service, et rien d'autre n'est exposé. L'index sert la lecture par département.
--
-- RETOUR ARRIÈRE : drop function public.anil_department_medians(text[]) et drop index anil_rents_department_segment_idx
-- (la lecture traite « fonction absente » comme « aucun repli calculé »).

create index if not exists anil_rents_department_segment_idx
  on public.anil_rents (department_code, segment);

create or replace function public.anil_department_medians(p_departments text[])
returns table (
  department_code text,
  segment text,
  rent_per_m2 numeric,
  communes integer,
  vintage smallint,
  source_updated_on date
)
language sql
stable
set search_path = ''
as $function$
  select
    r.department_code,
    r.segment,
    (pg_catalog.percentile_cont(0.5) within group (order by r.rent_per_m2))::numeric(8, 4) as rent_per_m2,
    pg_catalog.count(*)::integer as communes,
    pg_catalog.max(r.vintage) as vintage,
    pg_catalog.max(r.source_updated_on) as source_updated_on
  from public.anil_rents r
  where r.department_code = any (
    case when pg_catalog.cardinality(p_departments) <= 110 then p_departments else '{}'::text[] end
  )
  group by r.department_code, r.segment
  order by r.department_code, r.segment;
$function$;

revoke all on function public.anil_department_medians(text[]) from public, anon, authenticated;
grant execute on function public.anil_department_medians(text[]) to service_role;

comment on function public.anil_department_medians(text[]) is
  'Médiane des loyers ANIL par département et par segment (110 départements au plus par appel), pour le repli départemental calculé. Réservée au rôle de service.';

notify pgrst, 'reload schema';

commit;
