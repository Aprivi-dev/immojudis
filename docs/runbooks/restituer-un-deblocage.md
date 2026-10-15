# Restituer un déblocage de vente

Les conditions générales (article 2) promettent qu'un déblocage mensuel est **restitué sur simple
demande** quand Immojudis retire elle-même la vente ou en suspend la publication pour une raison qui
lui est imputable (erreur de publication, suspension d'une source décidée par Immojudis). La demande
est adressée à l'email de contact publié (voir `legalValue(publisher.contactEmail)` dans
`src/routes/conditions-generales.tsx`) ; la réponse est due **sous un mois**.

Il n'y a pas d'écran pour cela : la restitution se fait à la main, avec une fonction réservée au
`service_role`. Aucun navigateur ne peut l'appeler.

## Ce qui est restitué, et ce qui ne l'est pas

| Cas                                                                                  | Restitution                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Vente retirée ou publication suspendue **par Immojudis**, déblocage du mois en cours | Oui : le déblocage est rendu                                 |
| Demande reçue **après la fin du mois** du déblocage                                  | Non : « les déblocages ne sont pas reportés »                |
| Vente reportée ou adjugée, ou retirée par la juridiction ou par la source            | Non (article 2)                                              |
| Panne technique pendant le déblocage                                                 | Rien à restituer : un déblocage en erreur n'est pas consommé |

Restituer, c'est supprimer la ligne de `public.user_sale_unlocks` : le déblocage ne compte plus dans
le mois et la vente se referme pour ce compte. Le compte peut débloquer une autre vente (ou la même,
si elle est encore en ligne) avec le crédit rendu.

## Procédure

1. **Vérifier la demande.** L'adresse de l'expéditeur est celle du compte ? La vente a-t-elle été
   retirée ou suspendue par Immojudis (et non par la juridiction ou la source) ? Le déblocage date-t-il
   du mois en cours (heure de Paris) ? Sinon, répondre par un refus motivé en citant l'article 2.
2. **Retrouver le déblocage.** Dans l'éditeur SQL Supabase (rôle `service_role`, lecture seule à cette
   étape) :

   ```sql
   select unlock_row.id, unlock_row.unlocked_at, unlock_row.sale_id, sale.title
   from public.user_sale_unlocks unlock_row
   join auth.users account on account.id = unlock_row.user_id
   left join public.auction_sales sale on sale.id = unlock_row.sale_id
   where account.email = '<email du compte>'
   order by unlock_row.unlocked_at desc;
   ```

   Une ligne dont `sale_id` est vide correspond à une vente purgée : elle compte encore pour son mois.
   Noter l'`id` de la ligne à restituer.

3. **Restituer.**

   ```sql
   select app_private.release_sale_unlock('<id du déblocage>');
   ```

   La fonction répond en JSON et ne fait rien d'autre :

   | `outcome`    | Signification                                                               |
   | ------------ | --------------------------------------------------------------------------- |
   | `released`   | La ligne est supprimée : un déblocage est de nouveau disponible ce mois-ci. |
   | `past_month` | Le déblocage date d'un mois passé : rien n'est modifié (refus à notifier).  |
   | `not_found`  | Aucune ligne avec cet identifiant (déjà restitué, ou identifiant erroné).   |

   L'appel est idempotent : le répéter ne restitue pas deux fois.

4. **Répondre au demandeur** (sous un mois) : restitution faite, ou refus motivé. Ne pas citer d'autres
   données du compte que la vente concernée.
5. **Garder une trace** de la demande (date, vente, issue) dans le registre de support, sans copier
   l'email au-delà de ce qui est nécessaire. Aucune table ne journalise la restitution : la ligne
   supprimée n'est pas conservée.

## Limites à connaître

- La fonction est créée par la migration `20261025130100_sale_unlock_24_months_and_release.sql`. Tant
  qu'elle n'est pas appliquée, la restitution n'est pas possible par ce chemin.
- Un déblocage de plus de 24 mois n'ouvre plus la vente (même migration) et la purge nocturne
  (`app_private.purge_sale_unlocks`) supprime la ligne : il n'y a rien à restituer.
- Ne jamais modifier `user_sale_unlocks` autrement que par cette fonction (pas de `update` de
  `unlocked_at` pour « rendre » un crédit sur un autre mois : le compteur dérive des lignes du mois).
