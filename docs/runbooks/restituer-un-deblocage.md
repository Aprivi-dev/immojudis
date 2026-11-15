# Restituer un déblocage de vente

Depuis la migration `20261120100000_free_account_single_sale_unlock.sql` (décision du propriétaire du
15/11/2026), un compte gratuit (Découverte) a **un déblocage en tout**, sans remise à zéro mensuelle. Le
déblocage reste valable tant que la vente est en ligne, **24 mois au plus** ; après 24 mois il ne compte plus
et un déblocage redevient disponible.

La restitution suit l'article 2 des conditions générales (à relire dans leur version en vigueur) : le
déblocage est rendu automatiquement quand la vente est retirée (ci-dessous), et à la main quand Immojudis
retire elle-même la vente ou en suspend la publication pour une raison qui lui est imputable (erreur de
publication, suspension d'une source décidée par Immojudis). Une demande est adressée à l'email de contact
publié (voir `legalValue(publisher.contactEmail)` dans
`src/routes/conditions-generales.tsx`) ; la réponse est due **sous un mois**.

## Déblocage acheté ou ouvert par un crédit

Depuis la migration `20261122100000_sale_unlock_purchases.sql` (lot 3), un compte gratuit qui a utilisé son
déblocage gratuit peut acheter le déblocage d'une autre vente (19 € TTC). La colonne
`user_sale_unlocks.source` distingue `free` (le déblocage gratuit), `purchase` (vente achetée) et `credit`
(vente ouverte par un crédit) ; `purchase_id` renvoie à `public.sale_unlock_purchases`. **Cette procédure ne
s'applique qu'aux lignes `free`** : `release_sale_unlock` refuse les autres (`outcome: not_free`) et ne
change rien.

- Vente achetée puis passée au statut `withdrawn` : l'achat redevient automatiquement un **crédit**
  (`app_private.sale_unlock_credit_purchases`), que le compte utilise pour débloquer une autre vente. Rien à
  faire, pas de remboursement. Le crédit survit à la suppression de la vente retirée (voir ci-dessous).
- Vente plus débloquable ou déjà débloquée au moment du paiement, ou compte devenu abonné Analyse entre-temps :
  le paiement laisse un crédit, de même.
- Remboursement total ou litige perdu : se fait dans Stripe ; le webhook appelle
  `public.record_sale_unlock_payment_state`, qui supprime le déblocage de l'achat ou éteint son crédit.
  Un litige ouvert ferme la vente jusqu'à sa clôture ; un litige gagné la rouvre.
- Ne jamais supprimer à la main une ligne `purchase` ou `credit`, ni modifier `sale_unlock_purchases` :
  l'état de l'achat suit Stripe.

## Restitution automatique : la vente est retirée

Une ligne de `public.user_sale_unlocks` dont la vente a `auction_sales.status = 'withdrawn'` ne compte plus
dans les déblocages utilisés (`app_private.sale_unlocks_used`, qui lit `app_private.sale_is_withdrawn`). Le
compte peut donc débloquer une autre vente sans rien demander. La ligne n'est pas supprimée tant que la
vente existe. Quand la vente retirée est supprimée (purge de rétention `purge_expired_auction_sales`,
nettoyage des annonces vides), le déclencheur `auction_sales_release_withdrawn_unlocks`
(`20261122100000`) supprime d'abord ses lignes de déblocage, de toute source : le déblocage gratuit reste
rendu et un achat reste un crédit. Une vente supprimée sans être `withdrawn` ne rend rien : sa ligne est
détachée (`sale_id` vide) et compte jusqu'à ses 24 mois.

Aucune intervention n'est nécessaire dans ce cas. Si un compte écrit pour une vente retirée, vérifier le
statut de la vente (étape 1 ci-dessous) et lui répondre que le déblocage lui a déjà été rendu.

À savoir : si la vente revient ensuite dans le catalogue (statut qui quitte `withdrawn`), sa ligne compte de
nouveau. Le compte peut alors avoir deux déblocages comptés (celui de la vente revenue et celui pris entre-temps) ;
les deux ventes restent ouvertes, aucun nouveau déblocage n'est possible tant qu'ils comptent.

## Restitution manuelle : les autres cas

Il n'y a pas d'écran pour cela : la restitution se fait à la main, avec une fonction réservée au
`service_role`. Aucun navigateur ne peut l'appeler.

| Cas                                                                                        | Restitution                                                      |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Vente au statut `withdrawn`                                                                | Automatique : rien à faire                                       |
| Vente retirée ou publication suspendue **par Immojudis** sans passer au statut `withdrawn` | Oui, à la main : le déblocage est rendu, quelle que soit sa date |
| Vente reportée ou adjugée                                                                  | Non (article 2)                                                  |
| Panne technique pendant le déblocage                                                       | Rien à restituer : un déblocage en erreur n'est pas consommé     |

Restituer, c'est supprimer la ligne de `public.user_sale_unlocks` : le déblocage ne compte plus et la vente
se referme pour ce compte. Le compte peut débloquer une autre vente (ou la même, si elle est encore en ligne).

## Procédure

1. **Vérifier la demande.** L'adresse de l'expéditeur est celle du compte ? La vente a-t-elle été retirée
   ou suspendue par Immojudis ? Si elle est au statut `withdrawn`, le déblocage est déjà rendu : le dire au
   demandeur. Sinon, et si le cas n'ouvre pas droit à restitution, répondre par un refus motivé en citant
   l'article 2.
2. **Retrouver le déblocage.** Dans l'éditeur SQL Supabase (rôle `service_role`, lecture seule à cette
   étape) :

   ```sql
   select unlock_row.id, unlock_row.source, unlock_row.unlocked_at, unlock_row.sale_id, sale.title,
     sale.status
   from public.user_sale_unlocks unlock_row
   join auth.users account on account.id = unlock_row.user_id
   left join public.auction_sales sale on sale.id = unlock_row.sale_id
   where account.email = '<email du compte>'
   order by unlock_row.unlocked_at desc;
   ```

   Une ligne dont `sale_id` est vide correspond à une vente purgée : elle compte encore jusqu'à ses
   24 mois. Seule une ligne `source = 'free'` se restitue (voir « Déblocage acheté ou ouvert par un
   crédit »). Noter l'`id` de la ligne à restituer.

