begin;

set local lock_timeout = '5s';

-- Compteur de vues d'un rapport partagé : l'application lisait la valeur puis écrivait valeur + 1, ce qui
-- perdait des vues quand deux visiteurs ouvraient le lien en même temps. Cette fonction fait l'incrément
-- dans une seule instruction (verrou de ligne), et ne compte que les liens encore ouverts.
-- Réservée au rôle de service : l'application l'appelle depuis la route publique du lien de partage.
--
-- RETOUR ARRIÈRE : drop function public.increment_property_report_share_view(uuid) ; l'application
-- ignore l'échec du compteur (elle journalise et sert quand même le rapport).

create or replace function public.increment_property_report_share_view(p_report_id uuid)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  update public.saved_property_reports
  set share_view_count = share_view_count + 1
  where id = p_report_id
    and share_enabled
  returning share_view_count;
$$;

revoke all on function public.increment_property_report_share_view(uuid) from public, anon, authenticated;
grant execute on function public.increment_property_report_share_view(uuid) to service_role;

comment on function public.increment_property_report_share_view(uuid) is
  'Incrémente atomiquement saved_property_reports.share_view_count d''un rapport dont le partage est actif et renvoie la nouvelle valeur (null sinon). Rôle de service uniquement.';

notify pgrst, 'reload schema';

commit;
