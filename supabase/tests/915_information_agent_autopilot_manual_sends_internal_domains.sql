-- 20261209100100 : les envois manuels vers un domaine interne (information_agent_internal_domains) ne comptent pas
-- parmi les envois manuels réels du pilote, ni dans leurs plaintes et rebonds définitifs. L'adresse de test de Resend
-- reste écartée ; un sous-domaine ou un domaine voisin n'est pas un domaine interne.
begin;

select plan(4);

create or replace function pg_temp.stat(p_key text) returns integer language sql as $$
  select (public.information_agent_autopilot_stats(now()) ->> p_key)::integer
$$;

-- Journal vidé dans cette transaction (annulée à la fin) : seuls les envois du test comptent.
delete from public.email_send_log where category = 'agent' and mode = 'manual';
insert into public.information_agent_internal_domains (domain) values ('interne-915.example')
on conflict (domain) do nothing;

insert into public.email_send_log (resend_email_id, template_key, category, mode, to_address, status, bounce_type)
values
  ('915-pro-1', 'agent_request', 'agent', 'manual', 'me.martin@cabinet-915.example', 'delivered', null),
  ('915-pro-2', 'agent_request', 'agent', 'manual', 'greffe@sous.interne-915.example', 'delivered', null),
  ('915-pro-3', 'agent_request', 'agent', 'manual', 'contact@interne-915.example.org', 'delivered', null),
  ('915-resend', 'agent_request', 'agent', 'manual', 'delivered@resend.dev', 'delivered', null),
  ('915-int-1', 'agent_request', 'agent', 'manual', 'roundtrip-test@immojudis.com', 'delivered', null),
  ('915-int-2', 'agent_request', 'agent', 'manual', 'equipe@interne-915.example', 'complained', null),
  ('915-int-3', 'agent_request', 'agent', 'manual', 'essai@interne-915.example', 'bounced', 'permanent');

select is(
  pg_temp.stat('manual_real_sends'),
  3,
  'only sends to professionals count: internal domains and the Resend test address are excluded, a subdomain or a look-alike domain is not internal'
);
select is(
  pg_temp.stat('manual_complaints'),
  0,
  'a complaint on an internal address does not count'
);
select is(
  pg_temp.stat('manual_permanent_bounces'),
  0,
  'a permanent bounce on an internal address does not count'
);

-- Le domaine retiré de la liste blanche redevient un destinataire comme un autre.
delete from public.information_agent_internal_domains where domain = 'interne-915.example';
select is(
  pg_temp.stat('manual_real_sends'),
  5,
  'the exclusion follows the internal domain list'
);

select * from finish();
rollback;
