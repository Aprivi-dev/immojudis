begin;

set local lock_timeout = '5s';

-- Verrou du traitement d'inondation (/api/cron/sale-flood-risk). Deux passes simultanées (le planificateur de la base
-- à :25 et le filet quotidien de Vercel, ou un rejeu manuel) doublent les appels aux services de l'État et dépassent
-- la cadence demandée. Un verrou consultatif de session (pg_try_advisory_lock) ne convient pas ici : le traitement
-- parle à la base par des appels HTTP séparés (PostgREST), qui n'ont pas de session commune, donc un verrou de
-- session serait perdu ou orphelin. On suit le modèle de claim_autonomous_pipeline_run (20260912112441) : un BAIL
-- stocké, pris par une seule instruction UPDATE (le verrou de ligne sérialise les demandes simultanées), qui expire
-- tout seul si le traitement meurt avant de le rendre.
--
-- Une seule ligne (id = true). claim_sale_flood_risk_lease(p_ttl_seconds) rend un jeton si le bail est libre ou
-- expiré, NULL sinon ; release_sale_flood_risk_lease(p_token) le rend (sans effet si le bail a été repris).
--
-- DÉPLOIEMENT : le code fonctionne avant cette migration (fonction absente : le traitement continue sans verrou).
-- RETOUR ARRIÈRE : drop function public.release_sale_flood_risk_lease(uuid); drop function
-- public.claim_sale_flood_risk_lease(integer); drop table public.sale_flood_risk_lease;

create table if not exists public.sale_flood_risk_lease (
  id boolean primary key default true check (id),
  token uuid,
  claimed_at timestamptz,
  leased_until timestamptz
);

insert into public.sale_flood_risk_lease (id) values (true) on conflict (id) do nothing;

comment on table public.sale_flood_risk_lease is
  'Bail du traitement d''inondation : une seule ligne. Aucune donnée de vente, aucun contenu personnel.';

alter table public.sale_flood_risk_lease enable row level security;

revoke all on table public.sale_flood_risk_lease from public, anon, authenticated;
grant select, update on table public.sale_flood_risk_lease to service_role;

drop policy if exists sale_flood_risk_lease_service_role on public.sale_flood_risk_lease;
create policy sale_flood_risk_lease_service_role
  on public.sale_flood_risk_lease
  for all to service_role
  using (true)
  with check (true);

create or replace function public.claim_sale_flood_risk_lease(p_ttl_seconds integer)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_token uuid := gen_random_uuid();
begin
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 1800 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;
  -- Une seule instruction : deux demandes simultanées se sérialisent sur le verrou de ligne, la seconde relit la
  -- condition après la première et ne trouve plus de bail libre.
  update public.sale_flood_risk_lease
     set token = v_token,
         claimed_at = now(),
         leased_until = now() + make_interval(secs => p_ttl_seconds)
   where id
     and (leased_until is null or leased_until <= now());
  if not found then
    return null;
  end if;
  return v_token;
end;
$function$;

create or replace function public.release_sale_flood_risk_lease(p_token uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  update public.sale_flood_risk_lease
     set token = null,
         leased_until = null
   where id
     and token is not distinct from p_token
     and p_token is not null;
  return found;
end;
$function$;

revoke all on function public.claim_sale_flood_risk_lease(integer) from public, anon, authenticated;
grant execute on function public.claim_sale_flood_risk_lease(integer) to service_role;
revoke all on function public.release_sale_flood_risk_lease(uuid) from public, anon, authenticated;
grant execute on function public.release_sale_flood_risk_lease(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
