begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2a, étape A5 (plan du 11/11/2026, section 10 ; annexe 08, point 10, RPC).
--
-- public.set_auction_sale_readiness_override et public.clear_auction_sale_readiness_override (20260919123000)
-- faisaient « returning * » et rendaient la ligne ENTIÈRE de public.auction_sales à l'appelant. Elles sont
-- SECURITY DEFINER et exécutables par authenticated (réservées aux administrateurs par public.is_admin()) : la
-- colonne interne held_fields, raw_payload et toute colonne ajoutée plus tard sortaient donc par l'API, sans
-- passer par les droits par colonne de la table. Elles rendent désormais un objet JSON de six clés : id et les
-- cinq colonnes de la dérogation (premium_readiness_override, _reason, _by, _at, _expires_at).
--
-- Mêmes arguments, mêmes contrôles, mêmes droits, mêmes erreurs. Le type de retour d'une fonction ne se change
-- pas par « create or replace » : chaque fonction est supprimée puis recréée dans cette transaction, seulement si
-- elle rend encore la ligne (une seconde application ne supprime rien). L'application ne lit que l'erreur de ces
-- deux appels (src/lib/admin-catalogue-readiness.ts) : l'ordre de déploiement entre le code et cette migration
-- est indifférent.
--
-- Verrous : aucun sur les tables. Possible pendant un import.
--
-- Retour arrière : rétablir les deux définitions de 20260919123000_premium_catalogue_readiness.sql (drop function
-- puis create function, avec leurs revoke et grant).

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_proc routine
    where routine.oid = pg_catalog.to_regprocedure(
        'public.set_auction_sale_readiness_override(uuid,text,text,timestamp with time zone)')
      and routine.prorettype <> 'jsonb'::regtype
  ) then
    drop function public.set_auction_sale_readiness_override(uuid, text, text, timestamptz);
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc routine
    where routine.oid = pg_catalog.to_regprocedure('public.clear_auction_sale_readiness_override(uuid)')
      and routine.prorettype <> 'jsonb'::regtype
  ) then
    drop function public.clear_auction_sale_readiness_override(uuid);
  end if;
end;
$$;

create or replace function public.set_auction_sale_readiness_override(
  p_sale_id uuid,
  p_decision text,
  p_reason text,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  if p_decision not in ('hold','publish') then
    raise exception using errcode = '22023', message = 'Invalid readiness override.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 8 and 2000 then
    raise exception using errcode = '22023', message = 'A meaningful override reason is required.';
  end if;

  update public.auction_sales sale
  set premium_readiness_override = p_decision,
      premium_readiness_override_reason = btrim(p_reason),
      premium_readiness_override_by = (select auth.uid()),
      premium_readiness_override_at = statement_timestamp(),
      premium_readiness_override_expires_at = p_expires_at
  where sale.id = p_sale_id
  returning jsonb_build_object(
    'id', sale.id,
    'premium_readiness_override', sale.premium_readiness_override,
    'premium_readiness_override_reason', sale.premium_readiness_override_reason,
    'premium_readiness_override_by', sale.premium_readiness_override_by,
    'premium_readiness_override_at', sale.premium_readiness_override_at,
    'premium_readiness_override_expires_at', sale.premium_readiness_override_expires_at
  ) into result;
  if result is null then
    raise exception using errcode = 'P0002', message = 'Sale not found.';
  end if;
  return result;
end;
$$;

revoke all on function public.set_auction_sale_readiness_override(uuid,text,text,timestamptz)
  from public, anon;
grant execute on function public.set_auction_sale_readiness_override(uuid,text,text,timestamptz)
  to authenticated, service_role;

comment on function public.set_auction_sale_readiness_override(uuid,text,text,timestamptz) is
  'Pose une dérogation de complétude sur une vente (administrateur seulement). Rend id et les cinq colonnes de la dérogation, jamais la ligne entière de auction_sales.';

create or replace function public.clear_auction_sale_readiness_override(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  update public.auction_sales sale
  set premium_readiness_override = null,
      premium_readiness_override_reason = null,
      premium_readiness_override_by = null,
      premium_readiness_override_at = null,
      premium_readiness_override_expires_at = null
  where sale.id = p_sale_id
  returning jsonb_build_object(
    'id', sale.id,
    'premium_readiness_override', sale.premium_readiness_override,
    'premium_readiness_override_reason', sale.premium_readiness_override_reason,
    'premium_readiness_override_by', sale.premium_readiness_override_by,
    'premium_readiness_override_at', sale.premium_readiness_override_at,
    'premium_readiness_override_expires_at', sale.premium_readiness_override_expires_at
  ) into result;
  if result is null then
    raise exception using errcode = 'P0002', message = 'Sale not found.';
  end if;
  return result;
end;
$$;

revoke all on function public.clear_auction_sale_readiness_override(uuid) from public, anon;
grant execute on function public.clear_auction_sale_readiness_override(uuid)
  to authenticated, service_role;

comment on function public.clear_auction_sale_readiness_override(uuid) is
  'Retire la dérogation de complétude d''une vente (administrateur seulement). Rend id et les cinq colonnes de la dérogation, jamais la ligne entière de auction_sales.';

notify pgrst, 'reload schema';

commit;
