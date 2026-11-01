begin;

set local lock_timeout = '5s';

-- Contact de secours d'une vente au tribunal : l'adresse du greffe du référentiel public.court_registry_contacts
-- (migration 20261110190000), quand l'annonce ne donne aucun email d'avocat ou de cabinet exploitable.
-- Cette migration ne change aucune donnée : deux garde-fous de schéma, que le code de l'agent d'information et du
-- pipeline suppose.
--
-- 1. Origine `court_registry_fallback` d'une adresse du registre des contacts de l'agent. Elle distingue l'adresse d'un
--    greffe, reprise du référentiel des tribunaux, de celle d'une annonce, d'un site de cabinet ou d'un annuaire
--    (journal, administration, compteurs). Aucune page publique n'est exigée (source_url peut rester vide) : la
--    contrainte information_agent_contacts_found_source_url_check ne vise que other_listing, firm_website et
--    official_directory.
-- 2. La règle SQL du minimum d'une annonce (app_private.sale_has_listing_minimum, utilisée par
--    app_private.delete_empty_listings) connaît la preuve `court_email` du pipeline
--    (services/data-pipeline/src/listing_minimum.py) : sinon la réparation supprimerait des ventes au tribunal que le
--    pipeline accepte désormais. La règle ne fait que GARDER plus (comme le reste de la fonction) ; elle ne supprime rien.

-- ---------------------------------------------------------------------------
-- 1. Origine d'une adresse de greffe
-- ---------------------------------------------------------------------------
alter table public.information_agent_contacts
  drop constraint if exists information_agent_contacts_source_kind_check;

alter table public.information_agent_contacts
  add constraint information_agent_contacts_source_kind_check check (
    source_kind is null
    or source_kind in (
      'sale_listing', 'other_listing', 'firm_website', 'official_directory', 'admin_entry',
      'court_registry_fallback'
    )
  );

comment on column public.information_agent_contacts.source_kind is
  'Nature de la source de l''adresse : annonce de la vente, autre annonce du professionnel, site du cabinet, annuaire officiel, saisie d''un administrateur, ou référentiel des tribunaux (court_registry_fallback : adresse du greffe, contact de secours d''une vente au tribunal). NULL pour une ligne qui ne porte qu''une opposition ou un rebond.';

-- ---------------------------------------------------------------------------
-- 2. Preuve `court_email` dans la règle SQL du minimum d'une annonce
-- ---------------------------------------------------------------------------
-- Même condition que services/data-pipeline/src/information_sufficiency.py (court_registry_fallback_email) :
-- vente au tribunal CONFIRMÉE par l'annonce (jamais notaires, cessions de l'État ni AGRASC), tribunal reconnu et sans
-- incohérence, dont le référentiel a au moins une adresse.
create or replace function app_private.sale_has_court_registry_email(p_sale public.auction_sales)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    p_sale.sale_venue_type = 'tribunal'
    and p_sale.sale_verification_status in ('verified', 'cross_checked')
    and pg_catalog.lower(pg_catalog.btrim(coalesce(p_sale.source_name, ''))) not in ('notaires', 'cessions_etat', 'agrasc')
    and pg_catalog.lower(pg_catalog.btrim(coalesce(p_sale.primary_source, ''))) not in ('notaires', 'cessions_etat', 'agrasc')
    and not (coalesce(p_sale.quality_flags, '[]'::jsonb) ? 'tribunal_inconsistent')
    and exists (
      select 1
      from public.court_registry_contacts contact
      where contact.court_code = p_sale.tribunal_code
        and pg_catalog.cardinality(contact.emails) > 0
    ),
    false
  );
$function$;

revoke all on function app_private.sale_has_court_registry_email(public.auction_sales)
  from public, anon, authenticated;
grant execute on function app_private.sale_has_court_registry_email(public.auction_sales) to service_role;

comment on function app_private.sale_has_court_registry_email(public.auction_sales) is
  'Vrai si la vente est une vente au tribunal reconnue dont le tribunal a une adresse email dans public.court_registry_contacts (preuve court_email de services/data-pipeline/src/listing_minimum.py).';

-- La règle d'origine est renommée, puis rappelée par la règle complète : delete_empty_listings continue d'appeler
-- app_private.sale_has_listing_minimum, sans changement de signature ni de droits.
do $rename$
begin
  if to_regprocedure('app_private.sale_has_listing_minimum_without_court_email(public.auction_sales)') is null then
    alter function app_private.sale_has_listing_minimum(public.auction_sales)
      rename to sale_has_listing_minimum_without_court_email;
  end if;
end;
$rename$;

create or replace function app_private.sale_has_listing_minimum(p_sale public.auction_sales)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select app_private.sale_has_listing_minimum_without_court_email(p_sale)
    or app_private.sale_has_court_registry_email(p_sale);
$function$;

revoke all on function app_private.sale_has_listing_minimum_without_court_email(public.auction_sales)
  from public, anon, authenticated;
grant execute on function app_private.sale_has_listing_minimum_without_court_email(public.auction_sales)
  to service_role;
revoke all on function app_private.sale_has_listing_minimum(public.auction_sales)
  from public, anon, authenticated;
grant execute on function app_private.sale_has_listing_minimum(public.auction_sales) to service_role;

comment on function app_private.sale_has_listing_minimum_without_court_email(public.auction_sales) is
  'Règle du minimum d''une annonce sans la preuve court_email (corps d''origine de sale_has_listing_minimum, migration 20261108202000).';
comment on function app_private.sale_has_listing_minimum(public.auction_sales) is
  'Minimum d''une annonce : voie ou lieu-dit, email de contact, parcelle cadastrale, pièce, autre source, ou email du tribunal (vente au tribunal). Même règle que services/data-pipeline/src/listing_minimum.py.';

commit;
