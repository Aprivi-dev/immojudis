# Supabase Security Advisor triage

Last reviewed: 2026-08-26 on the production project.

This runbook records the advisor findings that cannot be resolved safely with a
mechanical schema change. Re-run the Security Advisor after every database or
Auth deployment and revisit every accepted finding when its boundary changes.

## Fixed controls

- Leaked-password protection is enabled in Supabase Auth. It applies to new
  passwords and password changes; existing password hashes are not reset.
- `public.log_auction_sale_change()` has an empty `search_path` and cannot be
  executed directly by `public`, `anon`, `authenticated`, or `service_role`.
  The trigger remains the only supported invocation path.
- `authenticator` runs `public.enforce_data_api_object_boundary()` before every
  resolved PostgREST request. The invoker-safe hook denies `anon` and
  `authenticated` access to the `spatial_ref_sys` and `st_estimatedextent`
  paths while leaving application and trusted server-side endpoints unchanged.
  The current `st_estimatedextent` overloads have unnamed arguments and are not
  routable by PostgREST; they return `PGRST202`/HTTP 404 before the hook runs.

## Intentional application boundaries

### Discovery view

`public.v_auction_sales_discovery` is intentionally owner-executed and uses a
security barrier. It is the redacted catalogue for authenticated Découverte
users, while base `auction_sales` RLS is restricted to Analyse and admin users.

Do not switch this view to `security_invoker` in place: that would remove the
Découverte catalogue. Do not add a permissive base-table policy either: the
authenticated role has column privileges needed by the premium view, so such a
policy would expose premium fields directly.

The structural replacement is a dedicated redacted projection table with its
own RLS, populated transactionally from `auction_sales`. Until then, preserve
the view's explicit column list, redaction assertions, `security_barrier`, and
`anon` denial.

### Human review RPCs

The following owner-executed functions are intentionally callable only by the
`authenticated` role:

- `public.review_outcome_evidence`
- `public.decide_outcome_claim_eligibility`
- `public.review_judilibre_match_candidate`

Each derives the reviewer from `auth.uid()`, requires a current admin profile,
uses an empty `search_path`, and denies `anon` and `service_role`. Keeping the
human JWT is required for reviewer attribution. Preserve pgTAP coverage for the
ACLs, ordinary-user rejection, admin success, and stamped reviewer identity.

## Supabase-managed extension boundaries

Production owns PostGIS and `pg_net` objects through `supabase_admin`; the
application migration role is not a member of that role. Both installed
extensions report `extrelocatable = false`. Consequently:

- `public.spatial_ref_sys` RLS and ACL changes require the Supabase-managed
  owner path. The table contains CRS metadata, not application records.
- PostGIS cannot be moved out of `public` without a coordinated extension
  rebuild and migration of geography types, generated columns, functions, and
  GiST indexes.
- `pg_net` placement is platform-selected. Its `net` schema is not an exposed
  Data API schema, and application network calls remain inside private cron
  functions.

The Dashboard can stage removals for `public.spatial_ref_sys` and
`public.st_estimatedextent`, but the hosted platform does not persist them:
both objects are owned by the non-inheritable `supabase_admin` role. Their
Advisor findings therefore remain platform-owned. The PostgREST pre-request
hook is the application-controlled compensating boundary; recheck its live 403
responses after PostGIS or platform upgrades.

## Verification checklist

1. Run `npm run check:migrations` and `npm run test:security-invariants`.
2. Reset the local Supabase stack and run `supabase test db` when Docker is
   available.
3. Run `npm run check:schema-drift -- --remote` after production migration.
4. Confirm Auth reports leaked-password protection enabled.
5. Confirm the Data API exposes only `public` and `graphql_public`, never
   `app_private` or `net`.
6. Confirm `authenticator` has
   `pgrst.db_pre_request=public.enforce_data_api_object_boundary`, then verify
   an anonymous REST request to `spatial_ref_sys` returns SQLSTATE `42501`
   (HTTP 401 for `anon`; HTTP 403 for an authenticated JWT), and
   `rpc/st_estimatedextent` remains unroutable with `PGRST202`/HTTP 404. The
   pgTAP test also simulates the authenticated hook path so a future PostGIS
   signature change remains denied.
7. Re-run Supabase Security Advisor and reconcile every ERROR/WARN with this
   file rather than dismissing new findings by name alone.
