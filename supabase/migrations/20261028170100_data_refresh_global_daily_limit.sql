-- Actualisations de données à la demande : plafond global sur 24 heures.
--
-- enqueue_data_refresh_bounded (20260727180623_phase_2_security_boundaries.sql) borne déjà, par compte,
-- 3 demandes en cours et 6 par 24 heures, et, pour tout le site, 12 demandes en cours (contre-pression).
-- Aucun de ces plafonds ne borne le DÉBIT total : pendant l'offre de lancement, tout compte confirmé a
-- l'accès Analyse, donc N comptes font N fois 6 demandes par jour, chacune mettant en file un travail
-- du pipeline qui interroge un site source. Un plafond global sur 24 heures glissantes sert de
-- disjoncteur, appliqué dans la même transaction (et sous le même verrou global) que l'insertion.
--
-- Le corps de la fonction reprend exactement celui de 20260727180623, avec un contrôle de plus
-- (DATA_REFRESH_GLOBAL_DAILY_LIMIT, appliqué après les plafonds par compte : un compte déjà au plafond
-- n'a rien à y faire). La valeur 150 est celle de DATA_REFRESH_GLOBAL_DAILY_LIMIT dans
-- src/lib/rate-limit-policies.ts (un test les compare) : très au-dessus de l'usage d'un site en
-- pré-lancement, très en dessous de ce que produirait un abus. Les demandes réutilisées (même
-- compte, même source, même type déjà en cours) ne créent pas de ligne et ne comptent pas.
--
-- Droits inchangés : exécutable par service_role seul.
begin;

set local lock_timeout = '5s';

create index if not exists data_refresh_requests_created_idx
  on public.data_refresh_requests (created_at);

create or replace function public.enqueue_data_refresh_bounded(
  p_user_id uuid,
  p_sale_id uuid,
  p_request_kind text,
  p_force boolean default false
)
returns table (request_id uuid, reused boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_value text;
  existing_id uuid;
  created_id uuid;
  user_active_count integer;
  user_daily_count integer;
  global_active_count integer;
  global_daily_count integer;
  user_active_limit constant integer := 3;
  user_daily_limit constant integer := 6;
  global_active_limit constant integer := 12;
  global_daily_limit constant integer := 150;
begin
  if p_user_id is null or p_sale_id is null then
    raise exception using errcode = '22023', message = 'Refresh user and sale are required.';
  end if;
  if p_request_kind not in ('cadastre', 'dpe', 'full') then
    raise exception using errcode = '22023', message = 'Invalid refresh kind.';
  end if;
  if not app_private.has_active_analysis_access(p_user_id) then
    raise exception using errcode = '42501', message = 'Analyse access is required.';
  end if;

  select sale.source_url
  into source_value
  from public.auction_sales sale
  where sale.id = p_sale_id;
  if source_value is null then
    raise exception using errcode = 'P0002', message = 'Refreshable sale not found.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('data-refresh:global', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('data-refresh:user:' || p_user_id::text, 0)
  );

  select request.id
  into existing_id
  from public.data_refresh_requests request
  where request.user_id = p_user_id
    and request.source_url = source_value
    and request.request_kind = p_request_kind
    and request.status in ('queued', 'running')
  order by request.created_at desc
  limit 1;
  if existing_id is not null then
    return query select existing_id, true;
    return;
  end if;

  select count(*)::integer
  into user_active_count
  from public.data_refresh_requests request
  where request.user_id = p_user_id
    and request.status in ('queued', 'running');
  if user_active_count >= user_active_limit then
    raise exception using errcode = 'P0001', message = 'DATA_REFRESH_USER_ACTIVE_LIMIT';
  end if;

  select count(*)::integer
  into user_daily_count
  from public.data_refresh_requests request
  where request.user_id = p_user_id
    and request.created_at >= statement_timestamp() - interval '24 hours';
  if user_daily_count >= user_daily_limit then
    raise exception using errcode = 'P0001', message = 'DATA_REFRESH_USER_DAILY_LIMIT';
  end if;

  select count(*)::integer
  into global_active_count
  from public.data_refresh_requests request
  where request.status in ('queued', 'running');
  if global_active_count >= global_active_limit then
    raise exception using errcode = 'P0001', message = 'DATA_REFRESH_GLOBAL_BACKPRESSURE';
  end if;

  -- Disjoncteur sur le débit total, tous comptes confondus (offre de lancement : N comptes
  -- confirmés = N fois le plafond par compte).
  select count(*)::integer
  into global_daily_count
  from public.data_refresh_requests request
  where request.created_at >= statement_timestamp() - interval '24 hours';
  if global_daily_count >= global_daily_limit then
    raise exception using errcode = 'P0001', message = 'DATA_REFRESH_GLOBAL_DAILY_LIMIT';
  end if;

  insert into public.data_refresh_requests (
    user_id,
    sale_id,
    source_url,
    request_kind,
    requested_payload,
    priority
  ) values (
    p_user_id,
    p_sale_id,
    source_value,
    p_request_kind,
    pg_catalog.jsonb_build_object('force', coalesce(p_force, false), 'requested_from', 'app'),
    case when p_request_kind = 'full' then 70 else 60 end
  )
  returning id into created_id;

  return query select created_id, false;
end;
$$;

revoke all on function public.enqueue_data_refresh_bounded(uuid, uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_data_refresh_bounded(uuid, uuid, text, boolean)
  to service_role;

commit;
