begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R1, étape M2b : valide la contrainte evidence_kind élargie par 20261116100100.
-- Parcourt public.auction_fact_claims sous SHARE UPDATE EXCLUSIVE : les lectures et les écritures continuent
-- (environ 17 000 lignes en production, moins d'une seconde attendue). Sans effet si elle est déjà valide.
-- Retour arrière : aucun (une contrainte valide est la forme voulue) ; voir 20261116100100.

alter table public.auction_fact_claims validate constraint auction_fact_claims_evidence_kind_check;

commit;
