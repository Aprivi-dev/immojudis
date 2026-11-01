begin;

set local lock_timeout = '5s';

-- Onglet « Historique » du module Emails (lot 4) : liste des emails REÇUS, union des réponses rattachées à un
-- dossier de l'agent d'information (information_agent_messages, sens entrant) et des messages sans dossier ouvert
-- (information_agent_unrouted_messages). Une fonction de lecture en service_role seulement, pour paginer les deux
-- sources d'un seul curseur (created_at, id) sans lire deux tables en entier côté serveur. Elle ne renvoie ni corps
-- ni extrait : le texte d'un message se lit à la demande, après une trace de consultation.
--
-- Aucune table, aucune donnée modifiée.

create or replace function public.admin_email_received_list(
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_address text default null,
  p_limit integer default 50
)
returns table (
  source text,
  id uuid,
  created_at timestamptz,
  address text,
  subject text,
  attachment_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select received.source, received.id, received.created_at, received.address, received.subject,
    received.attachment_count
  from (
    select
      'case'::text as source,
      message.id,
      message.created_at,
      pg_catalog.lower(coalesce(message.from_email, '')) as address,
      message.subject,
      case when pg_catalog.jsonb_typeof(message.attachments) = 'array'
        then pg_catalog.jsonb_array_length(message.attachments) else 0 end as attachment_count
    from public.information_agent_messages message
    where message.direction = 'inbound'
    union all
    select
      'unrouted'::text,
      unrouted.id,
      unrouted.created_at,
      pg_catalog.lower(coalesce(unrouted.sender_email, '')),
      unrouted.subject,
      unrouted.attachment_count
    from public.information_agent_unrouted_messages unrouted
  ) received
  where (p_before_at is null or (received.created_at, received.id) < (p_before_at, p_before_id))
    -- Recherche exacte ou par préfixe sur l'adresse en minuscules ; \, % et _ sont des caractères ordinaires.
    and (
      p_address is null
      or received.address like pg_catalog.replace(
        pg_catalog.replace(pg_catalog.replace(pg_catalog.lower(p_address), '\', '\\'), '%', '\%'),
        '_', '\_'
      ) || '%'
    )
  order by received.created_at desc, received.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

revoke all on function public.admin_email_received_list(timestamptz, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.admin_email_received_list(timestamptz, uuid, text, integer)
  to service_role;

comment on function public.admin_email_received_list(timestamptz, uuid, text, integer) is
  'Onglet Historique des emails : emails reçus (réponses de l''agent d''information et messages sans dossier ouvert), triés par (created_at, id) décroissants, 100 lignes au plus, sans corps. Réservé à service_role.';

notify pgrst, 'reload schema';

commit;
