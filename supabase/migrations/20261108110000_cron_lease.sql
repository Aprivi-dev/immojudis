begin;

set local lock_timeout = '5s';

-- Bail nommé des traitements planifiés qui ne doivent pas se chevaucher (chantier W2a, n° 33). Même mécanisme que
-- `sale_flood_risk_lease` (20261106100500, laissé tel quel) : un BAIL stocké, pris par une seule instruction UPDATE (le
-- verrou de ligne sérialise les demandes simultanées), qui expire tout seul si le traitement meurt avant de le rendre.
-- Un verrou consultatif de session ne convient pas : les traitements parlent à la base par appels PostgREST séparés,
-- sans session commune.
--
-- Une ligne par traitement, créée ici : `claim_cron_lease` refuse un nom inconnu (22023), un appelant ne crée donc
-- jamais de ligne. Premier usage : « sale-pepites » (/api/cron/sale-pepites, pg_cron à :35 et filet quotidien de
-- Vercel, qui peuvent se chevaucher). Un traitement de plus = une ligne de plus dans une migration.
--
-- DÉPLOIEMENT : le code fonctionne avant cette migration (fonction absente : le traitement continue sans verrou).
-- RETOUR ARRIÈRE : drop function public.release_cron_lease(text, uuid); drop function
-- public.claim_cron_lease(text, integer); drop table public.cron_lease;

create table if not exists public.cron_lease (
  name text primary key check (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  token uuid,
  claimed_at timestamptz,
  leased_until timestamptz
);

insert into public.cron_lease (name) values ('sale-pepites') on conflict (name) do nothing;

comment on table public.cron_lease is
  'Baux des traitements planifiés : une ligne par traitement. Aucune donnée de vente, aucun contenu personnel.';

alter table public.cron_lease enable row level security;

revoke all on table public.cron_lease from public, anon, authenticated;
grant select, update on table public.cron_lease to service_role;

drop policy if exists cron_lease_service_role on public.cron_lease;
create policy cron_lease_service_role
  on public.cron_lease
  for all to service_role
  using (true)
  with check (true);

create or replace function public.claim_cron_lease(p_name text, p_ttl_seconds integer)
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
  if not exists (select 1 from public.cron_lease where name = p_name) then
    raise exception 'unknown lease' using errcode = '22023';
  end if;
  -- Une seule instruction : deux demandes simultanées se sérialisent sur le verrou de ligne, la seconde relit la
  -- condition après la première et ne trouve plus de bail libre.
  update public.cron_lease
     set token = v_token,
         claimed_at = now(),
         leased_until = now() + make_interval(secs => p_ttl_seconds)
   where name = p_name
     and (leased_until is null or leased_until <= now());
  if not found then
    return null;
  end if;
  return v_token;
end;
$function$;

create or replace function public.release_cron_lease(p_name text, p_token uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  update public.cron_lease
     set token = null,
         leased_until = null
   where name = p_name
     and token is not distinct from p_token
     and p_token is not null;
  return found;
end;
$function$;

revoke all on function public.claim_cron_lease(text, integer) from public, anon, authenticated;
grant execute on function public.claim_cron_lease(text, integer) to service_role;
revoke all on function public.release_cron_lease(text, uuid) from public, anon, authenticated;
grant execute on function public.release_cron_lease(text, uuid) to service_role;

notify pgrst, 'reload schema';

commit;
