begin;

-- PostGIS is installed and owned by Supabase's non-inheritable
-- `supabase_admin` role. The project migration role therefore cannot revoke
-- the extension's default grants on spatial_ref_sys or st_estimatedextent.
-- Enforce the intended boundary at PostgREST's per-request hook instead.
create or replace function public.enforce_data_api_object_boundary()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  request_path text := btrim(
    coalesce(current_setting('request.path', true), ''),
    '/'
  );
begin
  if current_user in ('anon', 'authenticated')
    and request_path in (
      'spatial_ref_sys',
      'rest/v1/spatial_ref_sys',
      'rpc/st_estimatedextent',
      'rest/v1/rpc/st_estimatedextent'
    )
  then
    raise insufficient_privilege using
      message = 'Data API access denied for Supabase-managed PostGIS object';
  end if;
end;
$$;

revoke all on function public.enforce_data_api_object_boundary()
from public;

grant execute on function public.enforce_data_api_object_boundary()
to anon, authenticated, service_role;

comment on function public.enforce_data_api_object_boundary() is
  'PostgREST pre-request guard that denies anon/authenticated access to Supabase-managed PostGIS objects whose platform ACLs cannot be changed by the project role.';

alter role authenticator
  set pgrst.db_pre_request = 'public.enforce_data_api_object_boundary';

notify pgrst, 'reload config';

commit;
