begin;

-- Public visitors may only read a minimal teaser used by /sales before login.
-- Full sale details, documents, risks, scoring evidence and map data require
-- the authenticated role.

create or replace view public.v_auction_sales_app_preview
with (security_invoker = true)
as
select
  s.id,
  s.starting_price_eur
from public.auction_sales s;

alter table public.auction_sales enable row level security;
alter table public.auction_features enable row level security;
alter table public.auction_surfaces enable row level security;
alter table public.auction_risks enable row level security;
alter table public.auction_documents enable row level security;
alter table public.auction_risk_occurrences enable row level security;
alter table public.auction_score_factors enable row level security;
alter table public.auction_scoring_versions enable row level security;
alter table public.tribunals enable row level security;

revoke all on table public.v_auction_sales_app from anon;
revoke all on table public.v_auction_map_pins from anon;
revoke all on table public.public_auction_sales from anon;
revoke all on table public.auction_sales_quality_issues from anon;
revoke all on table public.auction_sales_investment_candidates from anon;
revoke all on table public.auction_source_coverage from anon;

revoke all on table public.auction_sales from anon;
revoke all on table public.auction_features from anon;
revoke all on table public.auction_surfaces from anon;
revoke all on table public.auction_risks from anon;
revoke all on table public.auction_documents from anon;
revoke all on table public.auction_risk_occurrences from anon;
revoke all on table public.auction_score_factors from anon;
revoke all on table public.auction_scoring_versions from anon;
revoke all on table public.tribunals from anon;

revoke all on table public.v_auction_sales_app_preview from anon, authenticated;

grant select on table public.v_auction_sales_app to authenticated;
grant select on table public.v_auction_map_pins to authenticated;
grant select on table public.public_auction_sales to authenticated;
grant select on table public.auction_sales_quality_issues to authenticated;
grant select on table public.auction_sales_investment_candidates to authenticated;
grant select on table public.auction_source_coverage to authenticated;

grant select on table public.auction_sales to authenticated;
grant select on table public.auction_features to authenticated;
grant select on table public.auction_surfaces to authenticated;
grant select on table public.auction_risks to authenticated;
grant select on table public.auction_documents to authenticated;
grant select on table public.auction_risk_occurrences to authenticated;
grant select on table public.auction_score_factors to authenticated;
grant select on table public.auction_scoring_versions to authenticated;
grant select on table public.tribunals to authenticated;

grant select (id, starting_price_eur) on table public.auction_sales to anon;
grant select on table public.v_auction_sales_app_preview to anon, authenticated;

drop policy if exists auction_sales_public_read on public.auction_sales;
drop policy if exists auction_sales_public_preview_read on public.auction_sales;
drop policy if exists auction_sales_authenticated_read on public.auction_sales;
create policy auction_sales_public_preview_read
on public.auction_sales for select
to anon
using (
  coalesce(status, 'unknown') in ('upcoming', 'unknown')
  and latitude is not null
  and longitude is not null
);
create policy auction_sales_authenticated_read
on public.auction_sales for select
to authenticated
using (true);

drop policy if exists auction_features_public_read on public.auction_features;
drop policy if exists auction_features_authenticated_read on public.auction_features;
create policy auction_features_authenticated_read
on public.auction_features for select
to authenticated
using (true);

drop policy if exists auction_surfaces_public_read on public.auction_surfaces;
drop policy if exists auction_surfaces_authenticated_read on public.auction_surfaces;
create policy auction_surfaces_authenticated_read
on public.auction_surfaces for select
to authenticated
using (true);

drop policy if exists auction_risks_public_read on public.auction_risks;
drop policy if exists auction_risks_authenticated_read on public.auction_risks;
create policy auction_risks_authenticated_read
on public.auction_risks for select
to authenticated
using (true);

drop policy if exists auction_documents_public_read on public.auction_documents;
drop policy if exists auction_documents_authenticated_read on public.auction_documents;
create policy auction_documents_authenticated_read
on public.auction_documents for select
to authenticated
using (true);

drop policy if exists auction_risk_occurrences_public_read on public.auction_risk_occurrences;
drop policy if exists auction_risk_occurrences_authenticated_read on public.auction_risk_occurrences;
create policy auction_risk_occurrences_authenticated_read
on public.auction_risk_occurrences for select
to authenticated
using (true);

drop policy if exists auction_score_factors_public_read on public.auction_score_factors;
drop policy if exists auction_score_factors_authenticated_read on public.auction_score_factors;
create policy auction_score_factors_authenticated_read
on public.auction_score_factors for select
to authenticated
using (true);

drop policy if exists auction_scoring_versions_public_read on public.auction_scoring_versions;
drop policy if exists auction_scoring_versions_authenticated_read on public.auction_scoring_versions;
create policy auction_scoring_versions_authenticated_read
on public.auction_scoring_versions for select
to authenticated
using (true);

drop policy if exists tribunals_public_read on public.tribunals;
drop policy if exists tribunals_authenticated_read on public.tribunals;
create policy tribunals_authenticated_read
on public.tribunals for select
to authenticated
using (true);

notify pgrst, 'reload schema';

commit;
