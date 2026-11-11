begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R1, étape M3b : valide la contrainte de forme de public.auction_sales.held_fields
-- posée NOT VALID par 20261116100300. Parcourt la table sous SHARE UPDATE EXCLUSIVE : les lectures et les
-- écritures continuent (seul un autre ALTER TABLE ou VACUUM attend). La colonne est nulle partout, aucune ligne
-- ne peut échouer ; raw_payload n'est pas lu. Sans effet si la contrainte est déjà valide. Préférer tout de
-- même un moment sans import : le parcours lit toute la table.
-- Retour arrière : aucun (voir 20261116100300).

alter table public.auction_sales validate constraint auction_sales_held_fields_shape;

commit;
