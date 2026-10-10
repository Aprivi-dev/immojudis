-- Rapport EN LECTURE SEULE des ventes aux « informations insuffisantes » (règle de rétention).
--
-- Règle : une vente est conservée si (adresse exploitable ET superficie) OU un e-mail exploitable existe.
-- Elle est non conservée si (adresse exploitable manquante OU superficie manquante) ET aucun e-mail exploitable.
-- Exemptions : statut past/adjudicated/cancelled/withdrawn/quarantined ; parking (superficie non requise) ;
-- pour un terrain, la surface du terrain compte.
--
-- ATTENTION — approximation SQL de src/information_sufficiency.py :
--   * le SQL lit les colonnes déjà stockées + quelques motifs de repli (bloc « Adresse du bien », référence
--     cadastrale, voie nommée dans la description des sources sûres). Il ne rejoue PAS les extracteurs Python :
--     la référence est `python -m src.recompute_scoring --drop-insufficient` (rapport, aucune écriture).
--   * ses motifs sont volontairement un peu plus PERMISSIFS que le Python : en cas de doute il classe la vente
--     « suffisante », donc il sous-liste plutôt qu'il ne sur-liste.
--   * le résolveur d'e-mails de l'agent (information-agent.ts) parcourt lawyer_contact, source_blocks (valeurs de
--     clés d'objet), les source_blocks de chaque observation, raw_payload.source_description et description ;
--     les adresses refusées (opposition / rebond permanent, portée globale ou propre à la vente) sont exclues.
--
-- Usage :  psql -f insufficient_information_report.sql   (ou coller dans l'éditeur SQL)
-- Exécute un seul SELECT : les identifiants par source, les motifs et les compteurs. Aucune écriture.

with
voie as (select '(\m(rue|avenue|av|boulevard|bd|chemin|route|rte|impasse|all[ée]es?|place|quai|cours|faubourg|passage|square|voie|lotissement|hameau|r[ée]sidence|chauss[ée]e|esplanade|sentier|ruelle|traverse|rond-point|parvis|clos|cit[ée]|villa|domaine|za|zi|zac|mont[ée]e|venelle|sente)\M|^\s*[0-9]{1,4}\s*(bis|ter|quater)?\s*[, ]\s*[a-zà-ÿ])'::text as re_street,
                '(lieu[- ]?dit|lieudit|quartier|hameau|ferme|moulin|\mmas\M|ch[âa]teau)'::text as re_lieu_dit,
                '(\msections?\s+[A-Za-z]{1,2}\s*(n[°ºo]?\s*)?[0-9]+|cadastr[ée]e?s?[^.]{0,60}\m[A-Za-z]{1,2}\s?[0-9]{1,4}\M)'::text as re_parcel),
base as (
  select
    a.id,
    coalesce(a.primary_source, a.source_name) as src,
    lower(coalesce(a.status, '')) as status,
    lower(coalesce(a.property_type, 'unknown')) as ptype,
    (nullif(btrim(coalesce(a.city, '')), '') is not null or nullif(btrim(coalesce(a.postal_code, '')), '') is not null) as has_commune,
    coalesce(a.address, '') as address,
    coalesce(a.city, '') as city,
    coalesce(a.title, '') || ' ' || coalesce(a.description, '') || ' ' || coalesce(a.raw_payload->'source_blocks'->>'description', '') as prop_text,
    a.raw_payload->'source_blocks' as blocks,
    (coalesce(a.surface_m2, 0) > 0 or coalesce(a.habitable_surface_m2, 0) > 0
       or coalesce(a.carrez_surface_m2, 0) > 0 or coalesce(a.app_surface_m2, 0) > 0) as built_surface,
    (coalesce(a.land_surface_m2, 0) > 0) as land_surface,
    -- texte exploré par le résolveur de contacts de l'agent
    concat_ws(' ',
      a.lawyer_contact,
      a.raw_payload->>'source_description',
      a.description,
      (select string_agg(v.value, ' ') from jsonb_each_text(case when jsonb_typeof(a.raw_payload->'source_blocks') = 'object'
                                                                  then a.raw_payload->'source_blocks' else '{}'::jsonb end) v),
      jsonb_path_query_array(case when jsonb_typeof(a.observations) = 'array' then a.observations else '[]'::jsonb end,
                             '$[*].raw_payload.source_blocks.*')::text
    ) as contact_text
  from public.auction_sales a
),
emails as (
  -- extractEmails + validation zod : on garde les adresses valides, hors refus (opposition / rebond permanent)
  select distinct b.id, lower(m[1]) as email
  from base b, lateral regexp_matches(b.contact_text, '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})', 'g') m
  where lower(m[1]) ~ '^(?!\.)(?!.*\.\.)[a-z0-9_''+\-.]*[a-z0-9_+-]@([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$'
    and not exists (
      select 1 from public.information_agent_contacts c
      where c.normalized_email = lower(m[1])
        and (c.scope_sale_id is null or c.scope_sale_id = b.id)
        and (c.opposition_status = 'opposed' or c.bounce_status = 'permanent'))
),
verdict as (
  select
    b.id, b.src, b.status,
    (b.status in ('past', 'adjudicated', 'cancelled', 'withdrawn', 'quarantined')) as exempt,
    b.has_commune and (
         -- adresse stockée précise
         (b.address !~* '[0-9]{1,3}\s*(€|euros?)'
          and b.address !~* '\m(selarl|selas|scp|avocats?|commissaires? de justice|huissiers?|notaires?|cabinet|tribunal)\M'
          and (b.address ~* v.re_street or b.address ~* v.re_lieu_dit or b.address ~* v.re_parcel
               -- « Le Hameau Exemple, Autreville » : lieu nommé puis commune (la tête n'est ni la commune ni un code postal)
               or (b.address ~ '^[^,0-9]{3,},\s*([0-9]{5}\s+)?[^,]+(,\s*France)?$'
                   and lower(btrim(split_part(b.address, ',', 1))) <> lower(btrim(b.city)))))
         -- encheres_immobilieres : bloc « Adresse du bien » (libellé puis prix, voie, « , », code postal, commune)
         or (b.src = 'encheres_immobilieres'
             and b.blocks->>'page_text' ~ E'Adresse du bien\n(?:[^\n]*\n){0,4}?[^\n]*(rue|avenue|chemin|route|impasse|all[ée]e|place|quai|cours|boulevard|lieu)[^\n]*\n,\n[0-9]{5}\n')
         -- cessions_etat : référence cadastrale structurée
         or (b.blocks ? 'reference_cadastrale' or b.blocks ? 'references_cadastrales')
         -- sources dont le texte libre est propre au bien : voie nommée, lieu-dit ou parcelle dans la description
         or (b.src in ('cessions_etat', 'avoventes', 'licitor', 'notaires', 'agrasc', 'encheres_publiques', 'info_encheres')
             and (b.prop_text ~* ('\m(rue|avenue|boulevard|chemin|route|impasse|all[ée]e|place|quai|cours|passage|square|lotissement|r[ée]sidence)\M\s+(de la |de l''|du |des |de |d'')?[A-Za-zÀ-ÿ]')
                  or b.prop_text ~* v.re_lieu_dit or b.prop_text ~* v.re_parcel))
    ) as address_ok,
    (b.built_surface
       or (b.land_surface and b.ptype in ('land', 'mixed', 'other', 'unknown'))
       or b.ptype = 'parking'
       -- formulations de surface reconnues par surface_text_recovery.py (sources hors petites_affiches / vench)
       or (b.src not in ('petites_affiches', 'vench')
           and (b.prop_text ~* 'pi[eè]ces?( principales?)?\s*\(\s*[0-9][0-9 .,]*\s*m\s?(2|²)\s*\)'
                or b.prop_text ~* '(chalet|pavillon|duplex|triplex|loft|studio|appartement|maison|villa)[^.]{0,60}?(de|d.environ)\s+[0-9][0-9 .,]*\s*m\s?(2|²)'
                or b.prop_text ~* 'mesurage[^.]{0,160}?superficie\s+de\s+[0-9][0-9 .,]*\s*m\s?(2|²)'
                or b.prop_text ~* 'surface\s+(globale|totale)\s+(d.environ\s+|de\s+)?[0-9][0-9 .,]*\s*m\s?(2|²)'))
    ) as surface_ok,
    exists (select 1 from emails e where e.id = b.id) as has_email
  from base b cross join voie v
),
classified as (
  select *,
    case when exempt then 'exempt'
         when (address_ok and surface_ok) or has_email then 'kept'
         else 'insufficient' end as outcome,
    concat_ws('+', case when not address_ok then 'missing_address' end,
                   case when not surface_ok then 'missing_surface' end) as reasons
  from verdict
)
select
  src,
  count(*) as total,
  count(*) filter (where outcome = 'kept') as kept,
  count(*) filter (where outcome = 'exempt') as exempt,
  count(*) filter (where outcome = 'insufficient') as insufficient,
  count(*) filter (where outcome = 'insufficient' and reasons = 'missing_address') as only_missing_address,
  count(*) filter (where outcome = 'insufficient' and reasons = 'missing_surface') as only_missing_surface,
  count(*) filter (where outcome = 'insufficient' and reasons = 'missing_address+missing_surface') as missing_both,
  count(*) filter (where has_email) as with_usable_email,
  -- identifiants seulement, aucune donnée personnelle :
  array_agg(id order by id) filter (where outcome = 'insufficient') as insufficient_ids
from classified
group by src
order by src;
