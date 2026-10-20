-- Accueil, « Données vérifiées le … » (migration 20261031100200, chantier R1 point 3) : si une source
-- du périmètre (active, avec au moins une vente visible à venir) n'a jamais de publication complète
-- (last_publication_complete_at NULL), la date est inconnue : NULL, l'accueil n'affiche pas de date.
--   * les autres sources ont une date, une source du périmètre n'en a pas : NULL ;
--   * la même source sans vente visible à venir, ou désactivée, ne compte pas : la date redevient le MIN ;
--   * mêmes droits qu'avant : lisible par anon, seule la date sort.
-- Les écritures sont annulées en fin de test.
begin;

select plan(7);

-- Toutes les sources partent désactivées et sans collecte ; chaque cas en réactive quelques-unes.
update public.auction_source_state
  set enabled = false, catalogue_withdrawn = false, last_publication_complete_at = null;

-- n = 1 licitor (à venir), 2 vench (à venir), 3 notaires (à venir).
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, raw_payload)
select
  ('c6520000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  f.source, 'https://example.test/c652/' || f.n, 'Vente c652 ' || f.n, 'upcoming',
  now() + interval '30 days', '{}'::jsonb
from (values (1, 'licitor'), (2, 'vench'), (3, 'notaires')) as f(n, source);

update public.auction_source_state set enabled = true, last_publication_complete_at = '2026-10-17 05:00:00+00'
  where source_name = 'licitor';
update public.auction_source_state set enabled = true, last_publication_complete_at = '2026-10-18 06:30:00+00'
  where source_name = 'vench';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-17 05:00:00+00'::timestamptz,
  'every source of the scope has a date: the oldest one'
);

update public.auction_source_state set enabled = true, last_publication_complete_at = null
  where source_name = 'notaires';
select is(
  public.get_public_catalogue_verified_at(),
  null::timestamptz,
  'a source of the scope that never completed a publication makes the date unknown'
);

update public.auction_source_state set enabled = false where source_name = 'notaires';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-17 05:00:00+00'::timestamptz,
  'the same source, disabled, is out of the scope: back to the oldest date'
);

update public.auction_source_state set enabled = true where source_name = 'notaires';
update public.auction_sales set status = 'withdrawn' where id = 'c6520000-1000-4000-8000-000000000003';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-17 05:00:00+00'::timestamptz,
  'a source whose only sale is no longer visible and upcoming is out of the scope'
);

update public.auction_sales set status = 'upcoming' where id = 'c6520000-1000-4000-8000-000000000003';
update public.auction_sales
  set raw_payload = '{"publication_quarantine": "c652"}'::jsonb
  where id = 'c6520000-1000-4000-8000-000000000003';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-17 05:00:00+00'::timestamptz,
  'nor is a source whose only upcoming sale is under publication quarantine'
);

update public.auction_sales set raw_payload = '{}'::jsonb where id = 'c6520000-1000-4000-8000-000000000003';
update public.auction_source_state set last_publication_complete_at = '2026-10-19 05:00:00+00'
  where source_name = 'notaires';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-17 05:00:00+00'::timestamptz,
  'once every source of the scope has a date, the oldest one is back'
);

set local role anon;
select is(
  public.get_public_catalogue_verified_at() is not null,
  true,
  'the anonymous role still reads the date'
);
reset role;

select * from finish();
rollback;
