-- Relevé mensuel des avocats référencés (point 72) : pour un mois civil, trois nombres par avocat,
-- destinés à être envoyés à la main par le propriétaire (aucun envoi automatique).
--
-- Lue par le serveur Next.js (service_role) après le contrôle du rôle administrateur et de la double
-- authentification (route /api/admin/lawyers/statement), comme admin_pilotage_summary. SECURITY
-- DEFINER parce que les tables sources sont fermées aux rôles du navigateur ; elle ne rend que des
-- nombres et l'identité professionnelle de l'avocat (nom affiché, cabinet) : jamais une donnée
-- d'acquéreur ni de compte (ni requester_id, ni requester_email, ni message, ni téléphone).
--
-- Mois civil : de minuit, heure de Paris, le 1er du mois (inclus) à minuit le 1er du mois suivant
-- (exclu). Le jour passé en argument n'a pas d'importance, seul le mois compte.
--
-- Les trois nombres, tels que les tables les enregistrent :
--   * impressions : lignes de lawyer_placement_events (event_type = 'impression') du mois. Le serveur
--     n'en enregistre qu'une par compte connecté, par emplacement et par jour (voir
--     src/lib/lawyer-placement-events.ts) : ce ne sont pas des pages vues brutes ;
--   * cta_clicks : même table, event_type = 'cta_click', même règle ;
--   * referral_requests_sent : demandes de mise en relation attribuées à l'avocat
--     (requested_lawyer_id) et transmises à lui dans le mois (sent_at dans le mois, quel que soit le
--     statut ultérieur). Une demande reçue un mois et transmise le suivant compte le mois suivant.
-- Sont listés les avocats dont la fiche est active et ceux qui ont au moins un chiffre non nul dans
-- le mois (fiche passée en pause ou archivée depuis).
begin;

set local lock_timeout = '5s';

create or replace function public.admin_lawyer_monthly_statement(p_month date)
returns table (
  lawyer_id uuid,
  display_name text,
  firm_name text,
  impressions bigint,
  cta_clicks bigint,
  referral_requests_sent bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_first date;
  v_start timestamptz;
  v_end timestamptz;
begin
  if p_month is null then
    raise exception using errcode = '22023', message = 'The statement month is required.';
  end if;

  v_first := pg_catalog.make_date(
    pg_catalog.date_part('year', p_month)::integer,
    pg_catalog.date_part('month', p_month)::integer,
    1
  );
  v_start := v_first::timestamp at time zone 'Europe/Paris';
  v_end := (v_first + interval '1 month')::timestamp at time zone 'Europe/Paris';

  return query
  with placement as (
    select
      event_row.lawyer_id as lid,
      pg_catalog.count(*) filter (where event_row.event_type = 'impression') as shown,
      pg_catalog.count(*) filter (where event_row.event_type = 'cta_click') as clicked
    from public.lawyer_placement_events event_row
    where event_row.created_at >= v_start and event_row.created_at < v_end
    group by event_row.lawyer_id
  ),
  referral as (
    select
      request_row.requested_lawyer_id as lid,
      pg_catalog.count(*) as sent
    from public.lawyer_referral_requests request_row
    where request_row.requested_lawyer_id is not null
      and request_row.sent_at >= v_start and request_row.sent_at < v_end
    group by request_row.requested_lawyer_id
  )
  select
    lawyer.id,
    lawyer.display_name,
    lawyer.firm_name,
    coalesce(placement.shown, 0)::bigint,
    coalesce(placement.clicked, 0)::bigint,
    coalesce(referral.sent, 0)::bigint
  from public.referenced_lawyers lawyer
  left join placement on placement.lid = lawyer.id
  left join referral on referral.lid = lawyer.id
  where lawyer.status = 'active'
    or coalesce(placement.shown, 0) > 0
    or coalesce(placement.clicked, 0) > 0
    or coalesce(referral.sent, 0) > 0
  order by lawyer.display_name, lawyer.id;
end;
$$;

revoke all on function public.admin_lawyer_monthly_statement(date)
  from public, anon, authenticated;
grant execute on function public.admin_lawyer_monthly_statement(date) to service_role;

comment on function public.admin_lawyer_monthly_statement(date) is
  'Relevé mensuel par avocat référencé (affichages, clics, demandes transmises) pour le mois civil de p_month, heure de Paris. service_role seul : le serveur contrôle le rôle administrateur. Nombres seulement, aucune donnée d''acquéreur.';

notify pgrst, 'reload schema';

commit;
