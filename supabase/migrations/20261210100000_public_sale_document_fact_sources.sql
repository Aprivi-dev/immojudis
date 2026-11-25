-- 20261210100000 : origine « lecture automatique des pièces » des valeurs de la fiche (lot V3b-2).
--
-- La passe d'écriture de la lecture des pièces par Claude (services/data-pipeline/src/document_vision_pass.py)
-- remplit des cases vides de la fiche (surface habitable ou Carrez, terrain, nombre de pièces) et laisse, par
-- colonne écrite, une trace dans raw_payload.pdf_fact_provenance (reader = 'document_vision'). raw_payload n'est
-- jamais servi au navigateur : cette fonction en tire, pour une vente du catalogue public, de quoi écrire la mention
-- « Relevée automatiquement dans la pièce …, page N » à côté de la valeur affichée, et rien d'autre :
--   * fact_key : la colonne affichée (app_surface_m2, la surface de la fiche, qui se déduit de la surface habitable
--     ou Carrez écrite ; land_surface_m2 ; rooms_count) ;
--   * document_type : le type de la pièce, s'il a la forme d'un code (cahier_conditions_vente…) ;
--   * page_number : la page de la pièce ;
--   * document_key : l'empreinte SHA-256 (hexadécimal) de l'adresse de la pièce, jamais l'adresse. Le navigateur
--     la compare aux pièces que sa vue lui sert déjà (offre Analyse, vente débloquée) pour faire du type de la pièce
--     un lien : la règle d'accès aux pièces reste celle des vues, elle n'est pas recopiée ici.
-- Jamais la valeur, la citation, l'adresse de la pièce, les modèles, la version du prompt ni la date de lecture.
--
-- Une colonne n'a de mention que si sa valeur est encore celle de la trace (une valeur réécrite depuis par un autre
-- chemin la perd) et si le registre des pièces ne la tient pas et ne l'a pas tenue (app_private.sale_registry_columns,
-- 20261208100100). Le retrait (python -m src.document_vision_pass --withdraw, par version du prompt ou par vente)
-- efface la trace avec la valeur : la mention disparaît avec elle.
--
-- Comme public.get_public_sale_lawyer_fact_sources (20261114100000) : lecture security definer à search_path vide
-- dans app_private, enveloppe publique security invoker, exécutables par anon, authenticated et service_role,
-- jamais par public. Aucun objet de l'agent d'information n'est touché.
--
-- Verrous : création de fonctions seulement. Aucun verrou de table. Possible pendant un import.
--
-- Retour arrière : déployer d'abord le code de l'application qui n'appelle plus la fonction, puis
--   drop function if exists public.get_public_sale_document_fact_sources(uuid);
--   drop function if exists app_private.get_public_sale_document_fact_sources(uuid);
begin;

set local lock_timeout = '5s';

create or replace function app_private.get_public_sale_document_fact_sources(p_sale_id uuid)
returns table (fact_key text, document_type text, page_number integer, document_key text)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    trace.key as fact_key,
    case
      when trace.value ->> 'document_type' ~ '^[a-z][a-z0-9_]{0,63}$' then trace.value ->> 'document_type'
    end as document_type,
    (trace.value ->> 'page_number')::integer as page_number,
    case
      when trace.value ->> 'document_url' ~* '^https?://'
        then pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(trace.value ->> 'document_url', 'UTF8')), 'hex'
        )
    end as document_key
  from public.auction_sales s
  cross join lateral pg_catalog.jsonb_each(
    case
      when pg_catalog.jsonb_typeof(s.raw_payload -> 'pdf_fact_provenance') = 'object'
        then s.raw_payload -> 'pdf_fact_provenance'
      else '{}'::jsonb
    end
  ) trace
  where s.id = p_sale_id
    and app_private.auction_sale_is_publicly_visible(s.id)
    and pg_catalog.jsonb_typeof(trace.value) = 'object'
    and trace.value ->> 'reader' = 'document_vision'
    and trace.value ->> 'page_number' ~ '^[1-9][0-9]{0,4}$'
    and trace.key <> all (app_private.sale_registry_columns(s.source_url))
    -- La valeur affichée est encore celle que la lecture a écrite.
    and case trace.key
      when 'app_surface_m2' then
        s.app_surface_m2 = case
          when trace.value ->> 'value' ~ '^[0-9]{1,9}([.][0-9]{1,4})?$' then (trace.value ->> 'value')::numeric
        end
      when 'land_surface_m2' then
        s.land_surface_m2 = case
          when trace.value ->> 'value' ~ '^[0-9]{1,9}([.][0-9]{1,4})?$' then (trace.value ->> 'value')::numeric
        end
      when 'rooms_count' then
        s.rooms_count = case
          when trace.value ->> 'value' ~ '^[0-9]{1,3}$' then (trace.value ->> 'value')::integer
        end
      else false
    end
  order by trace.key;
$function$;

comment on function app_private.get_public_sale_document_fact_sources(uuid) is
  'Lecture automatique des pièces (lot V3b-2) : pour une vente du catalogue public, les colonnes affichées (app_surface_m2, land_surface_m2, rooms_count) dont la valeur est encore celle écrite par la lecture, avec le type de la pièce, sa page et l''empreinte SHA-256 de son adresse. Ni valeur, ni citation, ni adresse.';

revoke all on function app_private.get_public_sale_document_fact_sources(uuid)
  from public, anon, authenticated;
grant execute on function app_private.get_public_sale_document_fact_sources(uuid)
  to anon, authenticated, service_role;

create or replace function public.get_public_sale_document_fact_sources(p_sale_id uuid)
returns table (fact_key text, document_type text, page_number integer, document_key text)
language sql
stable
set search_path = ''
as $function$
  select source.fact_key, source.document_type, source.page_number, source.document_key
  from app_private.get_public_sale_document_fact_sources(p_sale_id) source;
$function$;

revoke all on function public.get_public_sale_document_fact_sources(uuid) from public;
grant execute on function public.get_public_sale_document_fact_sources(uuid)
  to anon, authenticated, service_role;

comment on function public.get_public_sale_document_fact_sources(uuid) is
  'Colonnes de la fiche publique dont la valeur affichée a été relevée automatiquement dans une pièce (lecture des pièces par Claude) : colonne, type de la pièce, page, empreinte de l''adresse de la pièce. Ni valeur, ni citation, ni adresse.';

notify pgrst, 'reload schema';

commit;
