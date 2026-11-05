-- Galerie : le dossier /sites/default/files/ d'un site Drupal n'écarte plus une photo
-- (20261111040000_keep_drupal_default_folder_photos.sql). Toutes les photos des Cessions de l'État y sont.
begin;

select plan(5);

select ok(
  pg_get_viewdef('public.v_auction_sales_app'::regclass, true) !~ 'avatar\|brand\|default\|favicon'
  and strpos(pg_get_viewdef('public.v_auction_sales_app'::regclass, true), '|(^|[/_.-])default([_.-][^/?#]*)?([?#].*)?$') > 0,
  'v_auction_sales_app rejects "default" only as a file name'
);
select ok(
  pg_get_viewdef('public.v_auction_sales_discovery'::regclass, true) !~ 'avatar\|brand\|default\|favicon'
  and strpos(pg_get_viewdef('public.v_auction_sales_discovery'::regclass, true), '|(^|[/_.-])default([_.-][^/?#]*)?([?#].*)?$') > 0,
  'v_auction_sales_discovery rejects "default" only as a file name'
);
select ok(
  pg_get_viewdef('public.v_auction_sales_unlocked'::regclass, true) !~ 'avatar\|brand\|default\|favicon'
  and strpos(pg_get_viewdef('public.v_auction_sales_unlocked'::regclass, true), '|(^|[/_.-])default([_.-][^/?#]*)?([?#].*)?$') > 0,
  'v_auction_sales_unlocked rejects "default" only as a file name'
);
select ok(
  pg_get_functiondef('app_private.get_public_sale_details(uuid)'::regprocedure) !~ 'avatar\|brand\|default\|favicon'
  and strpos(pg_get_functiondef('app_private.get_public_sale_details(uuid)'::regprocedure), '|(^|[/_.-])default([_.-][^/?#]*)?([?#].*)?$') > 0,
  'get_public_sale_details counts photos with the same rule'
);
select is(
  array(
    select url !~* (
      '(^|[/_.-])(avatar|brand|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)'
      || '|(^|[/_.-])default([_.-][^/?#]*)?([?#].*)?$'
    )
    from unnest(array[
      'https://cessions.immobilier-etat.gouv.fr/sites/default/files/1_Photos_du_bien.png',
      'https://example.test/img/default.png',
      'https://example.test/img/default_photo.jpg?w=800',
      'https://example.test/sites/default/files/logo.png',
      'https://example.test/photos/maison.jpg'
    ]) with ordinality as sample(url, n)
    order by n
  ),
  array[true, false, false, false, true],
  'a Drupal folder keeps the photo; a default or logo file name is still rejected'
);

select * from finish();
rollback;
