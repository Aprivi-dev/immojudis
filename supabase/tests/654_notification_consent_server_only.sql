-- Chantier R1, point 6 (migration 20261031100400) : la version du texte de consentement n'est plus
-- forgeable par le client, et l'activation des trois consentements (rappels d'audience, « Ma semaine »,
-- alerte de résultat) passe par la route serveur seule.
--   * droits : le rôle authenticated ne peut plus écrire (insert, update) les colonnes de ces trois
--     consentements ; il écrit encore le consentement aux alertes par email et le jour du récapitulatif ;
--     il lit sa ligne et peut la supprimer ; service_role écrit tout ;
--   * déclencheurs : ils ne prennent la version du texte que du rôle service_role (comportement vérifié
--     en écriture par les tests 550 et 630) ;
--   * anon n'a aucun droit sur la table.
begin;

select plan(17);

select ok(
  not has_column_privilege('authenticated', 'public.user_notification_preferences', c.name, 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_notification_preferences', c.name, 'INSERT'),
  'authenticated cannot write ' || c.name
)
from unnest(array[
  'sale_reminders_enabled', 'sale_reminders_consented_at', 'sale_reminders_revoked_at',
  'sale_reminders_consent_text_version',
  'weekly_digest_enabled', 'weekly_digest_consented_at', 'weekly_digest_revoked_at',
  'weekly_digest_consent_text_version',
  'sale_results_enabled', 'sale_results_consented_at', 'sale_results_revoked_at',
  'sale_results_consent_text_version'
]) as c(name);

select ok(
  has_column_privilege('authenticated', 'public.user_notification_preferences', 'alert_email_enabled', 'UPDATE')
  and has_column_privilege('authenticated', 'public.user_notification_preferences', 'alert_email_consented_at', 'UPDATE')
  and has_column_privilege('authenticated', 'public.user_notification_preferences', 'consent_source', 'UPDATE')
  and has_column_privilege('authenticated', 'public.user_notification_preferences', 'weekly_digest_weekday', 'UPDATE')
  and has_column_privilege('authenticated', 'public.user_notification_preferences', 'user_id', 'UPDATE')
  and has_column_privilege('authenticated', 'public.user_notification_preferences', 'alert_email_enabled', 'INSERT')
  and has_column_privilege('authenticated', 'public.user_notification_preferences', 'user_id', 'INSERT'),
  'authenticated still writes the email alert consent, the digest weekday and the owner column (upsert)'
);

select ok(
  has_table_privilege('authenticated', 'public.user_notification_preferences', 'SELECT')
  and has_table_privilege('authenticated', 'public.user_notification_preferences', 'DELETE'),
  'authenticated still reads its own row and can delete it (right to erasure)'
);

select ok(
  has_table_privilege('service_role', 'public.user_notification_preferences', 'INSERT')
  and has_table_privilege('service_role', 'public.user_notification_preferences', 'UPDATE'),
  'the server route (service role) writes every column'
);

select ok(
  not has_table_privilege('anon', 'public.user_notification_preferences', 'SELECT')
  and not has_table_privilege('anon', 'public.user_notification_preferences', 'INSERT')
  and not has_table_privilege('anon', 'public.user_notification_preferences', 'UPDATE'),
  'visitors have no access to the table'
);

select ok(
  pg_get_functiondef('app_private.enforce_sale_reminder_consent_proof()'::regprocedure) ~ 'service_role'
  and pg_get_functiondef('app_private.enforce_email_feature_consent_proof()'::regprocedure) ~ 'service_role',
  'both triggers keep the text version only from the service role'
);

select * from finish();
rollback;
