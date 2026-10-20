-- Offre de lancement : une réserve du plafond global pour les abonnés et les administrateurs.
--
-- 20261028170100 borne à 150 les actualisations de données créées en 24 heures, tous comptes confondus.
-- Pendant l'offre de lancement, tout compte confirmé a l'accès Analyse : quelqu'un qui confirme
-- beaucoup de comptes peut donc consommer les 150 et laisser les abonnés, les comptes premium et les
-- administrateurs sans actualisation jusqu'au lendemain. Les comptes de l'offre (accès Analyse SANS
-- abonnement, compte premium ni rôle administrateur) ont désormais une part du plafond :
-- 100 demandes sur 24 heures glissantes, comptées dans les 150. Il reste au moins 50 demandes par
-- jour aux autres. Une demande refusée pour cette part répond DATA_REFRESH_LAUNCH_OFFER_DAILY_LIMIT
-- (l'application la rend avec le même message quotidien que le plafond global).
--
-- - app_private.has_standing_analysis_access(uuid) : le droit Analyse HORS offre de lancement
--   (abonnement actif, compte premium, administrateur), c'est-à-dire has_active_analysis_access de
--   20261028170000 sans sa dernière condition. Réutilisée pour le prix d'adjudication des instantanés
--   (20261029110200).
-- - enqueue_data_refresh_bounded : corps de 20261028170100, plus le contrôle de la part de l'offre,
--   appliqué APRÈS le plafond global (une demande refusée par le global garde son message), sous le
--   même verrou global que l'insertion. Les demandes d'abonnés ne sont jamais comptées dans la part
--   de l'offre. La valeur 100 est celle de DATA_REFRESH_LAUNCH_OFFER_DAILY_LIMIT dans
--   src/lib/rate-limit-policies.ts (un test les compare).
--
-- Droits inchangés : exécutable par service_role seul. Les plafonds par compte et par adresse, et la
-- contre-pression globale, sont inchangés.
begin;

set local lock_timeout = '5s';

create or replace function app_private.has_standing_analysis_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  -- Même définition que has_active_analysis_access (20261028170000), sans l'offre de lancement :
  -- ce que le compte a par lui-même, qu'une coupure de l'offre ne lui retire pas.
  select
    p_user_id is not null
    and (
      exists (
        select 1
        from public.user_profiles profile
        where profile.user_id = p_user_id
          and (profile.account_tier = 'premium' or profile.user_role = 'admin')
      )
      or exists (
        select 1
        from public.user_subscriptions subscription
        where subscription.user_id = p_user_id
          and subscription.plan_code = 'analyse'
          and app_private.subscription_grants_access(
            subscription.status,
            subscription.current_period_end
          )
      )
    );
$function$;

revoke all on function app_private.has_standing_analysis_access(uuid)
  from public, anon, authenticated;
grant execute on function app_private.has_standing_analysis_access(uuid) to service_role;

comment on function app_private.has_standing_analysis_access(uuid) is
  'Droit Analyse hors offre de lancement : abonnement actif, compte premium ou administrateur. Ne lit ni l''interrupteur de l''offre ni l''email ; jamais ouverte à anon.';

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
  launch_offer_daily_count integer;
  user_active_limit constant integer := 3;
  user_daily_limit constant integer := 6;
  global_active_limit constant integer := 12;
  global_daily_limit constant integer := 150;
  launch_offer_daily_limit constant integer := 100;
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

  -- Disjoncteur sur le débit total, tous comptes confondus.
  select count(*)::integer
  into global_daily_count
  from public.data_refresh_requests request
  where request.created_at >= statement_timestamp() - interval '24 hours';
  if global_daily_count >= global_daily_limit then
    raise exception using errcode = 'P0001', message = 'DATA_REFRESH_GLOBAL_DAILY_LIMIT';
  end if;

  -- Part de l'offre de lancement : un compte qui n'a que cette offre (ni abonnement, ni compte
  -- premium, ni rôle administrateur) ne peut pas consommer la réserve des autres. Les demandes des
  -- abonnés et des administrateurs ne comptent pas ici.
  if not app_private.has_standing_analysis_access(p_user_id) then
    select count(*)::integer
    into launch_offer_daily_count
    from public.data_refresh_requests request
    where request.created_at >= statement_timestamp() - interval '24 hours'
      and not app_private.has_standing_analysis_access(request.user_id);
    if launch_offer_daily_count >= launch_offer_daily_limit then
      raise exception using errcode = 'P0001', message = 'DATA_REFRESH_LAUNCH_OFFER_DAILY_LIMIT';
    end if;
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
