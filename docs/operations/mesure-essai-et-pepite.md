# Mesure de l'essai de 7 jours et de la pépite

Source : compte-rendu du 27/10/2026 (n° 89), rapports `analyste-indicateurs` et `suivi-experiences`.
Document de lecture pour le propriétaire : il dit **quoi regarder, avec quelle requête, et ce qui
décide quoi**, avant de voir les chiffres. Les requêtes sont en lecture seule (agrégats, aucun email
ni identifiant en sortie) ; elles se lancent depuis l'éditeur SQL de Supabase, jamais depuis un
agent.

## Ce qu'on peut juger, et ce qu'on ne peut pas

- Aucun test A/B n'est faisable : trop peu de trafic (de l'ordre de 300 à 1 100 comptes par groupe
  pour déceler 5 à 10 points d'écart), pas de mécanisme de variante, et deux durées d'essai
  seraient des conditions commerciales différentes (avis `juridique-rgpd` nécessaire). La mesure
  est **descriptive**, par cohorte.
- Le retour d'un compte à J+7 ou J+30 n'existe nulle part : `last_sign_in_at` est écrasé à chaque
  connexion, Vercel Analytics est sans identifiant, Google Analytics ne voit que les consentants.
  Le substitut est l'activité enregistrée par compte (`account_product_events`, 5 types plus
  `pepite_detail_served` depuis la migration `20261108180000`), les alertes et les favoris.
- Naviguer sur `/sales` sans ouvrir de fiche ne laisse aucune trace par compte.
- Les comptes en essai ne consomment aucun déblocage : « 3 déblocages par mois » ne se compare ni
  entre cohortes avant et après l'essai, ni pendant l'essai.
- Aucun groupe témoin : aucun effet causal de l'essai ou de la pépite sur l'intérêt pour l'offre
  Analyse ne peut être affirmé.
- `account_product_events` et `sale_signal_feedback` sont purgés à 90 jours : suffisant pour un
  bilan à 30 jours, pas pour un suivi plus long. Exporter les agrégats à la main avant.

## Cohortes

- **Cohorte** = comptes dont l'adresse a été confirmée (`auth.users.email_confirmed_at`) à partir du
  **26/10/2026 à 0 h (heure de Paris)**, regroupés par **semaine de confirmation** (lundi à
  dimanche, heure de Paris). La confirmation, et non la création, démarre l'essai.
- Avant cette date, ne rien comparer : l'offre de lancement sans durée (19/10), puis les fins
  immédiates de la migration `20261103100000` (les comptes confirmés depuis plus de 7 jours à son
  application ont perdu l'accès aussitôt) faussent toute comparaison. **Le propriétaire confirme la
  date d'application en production de cette migration** et la met dans `:cutover` si elle est
  postérieure au 26/10.
- Sont exclus : les administrateurs (`user_profiles.user_role = 'admin'`) et les comptes de test.
  Le motif d'adresse des comptes de test est à donner par le propriétaire (aucun n'est supposé ici).
- **Effectifs bruts.** Sous 30 comptes confirmés dans la cohorte (`PILOTAGE_MIN_ACCOUNTS`), on note
  les nombres, jamais un pourcentage, et on ne conclut rien. Un nombre inférieur à 5 est masqué dans
  le Pilotage ; dans une note, on l'écrit « moins de 5 ».

## Indicateurs