3. **Restituer** :

   ```sql
   select app_private.release_sale_unlock('<id du déblocage>');
   ```

   La fonction n'a plus de règle de mois (l'ancienne version `release_sale_unlock(uuid, timestamptz)` et son
   résultat `past_month` sont supprimés). Elle répond en JSON et ne fait rien d'autre :

   | `outcome`   | Signification                                                             |
   | ----------- | ------------------------------------------------------------------------- |
   | `released`  | La ligne est supprimée : le déblocage est de nouveau disponible.          |
   | `not_found` | Aucune ligne avec cet identifiant (déjà restitué, ou identifiant erroné). |
   | `not_free`  | Déblocage acheté ou par crédit : rien n'est changé (voir plus haut).      |

   L'appel est idempotent : le répéter ne restitue pas deux fois.

4. **Répondre au demandeur** (sous un mois) : restitution faite, ou refus motivé. Ne pas citer d'autres
   données du compte que la vente concernée.
5. **Garder une trace** de la demande (date, vente, issue) dans le registre de support, sans copier l'email
   au-delà de ce qui est nécessaire. Aucune table ne journalise la restitution : la ligne supprimée n'est pas
   conservée.

## Limites à connaître

- La fonction `release_sale_unlock(uuid)` et la restitution automatique sont créées par la migration
  `20261120100000_free_account_single_sale_unlock.sql`. Avant elle, la restitution passait par
  `release_sale_unlock(uuid, timestamptz)` et se limitait au mois du déblocage.
- Un déblocage de plus de 24 mois n'ouvre plus la vente, ne compte plus, et la purge nocturne
  (`app_private.purge_sale_unlocks`) supprime la ligne : il n'y a rien à restituer.
- Ne jamais modifier `user_sale_unlocks` autrement que par cette fonction (pas de `update` de `unlocked_at`
  pour « rendre » un crédit : le compteur dérive des lignes de moins de 24 mois).
