begin;

select plan(21);

-- 20261028100100 et 20261028100200 : la date de modification fiable des fiches. Elle est nulle au départ,
-- ne bouge que lorsqu'un champ visible change, et une écriture explicite l'emporte. Les lignes insérées
-- sont annulées en fin de test.

-- Structure et droits -------------------------------------------------------------------------------------

select has_column('public', 'auction_sales', 'content_changed_at', 'la colonne content_changed_at existe');
select col_type_is('public', 'auction_sales', 'content_changed_at', 'timestamp with time zone', 'c''est un timestamptz');
select col_is_null('public', 'auction_sales', 'content_changed_at', 'elle est nullable (nulle au départ)');
select col_hasnt_default('public', 'auction_sales', 'content_changed_at', 'sans valeur par défaut : jamais une date inventée');

select ok(
  not has_column_privilege('anon', 'public.auction_sales', 'content_changed_at', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'content_changed_at', 'select'),
  'les rôles du navigateur ne lisent pas la colonne (seules les fonctions publiques la servent)'
);

select ok(
  (select count(*) = 1
   from pg_trigger trigger_row
   where trigger_row.tgrelid = 'public.auction_sales'::regclass
     and trigger_row.tgname = 'zzzzzz_auction_sales_content_changed_at'
     and trigger_row.tgenabled = 'O'
     and (trigger_row.tgtype & 2) = 2     -- BEFORE
     and (trigger_row.tgtype & 16) = 16), -- UPDATE
  'le déclencheur BEFORE UPDATE est actif'
);

select ok(
  not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_sales'::regclass
      and not trigger_row.tgisinternal
      and (trigger_row.tgtype & 2) = 2
      and (trigger_row.tgtype & 16) = 16
      and convert_to(trigger_row.tgname, 'SQL_ASCII') > convert_to('zzzzzz_auction_sales_content_changed_at', 'SQL_ASCII')
  ),
  'aucun autre déclencheur BEFORE UPDATE ne passe après lui (il voit la ligne définitive)'
);

select ok(
  not has_function_privilege('anon', 'app_private.stamp_auction_sale_content_changed_at()', 'execute')
  and not has_function_privilege('authenticated', 'app_private.stamp_auction_sale_content_changed_at()', 'execute'),
  'la fonction du déclencheur est fermée au navigateur'
);

-- Jeu d'essai -----------------------------------------------------------------------------------------------

insert into public.auction_sales (id, source_name, source_url, status, sale_date, raw_payload, sale_procedure)
values
  ('c4720000-0000-4000-8000-000000000001', 'licitor', 'https://example.test/472/01', 'upcoming',
    current_timestamp + interval '30 days', '{}'::jsonb, '{}'::jsonb);

select is(
  (select content_changed_at from public.auction_sales where id = 'c4720000-0000-4000-8000-000000000001'),
  null::timestamptz,
  'une fiche insérée a une date nulle'
);

-- Aide : replace la date à une valeur ancienne, applique la modification, dit si la date a été posée à now().
create function pg_temp.stamped_by(p_assignments text) returns boolean language plpgsql as $$
declare
  v_old constant timestamptz := '2020-01-01 00:00:00+00';
  v_new timestamptz;
begin
  update public.auction_sales set content_changed_at = v_old
    where id = 'c4720000-0000-4000-8000-000000000001';
  execute format(
    'update public.auction_sales set %s where id = %L',
    p_assignments, 'c4720000-0000-4000-8000-000000000001'
  );
  select content_changed_at into v_new
    from public.auction_sales where id = 'c4720000-0000-4000-8000-000000000001';
  return v_new = now();
end;
$$;

-- Aide : la date reste-t-elle celle du passé après cette modification ?
create function pg_temp.untouched_by(p_assignments text) returns boolean language plpgsql as $$
declare
  v_old constant timestamptz := '2020-01-01 00:00:00+00';
  v_new timestamptz;
begin
  update public.auction_sales set content_changed_at = v_old
    where id = 'c4720000-0000-4000-8000-000000000001';
  execute format(
    'update public.auction_sales set %s where id = %L',
    p_assignments, 'c4720000-0000-4000-8000-000000000001'
  );
  select content_changed_at into v_new
    from public.auction_sales where id = 'c4720000-0000-4000-8000-000000000001';
  return v_new = v_old;
end;
$$;

-- Les champs visibles -------------------------------------------------------------------------------------

select ok(pg_temp.stamped_by('starting_price_eur = 150000'), 'la mise à prix la date');
select ok(pg_temp.stamped_by('sale_date = current_timestamp + interval ''45 days'''), 'la date de vente la date');
select ok(pg_temp.stamped_by('status = ''postponed'''), 'le statut la date');
select ok(
  pg_temp.stamped_by('address = ''12 rue des Lilas''')
  and pg_temp.stamped_by('postal_code = ''33000''')
  and pg_temp.stamped_by('city = ''Bordeaux'''),
  'l''adresse, le code postal et la ville la datent'
);
select ok(pg_temp.stamped_by('app_surface_m2 = 62'), 'la surface la date');
select ok(
  pg_temp.stamped_by('rooms_count = 4')
  and pg_temp.stamped_by('bedrooms_count = 2')
  and pg_temp.stamped_by('bathrooms_count = 1'),
  'le nombre de pièces la date'
);
select ok(
  pg_temp.stamped_by('raw_payload = jsonb_build_object(''raw_image_url'', ''https://img.example.test/a.jpg'')'),
  'une nouvelle photo principale (projetée par le déclencheur de la projection) la date'
);

-- Ce qui ne compte pas --------------------------------------------------------------------------------------

select ok(
  pg_temp.untouched_by('starting_price_eur = starting_price_eur')
  and pg_temp.untouched_by('city = city')
  and pg_temp.untouched_by('status = status'),
  'réécrire la même valeur ne la date pas'
);
select ok(
  pg_temp.untouched_by('description = ''Un autre texte''')
  and pg_temp.untouched_by('last_seen_at = now() + interval ''1 day''')
  and pg_temp.untouched_by('updated_at = now() + interval ''1 day''')
  and pg_temp.untouched_by('title = ''Un autre titre'''),
  'un texte, last_seen_at, updated_at ou le titre ne la datent pas'
);
select ok(
  pg_temp.untouched_by('raw_payload = raw_payload || jsonb_build_object(''noise'', 1)'),
  'un raw_payload qui change sans changer la photo ne la date pas'
);

-- Une écriture explicite l'emporte -----------------------------------------------------------------------------

update public.auction_sales
  set starting_price_eur = 999, content_changed_at = '2021-05-05 10:00:00+00'
  where id = 'c4720000-0000-4000-8000-000000000001';
select is(
  (select content_changed_at from public.auction_sales where id = 'c4720000-0000-4000-8000-000000000001'),
  '2021-05-05 10:00:00+00'::timestamptz,
  'une date écrite explicitement dans la même écriture est conservée'
);

update public.auction_sales set content_changed_at = null
  where id = 'c4720000-0000-4000-8000-000000000001';
select is(
  (select content_changed_at from public.auction_sales where id = 'c4720000-0000-4000-8000-000000000001'),
  null::timestamptz,
  'on peut la remettre à nulle (pas de date fiable)'
);

select * from finish();
rollback;
