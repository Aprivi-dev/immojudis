-- Favoris du compte gratuit : de 3 à 10 (décision du propriétaire, 19/10/2026, point 74).
--
-- Le quota vit à un seul endroit par couche : PLAN_LIMITS.decouverte.favoriteSales dans
-- src/lib/plans.ts et app_private.free_favorite_limit() ici (un test Vitest les compare, comme pour
-- monthly_sale_unlock_limit). Le déclencheur reprend le corps de 20261003114434 : propriétaire
-- vérifié, verrou par compte, doublon laissé à la contrainte d'unicité, accès Analyse (abonnement,
-- profil premium ou administrateur, offre de lancement comprise) sans limite. Seuls changent le
-- nombre et le message.
--
-- Des comptes gratuits peuvent déjà avoir 3 favoris ou moins : rien à migrer, la limite monte.
begin;

set local lock_timeout = '5s';

create or replace function app_private.free_favorite_limit()
returns integer
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select 10;
$$;

revoke all on function app_private.free_favorite_limit()
  from public, anon, authenticated;
grant execute on function app_private.free_favorite_limit()
  to authenticated, service_role;

comment on function app_private.free_favorite_limit() is
  'Favoris d''un compte gratuit (sans accès Analyse). Doit être égal à PLAN_LIMITS.decouverte.favoriteSales (src/lib/plans.ts) ; la suite Vitest compare les deux.';

create or replace function app_private.enforce_favorite_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and auth.uid() is distinct from new.user_id then
    raise exception using errcode = '42501', message = 'Favorite owner mismatch.';
  end if;
  if new.user_id is null then
    raise exception using errcode = '23514', message = 'Favorite owner is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user_favorites:' || new.user_id::text, 0)
  );
  -- Existing duplicates must reach the unique constraint, allowing idempotent API retries.
  if exists (
    select 1 from public.user_favorites
    where user_id = new.user_id and sale_id = new.sale_id
  ) then return new; end if;
  if not app_private.has_active_analysis_access(new.user_id)
    and (select count(*) from public.user_favorites where user_id = new.user_id)
      >= app_private.free_favorite_limit() then
    raise exception using errcode = 'P0001', message = 'Quota de 10 favoris gratuits atteint. Retirez un favori pour en ajouter un autre.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.enforce_favorite_quota() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
