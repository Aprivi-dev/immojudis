# Alerte `alerts.delivery.late` (avertissement)

Une notification d'alerte utilisateur est `queued` dans `user_alert_notifications` alors que sa date prévue
(`scheduled_for`, 07:00 UTC) a plus de **26 heures**. Les envois sont quotidiens : un retard normal reste
sous 24 h. Les utilisateurs ne reçoivent plus leurs alertes (dans l'application ou par e-mail).

Chaîne : `smart-alerts` (06:15, rattrapage 08:15) crée les correspondances et les notifications ;
`alert-notifications` (07:30, rattrapage 09:30, une heure après sur le plan Hobby) les envoie.

## Diagnostic

1. `select details from operational_alerts where alert_key = 'alerts.delivery.late';`
2. `select delivery_channel, count(*), min(scheduled_for) from user_alert_notifications
where delivery_status = 'queued' and scheduled_for < now() - interval '26 hours' group by 1;`
3. `select status, started_at, error_message, summary from operational_job_runs
where job_name in ('smart-alerts', 'alert-notifications') order by started_at desc limit 10;`
4. Depuis le 20/10, `alert-notifications` **échoue** (donc `cron.stale` finit par s'ouvrir) quand au moins un
   e-mail est dû et que l'envoi n'est pas configuré (`RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `SITE_URL` :
   l'erreur les nomme), ou quand 20 % des e-mails dus ont échoué. `smart-alerts` échoue quand 20 % des
   comptes analysés ont échoué.
5. Plus de 200 notifications dues à la fois (`ALERT_NOTIFICATION_CRON_LIMIT`) : le surplus attend le
   lendemain ; relever la limite.

## Actions

Configurer l'envoi (variables Vercel) ou corriger l'erreur de la route, puis appeler
`/api/cron/alert-notifications` avec `Authorization: Bearer $CRON_SECRET` : les notifications `queued`
dues partent. Ne pas passer les lignes à `sent` à la main.

## Fermeture

Automatique : plus aucune notification en file au-delà de 26 h, puis deux heures d'hystérésis.
