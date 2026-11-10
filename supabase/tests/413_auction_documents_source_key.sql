begin;

select plan(9);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.auction_documents'::regclass
      and constraint_row.conname = 'auction_documents_source_url_document_url_key'
      and constraint_row.contype = 'u'
  ),
  'auction documents have the source/document composite uniqueness constraint'
);

select ok(
  not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.auction_documents'::regclass
      and constraint_row.conname = 'auction_documents_document_url_key'
  ),
  'the phase-two rollout removes the legacy global document URL constraint'
);

select ok(
  coalesce(
    position(
      'on conflict (source_url, document_url)'
      in lower(
        -- Depuis 20261114100000, l'écriture de la pièce est faite par le noyau de publication.
        pg_get_functiondef(
          'app_private.apply_information_agent_fact(uuid,text,uuid,text)'::regprocedure
        )
      )
    ) > 0,
    false
  ),
  'the reviewed document publication RPC uses the source/document conflict target'
);

set local role service_role;

select lives_ok(
  $$insert into public.auction_sales (
      id, source_name, source_url, status
    ) values (
      '41300000-1000-4000-8000-000000000001',
      'auction-documents-source-key-pgtap',
      'https://example.test/413/source-a',
      'upcoming'
    )$$,
  'the first synthetic source sale is available for document-key testing'
);

select lives_ok(
  $$insert into public.auction_sales (
      id, source_name, source_url, status
    ) values (
      '41300000-1000-4000-8000-000000000002',
      'auction-documents-source-key-pgtap',
      'https://example.test/413/source-b',
      'upcoming'
    )$$,
  'the second synthetic source sale is available for document-key testing'
);

select lives_ok(
  $$insert into public.auction_documents (
      source_url, document_url, label
    ) values (
      'https://example.test/413/source-a',
      'https://cdn.example.test/413/shared.pdf',
      'shared PDF from source A'
    )$$,
  'a PDF can be attached to the first source'
);

select lives_ok(
  $$insert into public.auction_documents (
      source_url, document_url, label
    ) values (
      'https://example.test/413/source-b',
      'https://cdn.example.test/413/shared.pdf',
      'shared PDF from source B'
    )$$,
  'the same PDF URL can be attached to a different source'
);

select is(
  (
    select count(*)::integer
    from public.auction_documents
    where document_url = 'https://cdn.example.test/413/shared.pdf'
  ),
  2,
  'shared document URLs remain separate source-scoped rows'
);

select throws_ok(
  $$insert into public.auction_documents (
      source_url, document_url, label
    ) values (
      'https://example.test/413/source-a',
      'https://cdn.example.test/413/shared.pdf',
      'duplicate source/document pair'
    )$$,
  '23505',
  null,
  'a source/document pair remains idempotently unique'
);

select * from finish();
rollback;
