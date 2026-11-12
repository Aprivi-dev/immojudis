-- 20261118100000 : le rôle lovable_readonly est supprimé. Sur la base éphémère de la CI il n'a jamais existé :
-- la migration n'y fait rien, et ce test garantit qu'aucune migration ne le crée ni ne lui réserve de droit.
-- Le chemin « rôle présent » (révocations, refus, suppression) se rejoue sur une base jetable :
-- docs/runbooks/suppression-role-lovable.md.
begin;

select plan(2);

select hasnt_role('lovable_readonly', 'le rôle lovable_readonly n''existe pas');

select is(
  (
    select count(*)
      from pg_catalog.pg_default_acl default_acl
     where default_acl.defaclacl::text like '%lovable_readonly%'
  ),
  0::bigint,
  'aucun privilège par défaut ne nomme lovable_readonly'
);

select * from finish();

rollback;
