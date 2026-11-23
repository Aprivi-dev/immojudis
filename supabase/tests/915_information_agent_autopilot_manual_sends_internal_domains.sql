-- 20261209100100 : les envois manuels réels du pilote ne comptent que des destinataires professionnels DISTINCTS.
-- Sont écartés : toute adresse de test de Resend (domaine resend.dev, alias compris), tout destinataire d'un domaine
-- interne (information_agent_internal_domains), l'adresse d'un compte administrateur. Un sous-domaine ou un domaine
-- voisin d'un domaine interne n'est pas interne. Plaintes et rebonds définitifs se comptent de la même façon.
begin;

select plan(6);

create or replace function pg_temp.stat(p_key text) returns integer language sql as $$
  select (public.information_agent_autopilot_stats(now()) ->> p_key)::integer
$$;

-- Journal vidé dans cette transaction (annulée à la fin) : seuls les envois du test comptent.
delete from public.email_send_log where category = 'agent' and mode = 'manual';
insert into public.information_agent_internal_domains (domain) values ('interne-915.example')
on conflict (domain) do nothing;
insert into auth.users (id) values ('91500000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('91500000-0000-4000-8000-0000000000a1', 'admin.915@cabinet-admin.example', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role, email = excluded.email;

insert into public.email_send_log (resend_email_id, template_key, category, mode, to_address, status, bounce_type)
values
  ('915-pro-1', 'agent_request', 'agent', 'manual', 'me.martin@cabinet-915.example', 'delivered', null),
  -- Trois envois au même destinataire : un seul destinataire.
  ('915-pro-1b', 'agent_request', 'agent', 'manual', 'me.martin@cabinet-915.example', 'delivered', null),
  ('915-pro-1c', 'agent_request', 'agent', 'manual', 'me.martin@cabinet-915.example', 'delivered', null),
  ('915-pro-2', 'agent_request', 'agent', 'manual', 'greffe@sous.interne-915.example', 'delivered', null),
  ('915-pro-3', 'agent_request', 'agent', 'manual', 'contact@interne-915.example.org', 'delivered', null),
  ('915-resend', 'agent_request', 'agent', 'manual', 'delivered@resend.dev', 'delivered', null),
  ('915-resend-alias', 'agent_request', 'agent', 'manual', 'delivered+1@resend.dev', 'delivered', null),
  ('915-resend-bounce', 'agent_request', 'agent', 'manual', 'bounced@resend.dev', 'bounced', 'permanent'),
  ('915-admin', 'agent_request', 'agent', 'manual', 'admin.915@cabinet-admin.example', 'complained', null),
  ('915-int-1', 'agent_request', 'agent', 'manual', 'roundtrip-test@immojudis.com', 'delivered', null),
  ('915-int-2', 'agent_request', 'agent', 'manual', 'equipe@interne-915.example', 'complained', null),
  ('915-int-3', 'agent_request', 'agent', 'manual', 'essai@interne-915.example', 'bounced', 'permanent');

select is(
  pg_temp.stat('manual_real_sends'),
  3,
  'only distinct professional recipients count: test addresses, internal domains and administrator accounts are excluded, a subdomain or a look-alike domain is not internal'
);
select is(
  pg_temp.stat('manual_complaints'),
  0,
  'a complaint on an internal or administrator address does not count'
);
select is(
  pg_temp.stat('manual_permanent_bounces'),
  0,
  'a permanent bounce on an internal or Resend test address does not count'
);

-- Plaintes et rebonds d'un même destinataire comptent pour un.
insert into public.email_send_log (resend_email_id, template_key, category, mode, to_address, status, bounce_type)
values
  ('915-pro-4', 'agent_request', 'agent', 'manual', 'me.durand@cabinet-915.example', 'bounced', 'permanent'),
  ('915-pro-4b', 'agent_request', 'agent', 'manual', 'me.durand@cabinet-915.example', 'bounced', 'permanent');
select is(
  pg_temp.stat('manual_permanent_bounces'),
  1,
  'two permanent bounces of the same recipient count as one'
);
select is(pg_temp.stat('manual_real_sends'), 4, 'the bounced recipient is one more distinct recipient');

-- Le domaine retiré de la liste blanche redevient un destinataire comme un autre.
delete from public.information_agent_internal_domains where domain = 'interne-915.example';
select is(
  pg_temp.stat('manual_real_sends'),
  6,
  'the exclusion follows the internal domain list'
);

select * from finish();
rollback;
