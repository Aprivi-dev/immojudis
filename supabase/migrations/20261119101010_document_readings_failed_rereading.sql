begin;

set local lock_timeout = '5s';

-- Lecture des pièces : un échec de relecture d'une lecture terminée se trace à part (14/11/2026, état des lieux, D7).
--
-- Quand la relecture d'une lecture terminée échoue (réponse du modèle hors format, tous les points rejetés, panne),
-- la lecture terminée reste servie telle quelle : statut, points, empreinte et updated_at ne bougent pas
-- (services/data-pipeline/src/document_reading.py). Rien ne gardait la trace de l'échec : la vente revenait parmi les
-- candidates à chaque passage, et le modèle était payé à chaque fois. Ces colonnes la gardent ; la requête des
-- candidates attend alors comme pour une lecture en échec (12 h, 24 h, 72 h, abandon à la quatrième tentative), tant
-- que ni le texte des pièces ni la version de la lecture n'ont changé depuis. Un texte réécrit à l'identique (nouvelle
-- ligne pdf_text, même contenu) ramène la vente une fois : le pipeline compare l'empreinte sans appeler le modèle et
-- note la date du texte vu (failed_text_at), ce qui la sort des candidates.
--
-- Ajout de colonnes seulement, avec des valeurs par défaut : aucune ligne n'est réparée. Le code Python correspondant
-- lit et écrit ces colonnes : la migration s'applique aussitôt après la fusion (sans elle, la requête des candidates
-- échoue avant tout appel au modèle et la lecture des pièces s'arrête jusqu'à son application).
-- RETOUR ARRIÈRE : supprimer les six colonnes (le code précédent ne les lit pas).

alter table public.auction_document_readings
  add column if not exists failed_input_fingerprint text,
  add column if not exists failed_prompt_version text,
  add column if not exists failed_attempts integer not null default 0 check (failed_attempts >= 0),
  add column if not exists last_failed_at timestamptz,
  add column if not exists failed_text_at timestamptz,
  add column if not exists failed_error_code text;

comment on column public.auction_document_readings.failed_input_fingerprint is
  'Empreinte des pièces de la dernière relecture en échec d''une lecture terminée (la lecture servie reste l''ancienne).';
comment on column public.auction_document_readings.failed_prompt_version is
  'Version de la lecture de cette relecture en échec : une autre version relit sans attendre.';
comment on column public.auction_document_readings.failed_attempts is
  'Relectures en échec consécutives sur la même empreinte ; 0 dès qu''une lecture est écrite.';
comment on column public.auction_document_readings.last_failed_at is
  'Date de la dernière relecture en échec ; le délai d''attente se compte depuis elle.';
comment on column public.auction_document_readings.failed_text_at is
  'Date d''écriture (auction_extractions.updated_at) du texte des pièces vu au dernier échec ou au dernier saut : '
  'seul un texte écrit après elle ramène la vente parmi les candidates pendant l''attente.';
comment on column public.auction_document_readings.failed_error_code is
  'Code d''erreur de la dernière relecture en échec (le code de la lecture servie reste dans error_code).';

notify pgrst, 'reload schema';

commit;
