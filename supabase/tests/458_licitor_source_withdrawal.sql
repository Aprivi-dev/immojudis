begin;

select plan(8);

-- Retrait de Licitor du catalogue (migration 20261021110000) : un seul interrupteur arrête la collecte
-- et masque les ventes de la seule source retirée, sans rien supprimer. Les lignes de test sont
-- annulées en fin de fichier.

select ok(
  (select catalogue_withdrawn and not enabled from public.auction_source_state where source_name = 'licitor'),
  'Licitor is delivered withdrawn and therefore disabled'
);

select throws_ok(
  $$ update public.auction_source_state set enabled = true where source_name = 'licitor' $$,
  '23514',
  null,
  'a withdrawn source cannot be re-enabled by hand'
);

select ok(
  not has_function_privilege('anon', 'public.set_catalogue_source_withdrawal(text,boolean,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.set_catalogue_source_withdrawal(text,boolean,text)', 'execute')
  and has_function_privilege('service_role', 'public.set_catalogue_source_withdrawal(text,boolean,text)', 'execute'),
  'only the service role can flip the switch'
);

select ok(
  has_function_privilege('anon', 'public.get_withdrawn_catalogue_sources()', 'execute')
  and 'licitor' = any (public.get_withdrawn_catalogue_sources()),
  'visitors can read which sources are withdrawn'
);

insert into public.auction_sales (source_name, source_url, observations, raw_payload)
values
  ('licitor', 'https://www.licitor.com/pgtap-seul', '[{"source_name":"licitor"}]', '{}'),
  ('licitor', 'https://www.licitor.com/pgtap-fusionnee',
   '[{"source_name":"licitor"},{"source_name":"info_encheres"}]', '{}');

select is(
  (select raw_payload ->> 'publication_quarantine' from public.auction_sales
    where source_url = 'https://www.licitor.com/pgtap-seul'),
  'source_withdrawn',
  'a sale whose only source is withdrawn is quarantined on insert'
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
        where source_url = 'https://www.licitor.com/pgtap-seul'),
  'lifting the switch re-enables the source and restores the sale'
);

set local role service_role;
select public.set_catalogue_source_withdrawal('licitor', true, 'pgTAP');
reset role;

select is(
  (select raw_payload ->> 'publication_quarantine' from public.auction_sales
    where source_url = 'https://www.licitor.com/pgtap-seul'),
  'source_withdrawn',
  'withdrawing again hides the sale again'
);

select * from finish();

rollback;
