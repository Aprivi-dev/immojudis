begin;

-- Some legacy records are quarantined by status before their provenance
-- marker is written. The public preview and direct premium reads must obey
-- either signal; administrators retain the private review path.
create or replace function app_private.auction_sale_is_publicly_visible(
  p_sale_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (
      select coalesce(s.status, 'unknown') <> 'quarantined'
        and coalesce(s.raw_payload->>'publication_quarantine', '') = ''
      from public.auction_sales s
      where s.id = p_sale_id
    ),
    false
  );
$function$;

revoke all on function app_private.auction_sale_is_publicly_visible(uuid)
  from public, anon, authenticated;
grant execute on function app_private.auction_sale_is_publicly_visible(uuid)
  to anon, authenticated, service_role;

alter policy auction_sales_authenticated_read on public.auction_sales
using (
  public.is_admin()
  or (
    public.has_analysis_access()
    and public.catalogue_readiness_allows_premium(
      premium_readiness_status,
      premium_readiness_override,
      premium_readiness_override_expires_at
    )
    and coalesce(status, 'unknown') <> 'quarantined'
    and coalesce(raw_payload->>'publication_quarantine', '') = ''
  )
);

comment on function app_private.auction_sale_is_publicly_visible(uuid) is
  'Returns true only for a sale without a quarantine status or publication marker.';

commit;
