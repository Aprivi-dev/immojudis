begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R1, étape M3 (annexe 03, section 2 e). Rien ne change pour les fiches.
--
-- public.auction_sales.held_fields : les champs de la fiche tenus par une pièce acceptée, avec leur provenance
-- (pièce, décision, origine, rang, date de réception, tolérance, réglage) et le bloc « listing », dernière valeur
-- connue de l'annonce, qui sert à la restaurer quand la pièce est retirée. Un champ absent de held_fields vient
-- de l'annonce. Aucun extrait, aucun email, aucun nom. NULLE partout tant que le lot R2 n'a rien projeté : le
-- déclencheur de retenue (20261116100500) n'est alors jamais appelé (sa clause WHEN est fausse).
--
-- Colonne nulle, sans valeur par défaut : seul le catalogue change, sans réécriture de la table ni lecture de
-- raw_payload. Contrainte de forme posée NOT VALID ici (aucun parcours), validée par 20261116100400.
--
-- Aucun droit pour les rôles du navigateur : public.auction_sales n'est lisible par anon et authenticated que
-- colonne par colonne (20261010003000) et cette colonne n'est pas accordée ; elle est dans la liste des colonnes
-- internes de scripts/check-security-invariants.mjs. Seules app_private.project_sale_fields et la retenue
-- l'écrivent ; toute autre écriture est refusée (42501) par la base.
--
-- VERROU : ALTER TABLE ... ADD COLUMN prend un ACCESS EXCLUSIVE sur auction_sales jusqu'au COMMIT. Instantané une
-- fois obtenu, mais en file d'attente derrière un import il bloque AUSSI les lectures du site, jusqu'à 5 s
-- (lock_timeout) : la migration échoue alors sans effet, à relancer. À APPLIQUER HORS IMPORT.
--
-- Retour arrière (la colonne est vide tant que le lot R2 n'a rien écrit) : retirer d'abord 20261116100500
-- (déclencheurs et fonctions), puis
--   begin; set local lock_timeout = '5s';
--   alter table public.auction_sales drop column if exists held_fields;
--   commit;

alter table public.auction_sales
  add column if not exists held_fields jsonb;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.auction_sales'::regclass
      and constraint_row.conname = 'auction_sales_held_fields_shape'
  ) then
    alter table public.auction_sales
      add constraint auction_sales_held_fields_shape check (
        held_fields is null or jsonb_typeof(held_fields) = 'object'
      ) not valid;
  end if;
end;
$$;

comment on column public.auction_sales.held_fields is
  'Registre des pièces : champs de la fiche tenus par une pièce acceptée (provenance et dernière valeur connue de l''annonce). Nulle si aucun champ n''est tenu. Écrite seulement par app_private.project_sale_fields ; toute autre écriture d''un champ tenu est retenue par la base (déclencheur aaab_auction_sales_hold_projected_fields).';

notify pgrst, 'reload schema';

commit;
