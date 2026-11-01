begin;

set local lock_timeout = '5s';

-- Référentiel des tribunaux judiciaires et de leurs adresses email (greffe ou accueil), fourni par le propriétaire
-- d'Immojudis le 01/11/2026 (docs/reference/tribunaux-judiciaires-emails-2026-11-01.csv) : 168 juridictions, 162 avec
-- au moins une adresse email, 6 sans (Angoulême, Argentan, Béziers, Sarreguemines, Verdun, Saint-Pierre-et-Miquelon),
-- 2 pour Cayenne.
--
-- Usage : contact de SECOURS pour une vente au tribunal (saisie immobilière ou autre vente judiciaire, jamais notaires,
-- cessions de l'État ni AGRASC) dont l'annonce ne donne aucun email d'avocat ou de cabinet exploitable :
--   * le pipeline (services/data-pipeline/src/listing_minimum.py, preuve `court_email`) n'écarte plus l'annonce faute
--     d'email ;
--   * l'agent d'information (src/lib/information-agent/court-registry.ts) peut écrire au greffe, dans ce seul cas.
-- Les adresses `@justice.fr` lues DANS une annonce restent exclues (court) : seule cette table sert de secours.
--
-- `court_code` est le code de juridiction que le dépôt écrit dans `auction_sales.tribunal_code` : les codes
-- historiques de l'application (agen, bayonne, bergerac, bordeaux, dax, libourne, mont_de_marsan, pau, perigueux) et,
-- pour tous les autres, `justice_tj_<origine>_<srj>` du référentiel officiel de la Justice
-- (services/data-pipeline/src/court_competence.py ; liste de supabase/migrations/20260824163134_*). Le rattachement
-- de chaque ligne est fait par le nom officiel du tribunal (accents, tirets, « Saint », Cayenne/Matoury,
-- Saint-Pierre-et-Miquelon compris) ; « Tribunal judiciaire de Saint-Denis » du fichier est le tribunal de
-- Saint-Denis de La Réunion (adresse 97400, adresse email st-denis-de-la-reunion), alias déjà connu du dépôt
-- (court_competence._court_names_compatible). Pas de clé étrangère vers `tribunals`, qui ne contient que les tribunaux
-- ayant déjà une vente : ce référentiel couvre les 168 juridictions.
--
-- Table privée : RLS activée, aucun droit pour anon ni authenticated, lecture par le rôle de service seulement
-- (pipeline et serveur Next.js), comme les autres tables de référence (anil_rents).

create table if not exists public.court_registry_contacts (
  court_code text primary key check (btrim(court_code) <> ''),
  name text not null check (btrim(name) <> ''),
  city text not null check (btrim(city) <> ''),
  -- Adresses en minuscules, sans espace ni virgule ; tableau vide : la juridiction n'a pas d'adresse connue.
  emails text[] not null default '{}'::text[] check (
    cardinality(emails) <= 4
    and array_position(emails, null) is null
    and array_to_string(emails, ',') ~ '^([^[:space:],@A-Z]+@[^[:space:],@A-Z]+(,[^[:space:],@A-Z]+@[^[:space:],@A-Z]+)*)?$'
  ),
  address text not null check (btrim(address) <> ''),
  source text not null check (btrim(source) <> ''),
  imported_at timestamptz not null default now()
);

comment on table public.court_registry_contacts is
  'Tribunaux judiciaires et leurs adresses email de greffe ou d''accueil (fichier fourni par le propriétaire le 01/11/2026). Contact de secours des ventes au tribunal sans email d''avocat : preuve court_email du pipeline et destinataire de l''agent d''information. Table privée, lue par le rôle de service seulement.';
comment on column public.court_registry_contacts.court_code is
  'Code de juridiction de auction_sales.tribunal_code (code historique de l''application ou justice_tj_<origine>_<srj>).';
comment on column public.court_registry_contacts.emails is
  'Adresses email de la juridiction, en minuscules ; vide si aucune n''est connue.';
comment on column public.court_registry_contacts.source is
  'Provenance de la ligne.';
comment on column public.court_registry_contacts.imported_at is
  'Date d''import de la ligne.';

alter table public.court_registry_contacts enable row level security;

revoke all on table public.court_registry_contacts from public, anon, authenticated;

grant select, insert, update, delete on table public.court_registry_contacts to service_role;

insert into public.court_registry_contacts (court_code, name, city, emails, address, source)
select
  contact.court_code,
  contact.name,
  contact.city,
  contact.emails,
  contact.address,
  'Fichier des tribunaux judiciaires fourni par le propriétaire d''Immojudis le 01/11/2026 (docs/reference/tribunaux-judiciaires-emails-2026-11-01.csv)'
from (
  values
    ('agen', 'Tribunal judiciaire d''Agen', 'AGEN', array['tj-agen@justice.fr']::text[], 'AVENUE DE LATTRE DE TASSIGNY 47000 AGEN'),
    ('bayonne', 'Tribunal judiciaire de Bayonne', 'BAYONNE', array['accueil-bayonne@justice.fr']::text[], 'AVENUE DE LA LEGION TCHEQUE 64100 BAYONNE'),
    ('bergerac', 'Tribunal judiciaire de Bergerac', 'BERGERAC', array['accueil-bergerac@justice.fr']::text[], 'RUE DU PALAIS 24100 BERGERAC'),
    ('bordeaux', 'Tribunal judiciaire de Bordeaux', 'BORDEAUX', array['tj-bordeaux@justice.fr']::text[], '30 RUE DES FRERES BONIE 33000 BORDEAUX'),
    ('dax', 'Tribunal judiciaire de Dax', 'DAX', array['tj-dax@justice.fr']::text[], 'RUE DES FUSILLES 40100 DAX'),
    ('justice_tj_1_100', 'Tribunal judiciaire de Châteauroux', 'CHATEAUROUX', array['tj-chateauroux@justice.fr']::text[], 'PLACE LUCIEN GERMEREAU 36000 CHATEAUROUX'),
    ('justice_tj_1_101', 'Tribunal judiciaire de Tours', 'TOURS', array['tj-tours@justice.fr']::text[], '2 PLACE JEAN-JAURES 37000 TOURS'),
    ('justice_tj_1_102', 'Tribunal judiciaire de Bourgoin-Jallieu', 'BOURGOIN JALLIEU', array['accueil-bourgoin-jallieu@justice.fr']::text[], '12 RUE DU TRIBUNAL 38300 BOURGOIN JALLIEU'),
    ('justice_tj_1_103', 'Tribunal judiciaire de Grenoble', 'GRENOBLE', array['tj-grenoble@justice.fr']::text[], 'PLACE FIRMIN GAUTIER 38000 GRENOBLE'),
    ('justice_tj_1_104', 'Tribunal judiciaire de Vienne', 'VIENNE', array['accueil.tj-vienne@justice.fr']::text[], '16 PLACE CHARLES DE GAULLE 38200 VIENNE'),
    ('justice_tj_1_106', 'Tribunal judiciaire de Lons-le-Saunier', 'LONS LE SAUNIER', array['accueil-lons-le-saunier@justice.fr']::text[], '11 RUE PASTEUR 39000 LONS LE SAUNIER'),
    ('justice_tj_1_109', 'Tribunal judiciaire de Blois', 'BLOIS', array['accueil-blois@justice.fr']::text[], '1 PLACE DE LA REPUBLIQUE 41000 BLOIS'),
    ('justice_tj_1_111', 'Tribunal judiciaire de Roanne', 'ROANNE', array['accueil-roanne@justice.fr']::text[], '5 BIS PLACE GEORGES CLEMENCEAU 42300 ROANNE'),
    ('justice_tj_1_112', 'Tribunal judiciaire de Saint-Etienne', 'ST ETIENNE', array['accueil-saint-etienne@justice.fr']::text[], 'PLACE DU PALAIS DE JUSTICE 42000 ST ETIENNE'),
    ('justice_tj_1_113', 'Tribunal judiciaire du Puy-en-Velay', 'LE PUY EN VELAY', array['accueil.tj-le-puy-en-velay@justice.fr']::text[], 'PLACE DU BREUIL 43000 LE PUY EN VELAY'),
    ('justice_tj_1_114', 'Tribunal judiciaire de Nantes', 'NANTES', array['tj-nantes@justice.fr']::text[], '19 QUAI FRANCOIS MITTERRAND 44000 NANTES'),
    ('justice_tj_1_115', 'Tribunal judiciaire de Saint-Nazaire', 'ST NAZAIRE', array['tj-st-nazaire@justice.fr']::text[], '77 RUE ALBERT DE MUN 44600 ST NAZAIRE'),
    ('justice_tj_1_116', 'Tribunal judiciaire de Montargis', 'MONTARGIS', array['tj-montargis@justice.fr']::text[], '84 RUE DU GENERAL LECLERC 45200 MONTARGIS'),
    ('justice_tj_1_117', 'Tribunal judiciaire d''Orléans', 'ORLEANS', array['tj-orleans@justice.fr']::text[], '44 RUE DE LA BRETONNERIE 45000 ORLEANS'),
    ('justice_tj_1_118', 'Tribunal judiciaire de Cahors', 'CAHORS', array['accueil.tj-cahors@justice.fr']::text[], 'BOULEVARD LEON GAMBETTA 46000 CAHORS'),
    ('justice_tj_1_121', 'Tribunal judiciaire de Mende', 'MENDE', array['tj-mende@justice.fr']::text[], 'BOULEVARD HENRI BOURRILLON 48000 MENDE'),
    ('justice_tj_1_122', 'Tribunal judiciaire d''Angers', 'ANGERS', array['accueil-angers@justice.fr']::text[], 'RUE WALDECK ROUSSEAU 49000 ANGERS'),
    ('justice_tj_1_125', 'Tribunal judiciaire de Cherbourg-en-Cotentin', 'CHERBOURG EN COTENTIN', array['accueil.tj-cherbourg@justice.fr']::text[], '15 RUE DES TRIBUNAUX 50100 CHERBOURG EN COTENTIN'),
    ('justice_tj_1_126', 'Tribunal judiciaire de Coutances', 'COUTANCES', array['accueil.tj-coutances@justice.fr']::text[], '10A RUE DU PALAIS DE JUSTICE 50200 COUTANCES'),
    ('justice_tj_1_127', 'Tribunal judiciaire de Châlons-en-Champagne', 'CHALONS EN CHAMPAGNE', array['tj-chalons-en-champagne@justice.fr']::text[], '2 QUAI EUGENE PERRIER 51000 CHALONS EN CHAMPAGNE'),
    ('justice_tj_1_128', 'Tribunal judiciaire de Reims', 'REIMS', array['accueil-reims@justice.fr']::text[], 'PLACE MYRON HERRICK 51100 REIMS'),
    ('justice_tj_1_129', 'Tribunal judiciaire de Chaumont', 'CHAUMONT', array['tj1-chaumont@justice.fr']::text[], 'RUE DU PALAIS 52000 CHAUMONT'),
    ('justice_tj_1_130', 'Tribunal judiciaire de Laval', 'LAVAL', array['accueil-laval@justice.fr']::text[], '13 PLACE SAINT TUGAL 53000 LAVAL'),
    ('justice_tj_1_131', 'Tribunal judiciaire de Val de Briey', 'VAL DE BRIEY', array['accueil-briey@justice.fr']::text[], '4 RUE DU MARECHAL FOCH 54150 VAL DE BRIEY'),
    ('justice_tj_1_132', 'Tribunal judiciaire de Nancy', 'NANCY', array['tj-nancy@justice.fr']::text[], 'RUE DU GENERAL FABVIER 54000 NANCY'),
    ('justice_tj_1_133', 'Tribunal judiciaire de Bar-le-Duc', 'BAR LE DUC', array['accueil-bar-le-duc@justice.fr']::text[], '21-25 PLACE SAINT-PIERRE 55000 BAR LE DUC'),
    ('justice_tj_1_134', 'Tribunal judiciaire de Verdun', 'VERDUN', '{}'::text[], 'PLACE SAINT PAUL 55100 VERDUN'),
    ('justice_tj_1_135', 'Tribunal judiciaire de Lorient', 'LORIENT', array['tj-lorient@justice.fr']::text[], '1 RUE MAITRE ESVELIN 56100 LORIENT'),
    ('justice_tj_1_136', 'Tribunal judiciaire de Vannes', 'VANNES', array['tj1-vannes@justice.fr']::text[], '22 PLACE DE LA REPUBLIQUE 56000 VANNES'),
    ('justice_tj_1_137', 'Tribunal judiciaire de Metz', 'METZ', array['accueil-metz@justice.fr']::text[], '3 RUE HAUTE PIERRE 57000 METZ'),
    ('justice_tj_1_138', 'Tribunal judiciaire de Sarreguemines', 'SARREGUEMINES', '{}'::text[], 'PLACE DU GENERAL SIBILLE 57200 SARREGUEMINES'),
    ('justice_tj_1_139', 'Tribunal judiciaire de Thionville', 'THIONVILLE', array['accueil.tj-thionville@justice.fr']::text[], 'QUAI PIERRE MARCHAL 57100 THIONVILLE'),
    ('justice_tj_1_140', 'Tribunal judiciaire de Nevers', 'NEVERS', array['accueil.tj-nevers@justice.fr']::text[], 'PLACE DU PALAIS 58000 NEVERS'),
    ('justice_tj_1_141', 'Tribunal judiciaire d''Avesnes-sur-Helpe', 'AVESNES SUR HELPE', array['accueil.tj-avesnes-sur-helpe@justice.fr']::text[], '11 RUE DU MARECHAL JOFFRE 59440 AVESNES SUR HELPE'),
    ('justice_tj_1_142', 'Tribunal judiciaire de Cambrai', 'CAMBRAI', array['tj-cambrai@justice.fr']::text[], 'RUE FROISSART 59400 CAMBRAI'),
    ('justice_tj_1_143', 'Tribunal judiciaire de Douai', 'DOUAI', array['accueil-douai@justice.fr']::text[], '5 RUE MERLIN DE DOUAI 59500 DOUAI'),
    ('justice_tj_1_144', 'Tribunal judiciaire de Dunkerque', 'DUNKERQUE', array['accueil-dunkerque@justice.fr']::text[], 'PLACE DU PALAIS DE JUSTICE 59140 DUNKERQUE'),
    ('justice_tj_1_146', 'Tribunal judiciaire de Lille', 'LILLE', array['tj1-lille@justice.fr']::text[], '13 AVENUE DU PEUPLE BELGE 59000 LILLE'),
    ('justice_tj_1_147', 'Tribunal judiciaire de Valenciennes', 'VALENCIENNES', array['tj-valenciennes@justice.fr']::text[], '6 AVENUE DES DENTELLIERES 59300 VALENCIENNES'),
    ('justice_tj_1_148', 'Tribunal judiciaire de Beauvais', 'BEAUVAIS', array['accueil-beauvais@justice.fr']::text[], '20 BOULEVARD SAINT-JEAN 60000 BEAUVAIS'),
    ('justice_tj_1_149', 'Tribunal judiciaire de Compiègne', 'COMPIEGNE', array['tj-compiegne@justice.fr']::text[], '11 RUE HENRI DE SEROUX 60200 COMPIEGNE'),
    ('justice_tj_1_150', 'Tribunal judiciaire de Senlis', 'SENLIS', array['accueil-senlis@justice.fr']::text[], '26 ALLEE DES SOUPIRS 60300 SENLIS'),
    ('justice_tj_1_151', 'Tribunal judiciaire d''Alençon', 'ALENCON', array['accueil.tj-alencon@justice.fr']::text[], 'PLACE DU MARECHAL FOCH 61000 ALENCON'),
    ('justice_tj_1_152', 'Tribunal judiciaire d''Argentan', 'ARGENTAN', '{}'::text[], 'RUE DES ANCIENS COMBATTANTS 61200 ARGENTAN'),
    ('justice_tj_1_153', 'Tribunal judiciaire d''Arras', 'ARRAS', array['accueil-arras@justice.fr']::text[], 'PLACE DES ETATS D''ARTOIS 62000 ARRAS'),
    ('justice_tj_1_154', 'Tribunal judiciaire de Béthune', 'BETHUNE', array['accueil-bethune@justice.fr']::text[], 'PLACE LAMARTINE 62400 BETHUNE'),
    ('justice_tj_1_155', 'Tribunal judiciaire de Boulogne-sur-Mer', 'BOULOGNE SUR MER', array['tj1-boulogne-sur-mer@justice.fr']::text[], 'PLACE DE LA RESISTANCE 62200 BOULOGNE SUR MER'),
    ('justice_tj_1_156', 'Tribunal judiciaire de Saint-Omer', 'ST OMER', array['accueil-st-omer@justice.fr']::text[], '3 RUE DES TRIBUNAUX 62500 ST OMER'),
    ('justice_tj_1_157', 'Tribunal judiciaire de Clermont-Ferrand', 'CLERMONT FERRAND', array['tj-clermont-ferrand@justice.fr']::text[], '16 PLACE DE L''ETOILE 63000 CLERMONT FERRAND'),
    ('justice_tj_1_161', 'Tribunal judiciaire de Tarbes', 'TARBES', array['tj-tarbes@justice.fr']::text[], '6 BIS RUE DU MARECHAL FOCH 65000 TARBES'),
    ('justice_tj_1_162', 'Tribunal judiciaire de Perpignan', 'PERPIGNAN', array['accueil-perpignan@justice.fr']::text[], 'PLACE ARAGO 66000 PERPIGNAN'),
    ('justice_tj_1_163', 'Tribunal judiciaire de Saverne', 'SAVERNE', array['accueil-saverne@justice.fr']::text[], '7 RUE DU TRIBUNAL 67700 SAVERNE'),
    ('justice_tj_1_164', 'Tribunal judiciaire de Strasbourg', 'STRASBOURG CEDEX', array['accueil-strasbourg@justice.fr']::text[], 'QUAI FINKMATT 67070 STRASBOURG CEDEX'),
    ('justice_tj_1_165', 'Tribunal judiciaire de Colmar', 'COLMAR', array['tj1-colmar@justice.fr']::text[], 'PLACE DU MARCHE AUX FRUITS 68000 COLMAR'),
    ('justice_tj_1_166', 'Tribunal judiciaire de Mulhouse', 'MULHOUSE', array['accueil-mulhouse@justice.fr']::text[], '21 AVENUE ROBERT SCHUMAN 68100 MULHOUSE'),
    ('justice_tj_1_167', 'Tribunal judiciaire de Lyon', 'LYON', array['tj-lyon@justice.fr']::text[], '67 RUE SERVIENT 69003 LYON'),
    ('justice_tj_1_168', 'Tribunal judiciaire de Villefranche-sur-Saône', 'VILLEFRANCHE SUR SAONE', array['accueil-villefranche-sur-saone@justice.fr']::text[], '350 BOULEVARD GAMBETTA 69400 VILLEFRANCHE SUR SAONE'),
    ('justice_tj_1_170', 'Tribunal judiciaire de Vesoul', 'VESOUL', array['accueil-vesoul@justice.fr']::text[], '4 PLACE DU PALAIS 70000 VESOUL'),
    ('justice_tj_1_171', 'Tribunal judiciaire de Chalon-sur-Saône', 'CHALON SUR SAONE', array['tj-chalon-sur-saone@justice.fr']::text[], 'RUE EMILAND MENAND 71100 CHALON SUR SAONE'),
    ('justice_tj_1_172', 'Tribunal judiciaire de Mâcon', 'MACON', array['accueil-macon@justice.fr']::text[], '8 RUE DE LA PREFECTURE 71000 MACON'),
    ('justice_tj_1_173', 'Tribunal judiciaire du Mans', 'LE MANS', array['tj-le-mans@justice.fr']::text[], '1 AVENUE PIERRE MENDES-FRANCE 72000 LE MANS'),
    ('justice_tj_1_174', 'Tribunal judiciaire d''Albertville', 'ALBERTVILLE', array['accueil-albertville@justice.fr']::text[], 'AVENUE DES CHASSEURS ALPINS 73200 ALBERTVILLE'),
    ('justice_tj_1_175', 'Tribunal judiciaire de Chambéry', 'CHAMBERY', array['accueil-chambery@justice.fr']::text[], 'PLACE DU PALAIS DE JUSTICE 73000 CHAMBERY'),
    ('justice_tj_1_176', 'Tribunal judiciaire d''Annecy', 'ANNECY', array['accueil-annecy@justice.fr']::text[], '51 RUE SOMMEILLER 74000 ANNECY'),
    ('justice_tj_1_177', 'Tribunal judiciaire de Bonneville', 'BONNEVILLE', array['accueil-bonneville@justice.fr']::text[], 'QUAI DU PARQUET 74130 BONNEVILLE'),
    ('justice_tj_1_178', 'Tribunal judiciaire de Thonon-les-Bains', 'THONON LES BAINS', array['accueil-thonon-les-bains@justice.fr']::text[], '10 RUE DE L''HOTEL DIEU 74200 THONON LES BAINS'),
    ('justice_tj_1_180', 'Tribunal judiciaire de Dieppe', 'DIEPPE', array['tj1-dieppe@justice.fr']::text[], 'SQUARE CARNOT 76200 DIEPPE'),
    ('justice_tj_1_181', 'Tribunal judiciaire du Havre', 'LE HAVRE', array['tj1-le-havre@justice.fr']::text[], '133 BOULEVARD DE STRASBOURG 76600 LE HAVRE'),
    ('justice_tj_1_182', 'Tribunal judiciaire de Rouen', 'ROUEN', array['tj-rouen@justice.fr']::text[], '34 RUE AUX JUIFS 76000 ROUEN'),
    ('justice_tj_1_183', 'Tribunal judiciaire de Fontainebleau', 'FONTAINEBLEAU', array['tj1-fontainebleau@justice.fr']::text[], '159 RUE GRANDE 77300 FONTAINEBLEAU'),
    ('justice_tj_1_184', 'Tribunal judiciaire de Meaux', 'MEAUX', array['accueil.tj-meaux@justice.fr']::text[], '44 AVENUE SALVADOR ALLENDE 77100 MEAUX'),
    ('justice_tj_1_185', 'Tribunal judiciaire de Melun', 'MELUN', array['tj1-melun@justice.fr']::text[], '2 AVENUE DU GENERAL LECLERC 77000 MELUN'),
    ('justice_tj_1_186', 'Tribunal judiciaire de Versailles', 'VERSAILLES', array['tj1-versailles@justice.fr']::text[], '5 PLACE ANDRE MIGNOT 78000 VERSAILLES'),
    ('justice_tj_1_188', 'Tribunal judiciaire de Niort', 'NIORT', array['tj1-niort@justice.fr']::text[], '2 RUE DU PALAIS 79000 NIORT'),
    ('justice_tj_1_190', 'Tribunal judiciaire d''Amiens', 'AMIENS', array['accueil-amiens@justice.fr']::text[], '14 RUE ROBERT DE LUZARCHES 80000 AMIENS'),
    ('justice_tj_1_192', 'Tribunal judiciaire d''Albi', 'ALBI', array['tj-albi@justice.fr']::text[], 'PLACE LAPEROUSE 81000 ALBI'),
    ('justice_tj_1_193', 'Tribunal judiciaire de Castres', 'CASTRES', array['tj-castres@justice.fr']::text[], '4 RUE DU PALAIS 81100 CASTRES'),
    ('justice_tj_1_194', 'Tribunal judiciaire de Montauban', 'MONTAUBAN', array['accueil-tj-montauban@justice.fr']::text[], 'PLACE DU COQ 82000 MONTAUBAN'),
    ('justice_tj_1_195', 'Tribunal judiciaire de Draguignan', 'DRAGUIGNAN', array['accueil-draguignan@justice.fr']::text[], '11 RUE PIERRE CLEMENT 83300 DRAGUIGNAN'),
    ('justice_tj_1_196', 'Tribunal judiciaire de Toulon', 'TOULON', array['accueil-toulon@justice.fr']::text[], 'PLACE GABRIEL PERI 83000 TOULON'),
    ('justice_tj_1_197', 'Tribunal judiciaire d''Avignon', 'AVIGNON', array['tj-avignon@justice.fr']::text[], '2 BOULEVARD LIMBERT 84000 AVIGNON'),
    ('justice_tj_1_198', 'Tribunal judiciaire de Carpentras', 'CARPENTRAS', array['tj-carpentras@justice.fr']::text[], '52 PLACE CHARLES DE GAULLE 84200 CARPENTRAS'),
    ('justice_tj_1_199', 'Tribunal judiciaire de La Roche-sur-Yon', 'LA ROCHE SUR YON', array['accueil-la-roche-sur-yon@justice.fr']::text[], '55 BOULEVARD ARISTIDE BRIAND 85000 LA ROCHE SUR YON'),
    ('justice_tj_1_200', 'Tribunal judiciaire des Sables-d''Olonne', 'LES SABLES D OLONNE', array['tj-les-sables-d''olonne@justice.fr']::text[], 'PLACE DU PALAIS DE JUSTICE 85100 LES SABLES D OLONNE'),
    ('justice_tj_1_201', 'Tribunal judiciaire de Poitiers', 'POITIERS', array['accueil-poitiers@justice.fr']::text[], '4 BD MARECHAL DE LATTRE DE TASSIGNY 86000 POITIERS'),
    ('justice_tj_1_202', 'Tribunal judiciaire de Limoges', 'LIMOGES', array['accueil.tj-limoges@justice.fr']::text[], '23 PLACE WINSTON CHURCHILL 87000 LIMOGES'),
    ('justice_tj_1_203', 'Tribunal judiciaire d''Epinal', 'EPINAL', array['accueil-epinal@justice.fr']::text[], 'PLACE EDMOND HENRY 88000 EPINAL'),
    ('justice_tj_1_205', 'Tribunal judiciaire d''Auxerre', 'AUXERRE', array['tj-auxerre@justice.fr']::text[], 'PLACE DU PALAIS DE JUSTICE 89000 AUXERRE'),
    ('justice_tj_1_206', 'Tribunal judiciaire de Sens', 'SENS', array['sauj.tj-sens@justice.fr']::text[], '1 RUE DU PALAIS DE JUSTICE 89100 SENS'),
    ('justice_tj_1_207', 'Tribunal judiciaire de Belfort', 'BELFORT', array['accueil-belfort@justice.fr']::text[], '9 PLACE DE LA REPUBLIQUE 90000 BELFORT'),
    ('justice_tj_1_208', 'Tribunal judiciaire d''Évry-Courcouronnes', 'EVRY COURCOURONNES', array['tj1-evry@justice.fr']::text[], '9 RUE DES MAZIERES 91000 EVRY COURCOURONNES'),
    ('justice_tj_1_209', 'Tribunal judiciaire de Nanterre', 'NANTERRE', array['accueil.tj-nanterre@justice.fr']::text[], '179-191 AVENUE JOLIOT CURIE 92000 NANTERRE'),
    ('justice_tj_1_210', 'Tribunal judiciaire de Bobigny', 'BOBIGNY', array['tj1-bobigny@justice.fr']::text[], '173 AVENUE PAUL VAILLANT COUTURIER 93000 BOBIGNY'),
    ('justice_tj_1_211', 'Tribunal judiciaire de Créteil', 'CRETEIL', array['tj-creteil@justice.fr']::text[], 'PLACE DU PALAIS 94000 CRETEIL'),
    ('justice_tj_1_212', 'Tribunal judiciaire de Pontoise', 'PONTOISE', array['tj-pontoise@justice.fr']::text[], '3 RUE VICTOR HUGO 95300 PONTOISE'),
    ('justice_tj_1_213', 'Tribunal judiciaire de Basse-Terre', 'BASSE TERRE', array['tj2-basse-terre@justice.fr']::text[], '4 BOULEVARD FELIX EBOUE 97100 BASSE TERRE'),
    ('justice_tj_1_214', 'Tribunal judiciaire de Pointe-à-Pitre', 'POINTE A PITRE', array['accueil.tj-pointe-a-pitre@justice.fr']::text[], '16 RUE DUGOMMIER 97110 POINTE A PITRE'),
    ('justice_tj_1_215', 'Tribunal judiciaire de Fort-de-France', 'FORT DE FRANCE', array['accueil-fort-de-france@justice.fr']::text[], '35 BOULEVARD DU GENERAL DE GAULLE 97200 FORT DE FRANCE'),
    ('justice_tj_1_216', 'Tribunal judiciaire de Cayenne', 'MATOURY', array['accueil-cayenne@justice.fr', 'bav.tj-cayenne@justice.fr']::text[], 'ESPACE CONSULAIRE DE FORMATION BAT LARIVOT - ZA PARKWAY 97351 MATOURY'),
    ('justice_tj_1_217', 'Tribunal judiciaire de Saint-Denis', 'ST DENIS', array['accueil.tj-st-denis-de-la-reunion@justice.fr']::text[], 'AVENUE DESBASSYNS 97400 ST DENIS'),
    ('justice_tj_1_218', 'Tribunal judiciaire de Saint-Pierre', 'ST PIERRE', array['accueil.tj-st-pierre-de-la-reunion@justice.fr']::text[], '28 RUE AUGUSTIN ARCHAMBAUD 97410 ST PIERRE'),
    ('justice_tj_1_221', 'Tribunal de Première Instance de Mata-Utu', 'UVEA', array['accueil.tpi-mata-utu@justice.fr']::text[], 'MATA-UTU - WALLIS-ET-FUTUNA 98600 UVEA'),
    ('justice_tj_1_222', 'Tribunal de Première Instance de Papeete', 'PAPEETE', array['tpi-papeete@justice.fr']::text[], '42 AVENUE POUVANA''A A OOPA TAHITI POLYNESIE FRANCAISE 98714 PAPEETE'),
    ('justice_tj_1_223', 'Tribunal de Première Instance de Nouméa', 'NOUMEA', array['accueil.tpi-noumea@justice.fr']::text[], 'RUE DE METZ 98800 NOUMEA'),
    ('justice_tj_1_39', 'Tribunal judiciaire de Bourg-en-Bresse', 'BOURG EN BRESSE', array['accueil-bourg-en-bresse@justice.fr']::text[], '32 AVENUE ALSACE LORRAINE 01000 BOURG EN BRESSE'),
    ('justice_tj_1_40', 'Tribunal judiciaire de Laon', 'LAON', array['accueil-laon@justice.fr']::text[], 'PLACE AUBRY 02000 LAON'),
    ('justice_tj_1_41', 'Tribunal judiciaire de Saint-Quentin', 'ST QUENTIN', array['accueil-st-quentin@justice.fr']::text[], 'PLACE GRACCHUS BABEUF 02100 ST QUENTIN'),
    ('justice_tj_1_42', 'Tribunal judiciaire de Soissons', 'SOISSONS', array['tj-soissons@justice.fr']::text[], '76 RUE SAINT-MARTIN 02200 SOISSONS'),
    ('justice_tj_1_43', 'Tribunal judiciaire de Cusset', 'CUSSET', array['accueil.tj-cusset@justice.fr']::text[], 'RUE DU DRAPEAU 03300 CUSSET'),
    ('justice_tj_1_44', 'Tribunal judiciaire de Montluçon', 'MONTLUCON', array['accueil-montlucon@justice.fr']::text[], '114 BOULEVARD DE COURTAIS 03100 MONTLUCON'),
    ('justice_tj_1_45', 'Tribunal judiciaire de Moulins', 'MOULINS', array['accueil-moulins@justice.fr']::text[], '20 RUE DE PARIS 03000 MOULINS'),
    ('justice_tj_1_46', 'Tribunal judiciaire de Digne-les-Bains', 'DIGNE LES BAINS', array['accueil-digne-les-bains@justice.fr']::text[], '6 PLACE DES RECOLLETS 04000 DIGNE LES BAINS'),
    ('justice_tj_1_47', 'Tribunal judiciaire de Gap', 'GAP', array['accueil-gap@justice.fr']::text[], 'PLACE SAINT-ARNOUX 05000 GAP'),
    ('justice_tj_1_48', 'Tribunal judiciaire de Grasse', 'GRASSE', array['accueil-grasse@justice.fr']::text[], '37 AVENUE PIERRE SEMARD 06130 GRASSE'),
    ('justice_tj_1_49', 'Tribunal judiciaire de Nice', 'NICE', array['accueil-nice@justice.fr']::text[], 'PLACE DU PALAIS DE JUSTICE 06300 NICE'),
    ('justice_tj_1_50', 'Tribunal judiciaire de Privas', 'PRIVAS', array['tj1-privas@justice.fr']::text[], '10 COURS DU PALAIS 07000 PRIVAS'),
    ('justice_tj_1_51', 'Tribunal judiciaire de Charleville-Mézières', 'CHARLEVILLE MEZIERES', array['tj-charleville-mezieres@justice.fr']::text[], '9 ESPLANADE ROBERT BADINTER FRANCE 08000 CHARLEVILLE MEZIERES'),
    ('justice_tj_1_52', 'Tribunal judiciaire de Foix', 'FOIX', array['accueil.tj-foix@justice.fr']::text[], '14 BOULEVARD DU SUD 09000 FOIX'),
    ('justice_tj_1_53', 'Tribunal judiciaire de Troyes', 'TROYES', array['tj-troyes@justice.fr']::text[], '83 RUE DU GENERAL DE GAULLE 10000 TROYES'),
    ('justice_tj_1_54', 'Tribunal judiciaire de Carcassonne', 'CARCASSONNE', array['accueil-carcassonne@justice.fr']::text[], '28 BOULEVARD JEAN-JAURES 11000 CARCASSONNE'),
    ('justice_tj_1_55', 'Tribunal judiciaire de Narbonne', 'NARBONNE', array['accueil-narbonne@justice.fr']::text[], '19 BD DU GENERAL DE GAULLE 11100 NARBONNE'),
    ('justice_tj_1_57', 'Tribunal judiciaire de Rodez', 'RODEZ', array['accueil-rodez@justice.fr']::text[], 'BOULEVARD DE GUIZARD 12000 RODEZ'),
    ('justice_tj_1_58', 'Tribunal judiciaire d''Aix-en-Provence', 'AIX EN PROVENCE', array['tj1-aix-en-provence@justice.fr']::text[], '40 BOULEVARD CARNOT 13100 AIX EN PROVENCE'),
    ('justice_tj_1_59', 'Tribunal judiciaire de Marseille', 'MARSEILLE', array['accueil-marseille@justice.fr']::text[], '6 RUE JOSEPH AUTRAN 13006 MARSEILLE'),
    ('justice_tj_1_60', 'Tribunal judiciaire de Tarascon', 'TARASCON', array['accueil-tarascon@justice.fr']::text[], '28 ALLEE DU GL JENNINGS KILMAINE 13150 TARASCON'),
    ('justice_tj_1_61', 'Tribunal judiciaire de Caen', 'CAEN', array['accueil-caen@justice.fr']::text[], '11 RUE DUMONT D''URVILLE 14000 CAEN'),
    ('justice_tj_1_62', 'Tribunal judiciaire de Lisieux', 'LISIEUX', array['accueil-lisieux@justice.fr']::text[], '11 RUE D''ORIVAL 14100 LISIEUX'),
    ('justice_tj_1_63', 'Tribunal judiciaire d''Aurillac', 'AURILLAC', array['accueil.aurillac@justice.fr']::text[], '21 PLACE DU SQUARE 15000 AURILLAC'),
    ('justice_tj_1_64', 'Tribunal judiciaire d''Angoulême', 'ANGOULEME', '{}'::text[], 'PLACE FRANCIS LOUVEL 16000 ANGOULEME'),
    ('justice_tj_1_66', 'Tribunal judiciaire de La Rochelle', 'LA ROCHELLE', array['accueil-la-rochelle@justice.fr']::text[], '10 RUE DU PALAIS 17000 LA ROCHELLE'),
    ('justice_tj_1_67', 'Tribunal judiciaire de Saintes', 'SAINTES', array['accueil.tj-saintes@justice.fr']::text[], 'SQUARE MARECHAL FOCH 17100 SAINTES'),
    ('justice_tj_1_68', 'Tribunal judiciaire de Bourges', 'BOURGES', array['accueil-bourges@justice.fr']::text[], '8 RUE DES ARENES 18000 BOURGES'),
    ('justice_tj_1_69', 'Tribunal judiciaire de Brive-la-Gaillarde', 'BRIVE LA GAILLARDE', array['accueil-brive-la-gaillarde@justice.fr']::text[], 'BOULEVARD DU MARECHAL LYAUTEY 19100 BRIVE LA GAILLARDE'),
    ('justice_tj_1_71', 'Tribunal judiciaire d''Ajaccio', 'AJACCIO', array['accueil.tj-ajaccio@justice.fr']::text[], '4 BOULEVARD MASSERIA 20090 AJACCIO'),
    ('justice_tj_1_72', 'Tribunal judiciaire de Bastia', 'BASTIA', array['accueil-bastia@justice.fr']::text[], 'ROND-POINT DE MORO GIAFFERI 20200 BASTIA'),
    ('justice_tj_1_73', 'Tribunal judiciaire de Dijon', 'DIJON', array['accueil-dijon@justice.fr']::text[], '13 BOULEVARD CLEMENCEAU 21000 DIJON'),
    ('justice_tj_1_76', 'Tribunal judiciaire de Saint-Brieuc', 'ST BRIEUC', array['tj1-st-brieuc@justice.fr']::text[], 'PARC DES PROMENADES 22000 ST BRIEUC'),
    ('justice_tj_1_77', 'Tribunal judiciaire de Guéret', 'GUERET', array['tj-gueret@justice.fr']::text[], '23 PLACE BONNYAUD 23000 GUERET'),
    ('justice_tj_1_80', 'Tribunal judiciaire de Besançon', 'BESANCON', array['tj1-besancon@justice.fr']::text[], '1 RUE MEGEVAND 25000 BESANCON'),
    ('justice_tj_1_81', 'Tribunal judiciaire de Montbéliard', 'MONTBELIARD', array['accueil-montbeliard@justice.fr']::text[], 'RUE WOLFGANG AMADEUS MOZART 25200 MONTBELIARD'),
    ('justice_tj_1_82', 'Tribunal judiciaire de Valence', 'VALENCE', array['accueil-valence@justice.fr']::text[], '2 PLACE SIMONE VEIL 26000 VALENCE'),
    ('justice_tj_1_84', 'Tribunal judiciaire d''Evreux', 'EVREUX', array['tj-evreux@justice.fr']::text[], '30 RUE JOSEPHINE 27000 EVREUX'),
    ('justice_tj_1_85', 'Tribunal judiciaire de Chartres', 'CHARTRES', array['tj1-chartres@justice.fr']::text[], '3 RUE SAINT-JACQUES 28000 CHARTRES'),
    ('justice_tj_1_86', 'Tribunal judiciaire de Brest', 'BREST', array['tj1-brest@justice.fr']::text[], '32 RUE DE DENVER 29200 BREST'),
    ('justice_tj_1_88', 'Tribunal judiciaire de Quimper', 'QUIMPER', array['tj-quimper@justice.fr']::text[], '48 A QUAI DE L''ODET 29000 QUIMPER'),
    ('justice_tj_1_89', 'Tribunal judiciaire d''Alès', 'ALES', array['accueil-ales@justice.fr']::text[], '3 PLACE HENRI BARBUSSE 30100 ALES'),
    ('justice_tj_1_90', 'Tribunal judiciaire de Nîmes', 'NIMES', array['accueil-nimes@justice.fr']::text[], 'BOULEVARD DES ARENES 30000 NIMES'),
    ('justice_tj_1_92', 'Tribunal judiciaire de Toulouse', 'TOULOUSE', array['accueil1.tj-toulouse@justice.fr']::text[], '2 ALLEE JULES GUESDE 31000 TOULOUSE'),
    ('justice_tj_1_93', 'Tribunal judiciaire d''Auch', 'AUCH', array['tj-auch@justice.fr']::text[], 'ALLEE D''ETIGNY 32000 AUCH'),
    ('justice_tj_1_96', 'Tribunal judiciaire de Béziers', 'BEZIERS', '{}'::text[], '93 AVENUE DU PRESIDENT WILSON 34500 BEZIERS'),
    ('justice_tj_1_97', 'Tribunal judiciaire de Montpellier', 'MONTPELLIER', array['accueil.tj-montpellier@justice.fr']::text[], 'PLACE PIERRE FLOTTE 34000 MONTPELLIER'),
    ('justice_tj_1_98', 'Tribunal judiciaire de Rennes', 'RENNES', array['accueil.tj-rennes@justice.fr']::text[], '7 RUE PIERRE ABELARD 35000 RENNES'),
    ('justice_tj_1_99', 'Tribunal judiciaire de Saint-Malo', 'ST MALO', array['accueil-tj-malo@justice.fr']::text[], '49 AVENUE ARISTIDE BRIAND 35400 ST MALO'),
    ('justice_tj_9_15273', 'Tribunal judiciaire de Paris', 'PARIS', array['accueil-paris@justice.fr']::text[], '29-45 AVENUE DE LA PORTE DE CLICHY 75017 PARIS'),
    ('justice_tj_9_41809', 'Tribunal judiciaire de Mamoudzou', 'MAMOUDZOU', array['accueil.tj-mamoudzou@justice.fr']::text[], 'ROUTE NATIONALE 1 KAWENI 97600 MAMOUDZOU'),
    ('justice_tj_9_48312', 'Tribunal judiciaire de Saumur', 'SAUMUR', array['tj-saumur@justice.fr']::text[], 'PLACE SAINT-MICHEL 49400 SAUMUR'),
    ('justice_tj_9_48313', 'Tribunal judiciaire de St Gaudens', 'ST GAUDENS', array['accueil.tj-st-gaudens@justice.fr']::text[], 'PLACE DU PALAIS 31800 ST GAUDENS'),
    ('justice_tj_9_48314', 'Tribunal judiciaire de Tulle', 'TULLE', array['accueil-tulle@justice.fr']::text[], '9 QUAI GABRIEL PERI 19000 TULLE'),
    ('justice_tj_9_7677', 'Tribunal de Première Instance de Saint-Pierre-et-Miquelon', 'ST PIERRE ET MIQUELON', '{}'::text[], '14 RUE EMILE SASCO 97500 ST PIERRE ET MIQUELON'),
    ('libourne', 'Tribunal judiciaire de Libourne', 'LIBOURNE', array['accueil-libourne@justice.fr']::text[], '22 RUE THIERS 33500 LIBOURNE'),
    ('mont_de_marsan', 'Tribunal judiciaire de Mont-de-Marsan', 'MONT DE MARSAN', array['tj-mont-de-marsan@justice.fr']::text[], '249 AVENUE DU COLONEL ROZANOFF 40000 MONT DE MARSAN'),
    ('pau', 'Tribunal judiciaire de Pau', 'PAU', array['tj-pau@justice.fr']::text[], 'PLACE DE LA LIBERATION 64000 PAU'),
    ('perigueux', 'Tribunal judiciaire de Périgueux', 'PERIGUEUX', array['accueil.tj-perigueux@justice.fr']::text[], '19 BIS BOULEVARD MONTAIGNE 24000 PERIGUEUX')
) as contact (court_code, name, city, emails, address)
on conflict (court_code) do update
  set name = excluded.name,
      city = excluded.city,
      emails = excluded.emails,
      address = excluded.address,
      source = excluded.source,
      imported_at = now();

notify pgrst, 'reload schema';

commit;
