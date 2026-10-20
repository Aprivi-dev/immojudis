-- 20261029130100 : le journal des rappels ne garde plus qu'un code court d'une liste fermée dans la
-- colonne error (plus de texte libre du prestataire d'envoi).
begin;

select plan(11);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.sale_reminder_dispatches'::regclass
      and constraint_row.conname = 'sale_reminder_dispatches_error_code_check'
      and constraint_row.contype = 'c'
  ),
  'la contrainte de la liste fermée des codes d''échec existe'
);

select ok(
  (
    select not constraint_row.convalidated
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.sale_reminder_dispatches'::regclass
      and constraint_row.conname = 'sale_reminder_dispatches_error_code_check'
  ),
  'la contrainte est NOT VALID : elle ne parcourt pas les lignes déjà écrites'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('55100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dispatch-codes@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('55100000-1000-4000-8000-000000000001', 'reminder-test', 'https://example.test/reminder-codes/1',
   'Vente rappel 1', 'upcoming', now() + interval '30 days');

-- Une ligne sans erreur est acceptée.
select lives_ok(
  $$insert into public.sale_reminder_dispatches (user_id, sale_id, reminder_kind, dedupe_key, mode)
    values ('55100000-0000-4000-8000-000000000001', '55100000-1000-4000-8000-000000000001',
            'audience_j7', '2026-12-01', 'internal')$$,
  'une ligne sans erreur est acceptée'
);

-- Chaque code de la liste fermée est accepté.
select lives_ok(
  $$update public.sale_reminder_dispatches
    set status = 'failed', error = 'email_unavailable'
    where user_id = '55100000-0000-4000-8000-000000000001'$$,
  'email_unavailable est accepté'
);
select lives_ok(
  $$update public.sale_reminder_dispatches set error = 'email_lookup_failed'$$,
  'email_lookup_failed est accepté'
);
select lives_ok(
  $$update public.sale_reminder_dispatches set error = 'message_build_failed'$$,
  'message_build_failed est accepté'
);
select lives_ok(
  $$update public.sale_reminder_dispatches set error = 'send_failed'$$,
  'send_failed est accepté'
);
select lives_ok(
  $$update public.sale_reminder_dispatches set error = 'journal_failed'$$,
  'journal_failed est accepté'
);

-- Un texte libre (réponse du prestataire, message d'exception) est refusé.
select throws_ok(
  $$update public.sale_reminder_dispatches
    set error = 'The to field must be a valid email address: someone@example.test'$$,
  '23514',
  null,
  'un texte libre est refusé dans la colonne error'
);

-- La réservation d'un rappel échoué remet l'erreur à null : la nouvelle contrainte ne la gêne pas.
select lives_ok(
  $$select public.claim_sale_reminder(
      '55100000-0000-4000-8000-000000000001',
      '55100000-1000-4000-8000-000000000001',
      'audience_j7',
      '2026-12-01',
      'internal',
      '{}'::jsonb
    )$$,
  'un rappel échoué peut être réservé de nouveau'
);

select ok(
  (
    select error is null and status = 'pending' and attempts = 2
    from public.sale_reminder_dispatches
    where user_id = '55100000-0000-4000-8000-000000000001'
  ),
  'la réservation remet l''erreur à null'
);

select * from finish();

rollback;
