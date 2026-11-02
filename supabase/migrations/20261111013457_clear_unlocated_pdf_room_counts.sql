begin;

set local lock_timeout = '5s';

-- Nombres de pièces tirés des pièces jointes sans passage qui les justifie (02/11/2026).
--
-- La lecture des PDF prenait tout « T1 »… « F9 » pour un type de logement et, à défaut de candidat situé,
-- le premier nombre trouvé dans l'ensemble des pièces. Sur les 44 ventes en cours dont le nombre de pièces
-- venait d'un PDF, la plupart affichaient une valeur fausse : fenêtre « (F1) » d'un diagnostic, servitude
-- « T5 », ligne de tramway « T4 », « PD1 + T1 » d'une étude de sol, en-tête d'un cabinet d'avocats, texte
-- illisible (Bordeaux, 66 rue Lafaurie de Monbadon : « 7 pièces »). Le code corrigé ne garde qu'un candidat
-- situé ; cette migration retire les valeurs déjà enregistrées qui ne remplissent pas cette règle.
--
-- Une valeur n'est retirée que si elle vient encore du PDF (même valeur que sa trace) et que le passage cité
-- ne dit ni « nombre de pièces », ni « N pièces » (en chiffres ou en lettres), ni un type de logement
-- (« appartement T3 », « type F2 ») : une valeur corrigée à la main ou venue de la page est gardée. La
-- relecture IA des pièces pourra la renseigner à nouveau, avec sa citation.

update public.auction_sales sale
   set rooms_count = null,
       raw_payload = sale.raw_payload #- '{pdf_fact_provenance,rooms_count}'
 where sale.raw_payload -> 'pdf_fact_provenance' -> 'rooms_count' ->> 'source' = 'pdf'
   and sale.rooms_count is not null
   and sale.rooms_count::text = sale.raw_payload -> 'pdf_fact_provenance' -> 'rooms_count' ->> 'value'
   and sale.raw_payload -> 'source_factual_snapshot' ->> 'rooms_count' is null
   and coalesce(sale.raw_payload -> 'pdf_fact_provenance' -> 'rooms_count' ->> 'evidence', '') !~* (
         'nombre\s+de\s+pi[eè]ces'
         || '|\m([0-9]+|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eè]ces'
         || '|(appartement|maison|pavillon|logement|villa|duplex|habitation|type)[^.:;]{0,25}\m[TF]\s?[1-9]\M'
         || '|\mstudio\M'
       );

commit;
