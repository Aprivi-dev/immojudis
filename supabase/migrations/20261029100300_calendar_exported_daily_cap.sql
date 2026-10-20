begin;

set local lock_timeout = '5s';

-- calendar_exported : plafond par compte et par jour (point 54 de la session du 20/10/2026, chantier W1).
--
-- Constat : la route POST /api/sales/[id]/calendar/exported accepte n'importe quel UUID de vente d'un compte
-- connecté, 30 appels par minute : jusqu'à environ 43 000 lignes par jour et par compte (une par vente
-- distincte, l'unicité quotidienne ne protège que d'un même couple compte / vente). La route vérifie
-- désormais que la vente est publiquement visible (src/app/api/sales/[id]/calendar/exported/route.ts).
--
-- Plafond en SQL, dans record_account_product_event, plutôt que dans la route : le décompte et l'insertion
-- sont dans la même fonction (un seul aller-retour, aucun autre appelant ne contourne la limite), et la
-- règle suit l'unicité quotidienne, qui est elle aussi en SQL. Au plus 50 événements calendar_exported
-- distincts (donc 50 ventes) par compte et par jour UTC, le jour de l'unicité quotidienne ; au-delà, la
-- fonction rend faux, comme pour un événement déjà enregistré. Deux appels simultanés peuvent dépasser le
-- plafond de quelques lignes : il borne un volume, il ne protège pas un invariant. Les autres types
-- d'événement ne sont pas plafonnés ici (quota_reached est unique par jour et détail ; les déblocages sont
-- bornés par le quota d'offre).
--
-- Même corps que 20261029100000 (vente requise sauf pour un quota atteint), plus le plafond. L'index
-- (compte, type, heure) sert le décompte.
create index if not exists account_product_events_user_type_time_idx
  on public.account_product_events (user_id, event_type, occurred_at desc);

create or replace function public.record_account_product_event(
  p_user_id uuid,
  p_event_type text,
  p_detail text default null,
  p_sale_id uuid default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inserted integer;
  v_day_start timestamptz;
begin
  if p_user_id is null then
    raise exception using errcode = '22004', message = 'Account is required.';
  end if;
  if p_sale_id is null and p_event_type is distinct from 'quota_reached' then
    raise exception using errcode = '23514', message = 'This event needs a sale.';
  end if;

  if p_event_type = 'calendar_exported' then
    v_day_start := pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC') at time zone 'UTC';
    if (
      select pg_catalog.count(*)
      from public.account_product_events event_row
      where event_row.user_id = p_user_id
        and event_row.event_type = 'calendar_exported'
        and event_row.occurred_at >= v_day_start
        and event_row.occurred_at < v_day_start + interval '1 day'
    ) >= 50 then
      return false;
    end if;
  end if;

  insert into public.account_product_events (user_id, event_type, detail, sale_id)
  values (p_user_id, p_event_type, p_detail, p_sale_id)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;

revoke all on function public.record_account_product_event(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_account_product_event(uuid, text, text, uuid)
  to service_role;

comment on function public.record_account_product_event(uuid, text, text, uuid) is
  'Enregistre un événement produit pour un compte (service_role seul). Un seul par compte, type, détail, vente et jour UTC ; une vente est requise sauf pour un quota atteint ; 50 exports d''agenda (calendar_exported) au plus par compte et par jour UTC.';

notify pgrst, 'reload schema';

commit;