| Indicateur                | Définition exacte                                                                                         | Source                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Confirmation              | comptes confirmés / comptes créés, par semaine de création                                                | `auth.users`                                                |
| Activation                | comptes avec au moins un événement dans les 7 jours après la confirmation                                 | `account_product_events`, `user_alerts`, `user_favorites`   |
| Profondeur                | comptes avec au moins 3 fiches distinctes dont la valeur de référence a été servie ; avec alerte ; favori | idem                                                        |
| Travail délibéré          | comptes avec au moins un plafond enregistré dans « Mon dossier » (`bid_ceiling_saved_at`)                 | `user_favorites`                                            |
| Persistance après l'essai | comptes avec au moins un événement entre J+8 et J+14, et après J+14 (substitut, pas une rétention)        | `account_product_events`                                    |
| Intérêt pour l'offre      | comptes qui demandent à être prévenus dans les 14 jours ; comptes dont l'essai a été prolongé             | `offer_opening_notifications`, `user_subscriptions`         |
| Pépite : exposition       | `pepite_block_viewed` (verrouillé / détail) ; nombre de pépites publiées                                  | Vercel Analytics ; `auction_sale_pepites`                   |
| Pépite : ouverture        | comptes distincts avec `pepite_detail_served` / comptes éligibles                                         | `account_product_events`                                    |
| Pépite : filtre           | `pepite_filter_used` / pages vues de `/sales`                                                             | Vercel Analytics                                            |
| Pépite : jugement         | « Utile » / « Pas pertinent », motifs, version de la règle ; par vente pour les retours négatifs          | `/admin/pilotage`, `/admin/pepites`, `sale_signal_feedback` |
| Pépite : alertes          | alertes `pepite_only` ; envois dont `pepiteMentioned` est vrai                                            | `user_alerts`, `user_alert_notifications`                   |
| Accueil → inscription     | `/` → `home_example_used` → `/annonce-exemple` → `signup_submitted` (par `entry`) → `signup_confirmed`    | Vercel Analytics (agrégé, pas de suivi d'une même personne) |

Le libellé du Pilotage « Fiches avec valeur de référence servie » (ancien « Plafonds d'enchère
calculés ») compte les fiches ouvertes par un compte Analyse, essai compris : ce n'est pas un
plafond travaillé. Le travail délibéré se lit dans les plafonds enregistrés (colonne « Plafonds »
de la vue Inscriptions).

## Requête A : cohorte de l'essai, par semaine de confirmation

Adaptée de la requête d'`analyste-indicateurs` : cohortes par semaine, plafond enregistré, détail
de pépite ouvert. À lancer avec un rôle qui peut appeler `public.get_signup_trial_end` (éditeur SQL
de Supabase). Remplacer `:cutover` par `'2026-10-26 00:00:00+01'` (ou la date d'application de la
migration `20261103100000` si elle est postérieure).

```sql
with cohort as (
  select u.id,
         u.email_confirmed_at as t0,
         date_trunc('week', u.email_confirmed_at at time zone 'Europe/Paris')::date as week,
         public.get_signup_trial_end(u.id) as trial_end
  from auth.users u
  where u.email_confirmed_at >= :cutover
    and not exists (select 1 from public.user_profiles p
                    where p.user_id = u.id and p.user_role = 'admin')
    -- Exclure ici les comptes de test (motif d'adresse à fournir par le propriétaire).
),
act as (
  select c.id,
    bool_or(e.occurred_at <  c.t0 + interval '7 days')                                  as a_essai,
    bool_or(e.occurred_at >= c.t0 + interval '7 days'
        and e.occurred_at <  c.t0 + interval '14 days')                                 as a_j8_14,
    bool_or(e.occurred_at >= c.t0 + interval '14 days')                                 as a_apres_14,
    count(distinct e.sale_id) filter (where e.event_type = 'bid_ceiling_calculated'
        and e.occurred_at < c.t0 + interval '7 days')                                   as fiches,
    bool_or(e.event_type = 'pepite_detail_served'
        and e.occurred_at < c.t0 + interval '7 days')                                   as pepite_ouverte
  from cohort c
  left join public.account_product_events e
    on e.user_id = c.id and e.occurred_at >= c.t0
  group by c.id
)
select c.week                                                         as semaine_de_confirmation,
  count(*)                                                            as confirmes,
  count(*) filter (where c.trial_end is not null)                     as avec_essai,
  count(*) filter (where a.a_essai)                                   as actifs_pendant_essai,
  count(*) filter (where a.fiches >= 3)                               as au_moins_3_fiches,
  count(*) filter (where a.pepite_ouverte)                            as detail_pepite_ouvert,
  count(*) filter (where exists (
      select 1 from public.user_favorites f
      where f.user_id = c.id and f.bid_ceiling_saved_at is not null
        and f.bid_ceiling_saved_at < c.t0 + interval '7 days'))       as plafond_enregistre,
  count(*) filter (where exists (
      select 1 from public.user_alerts al
      where al.user_id = c.id and al.created_at >= c.t0
        and al.created_at < c.t0 + interval '7 days'))                as avec_alerte,
  count(*) filter (where a.a_j8_14)                                   as actifs_j8_j14,
  count(*) filter (where a.a_apres_14)                                as actifs_apres_j14,
  count(*) filter (where exists (
      select 1 from public.offer_opening_notifications o
      where o.user_id = c.id and o.consented_at >= c.t0))             as demande_ouverture,
  count(*) filter (where exists (
      select 1 from public.user_subscriptions s
      where s.user_id = c.id
        and s.metadata -> 'manual_grant' ->> 'source' = 'admin_trial_extension')) as prolonges
from cohort c
join act a using (id)
group by c.week
order by c.week;
```

Limites : « actif » ne couvre que les types d'événements enregistrés ; un événement est gardé une
fois par jour, compte et vente ; une prolongation écrase la précédente (`manual_grant` ne garde que
la dernière), donc on compte des comptes prolongés, pas des prolongations. Un comptage « actifs
J+8 à J+14 » d'un compte dont l'essai a été prolongé n'est pas comparable : le noter à part.

## Requête B : pépite

```sql
-- Retours par motif et par version de règle (la version est celle de la ligne de la vente à la lecture).
select f.value, f.reason, coalesce(p.rule_version, 'unknown') as rule_version,
       count(*) as n, count(distinct f.user_id) as comptes
from public.sale_signal_feedback f
left join public.auction_sale_pepites p on p.sale_id = f.sale_id
where f.signal = 'pepite' and f.created_at >= :debut
  and not exists (select 1 from public.user_profiles pr
                  where pr.user_id = f.user_id and pr.user_role = 'admin')
group by 1, 2, 3;

-- Alertes créées depuis « Pépites seulement » (clé advanced_criteria.pepite_only).
select count(*) as alertes, count(distinct user_id) as comptes
from public.user_alerts
where advanced_criteria ->> 'pepite_only' = 'true' and created_at >= :debut;

-- Envois qui portaient réellement la mention « Pépite » (champ journalisé depuis le 28/10/2026 ;
-- avant, la mention retirée à l'envoi restait dans le résumé d'origine : ne pas l'utiliser).
select count(*) filter (where notification_snapshot -> 'emailDelivery' ->> 'pepiteMentioned' = 'true')
         as envois_avec_mention,
       count(*) as envois
from public.user_alert_notifications
where delivery_status = 'sent' and sent_at >= :debut
  and notification_snapshot -> 'emailDelivery' ? 'pepiteMentioned';
```

Pour les erreurs signalées sur une vente précise, utiliser les tableaux « Retours "Pas pertinent" »
de `/admin/pepites` et de `/admin/quality`, pas SQL.

## Règle de décision, fixée d'avance

**À valider par le propriétaire avant de regarder les chiffres** : écrire ici la date de
validation et, s'il change un seuil, la valeur retenue. Date de validation : \_\_\_\_\_\_\_\_.

1. **Rien ne se décide sous 30 comptes confirmés dans une cohorte.** On note les effectifs bruts de
   la semaine dans `docs/equipe/` (hypothèse, période, effectifs, décision, date de relecture), même
   quand la décision est « ne rien changer ».
2. **Durée de l'essai (7 jours).** Elle n'est rediscutée que si, sur une cohorte d'au moins 30
   comptes confirmés, **moins de 1 compte sur 5** a une activité entre J+8 et J+14. Dans ce cas, et
   dans ce cas seulement, on étudie un rappel ou une durée plus longue ; la décision revient au
   fondateur, après avis de `juridique-rgpd` (les CGV écrivent « 7 jours » et leur empreinte est
   ancrée). Au-dessus du seuil : on garde 7 jours. Pas de test de deux durées.
3. **Activation.** Si, sur une cohorte d'au moins 30 comptes, **moins de 1 compte sur 3** ouvre au
   moins 3 fiches (valeur de référence servie) ou enregistre un plafond dans les 7 jours, on revoit
   le chemin d'arrivée (onboarding, premier plafond) avant toute autre chose, pas la durée.
4. **Pépite : jugement.** Rien ne se conclut sous **20 retours** « Utile / Pas pertinent » toutes
   versions confondues. Au-delà : si « Pas pertinent » dépasse la moitié des retours, ou si un
   même motif d'erreur (« Un critère est faux ») revient sur **3 ventes différentes**, on suspend
   la discussion d'ouverture et on corrige d'abord les ventes en cause (rituel hebdomadaire).
   Une vente avec un seul retour « Un critère est faux » est traitée le jour même (erreur de
   donnée, voir le runbook).
5. **Accueil.** Jamais conclu sur un taux tant que les visiteurs de `/` se comptent en centaines :
   on décrit `home_example_used` / pages vues de `/` et `signup_submitted` / pages vues de `/`
   (Vercel Analytics, visiteurs non opposés) sur 4 semaines pleines, sans comparaison avec
   l'ancien accueil (confondu avec l'essai). Les séances qualitatives (voir
   `docs/operations/etude-utilisateurs.md`) donnent les problèmes d'usage, pas un taux.

## Qui relit quand

- Le lundi, dans le rituel de [la synthèse hebdomadaire des retours](../runbooks/synthese-hebdomadaire-retours.md).
- La vue « Inscriptions » (colonnes d'usage, filtre « essai fini sans activité ») sert à choisir
  des comptes à qui écrire : **jamais pour joindre quelqu'un qui n'a pas donné son accord** à un
  entretien (case dédiée, finalité élargie). Sans accord, on ne contacte pas.
