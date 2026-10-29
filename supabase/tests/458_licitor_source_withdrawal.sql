begin;

select plan(10);

-- Interrupteur de retrait d'une source (migration 20261021110000) : livré SANS aucune source retirée ;
-- depuis 20261109153217, seule Vench l'est (Licitor reste collecté et affiché). Une fois posé, un seul interrupteur arrête la collecte et masque
-- les ventes de la seule source retirée, sans rien supprimer ; il se lève d'un seul geste. Les lignes de
-- test sont annulées en fin de fichier.

select is(
  array(select source_name from public.auction_source_state where catalogue_withdrawn order by 1),
  array['vench'],
  'current state: only Vench is withdrawn'
);

select ok(
  (select not catalogue_withdrawn and withdrawn_at is null and withdrawn_reason is null
     from public.auction_source_state where source_name = 'licitor'),
  'Licitor is delivered neither withdrawn nor flagged'
);

select ok(
  not has_function_privilege('anon', 'public.set_catalogue_source_withdrawal(text,boolean,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.set_catalogue_source_withdrawal(text,boolean,text)', 'execute')
  and has_function_privilege('service_role', 'public.set_catalogue_source_withdrawal(text,boolean,text)', 'execute'),
  'only the service role can flip the switch'
);

select ok(
  has_function_privilege('anon', 'public.get_withdrawn_catalogue_sources()', 'execute')
  and public.get_withdrawn_catalogue_sources() = array['vench'],
  'visitors can read which sources are withdrawn: only Vench'
);

insert into public.auction_sales (source_name, source_url, observations, raw_payload)
values
  ('licitor', 'https://www.licitor.com/pgtap-seul', '[{"source_name":"licitor"}]', '{}'),
  ('licitor', 'https://www.licitor.com/pgtap-fusionnee',
   '[{"source_name":"licitor"},{"source_name":"info_encheres"}]', '{}');

select ok(
  (select count(*) = 2 and bool_and(coalesce(raw_payload ->> 'publication_quarantine', '') = '')
          and not bool_or(catalogue_quarantined)
     from public.auction_sales where source_url like 'https://www.licitor.com/pgtap-%'),
  'with no source withdrawn, Licitor sales are inserted visible'
);

set local role service_role;
select public.set_catalogue_source_withdrawal('licitor', true, 'pgTAP');
reset role;

select ok(
  (select catalogue_withdrawn and not enabled from public.auction_source_state where source_name = 'licitor')
  and 'licitor' = any (public.get_withdrawn_catalogue_sources()),
  'withdrawing a source disables it and lists it'
);

select throws_ok(
  $$ update public.auction_source_state set enabled = true where source_name = 'licitor' $$,
  '23514',
  null,
  'a withdrawn source cannot be re-enabled by hand'
);

select is(
  (select raw_payload ->> 'publication_quarantine' from public.auction_sales
    where source_url = 'https://www.licitor.com/pgtap-seul'),
  'source_withdrawn',
  'a sale whose only source is withdrawn is quarantined'
);

select ok(
  (select catalogue_quarantined from public.auction_sales where source_url = 'https://www.licitor.com/pgtap-seul')
  and not (select catalogue_quarantined from public.auction_sales where source_url = 'https://www.licitor.com/pgtap-fusionnee'),
  'the materialized catalogue projection follows, and a merged sale stays in the catalogue'
);

set local role service_role;
select public.set_catalogue_source_withdrawal('licitor', false);
reset role;

select ok(
  (select enabled and not catalogue_withdrawn from public.auction_source_state where source_name = 'licitor')
  and (select coalesce(raw_payload ->> 'publication_quarantine', '') = '' from public.auction_sales
        where source_url = 'https://www.licitor.com/pgtap-seul')
  and public.get_withdrawn_catalogue_sources() = array['vench'],
  'lifting the switch re-enables the source and restores the sale'
);

select * from finish();

rollback;
