# Conformité et gouvernance — phase 6

Ce document décrit les garanties techniques et la procédure opératoire de la phase 6. Il ne
constitue pas une validation juridique. L’ouverture du checkout exige une revue écrite des mentions,
CGVU, informations de rétractation et contrats de sous-traitance par un professionnel compétent.

## Critère de mise en vente

Le checkout est bloqué par `assertPaidOfferLegalReadiness` tant que les variables publiques
`NEXT_PUBLIC_LEGAL_*` requises ne sont pas toutes renseignées. Le même état est visible dans le
panneau de préparation administrateur et contrôlé par `npm run env:check:prod` lorsque Stripe est
activé.

Le canal transactionnel Resend est également obligatoire avant une vente. Une confirmation en échec
est journalisée puis retentée par le cron des notifications, jusqu’à huit tentatives espacées d’au
moins quinze minutes.

Les données à confirmer sont : identité ou raison sociale, forme juridique, adresse, immatriculation,
directeur de publication, email, téléphone et médiateur de la consommation. Le capital et le numéro
de TVA sont publiés lorsqu’ils sont applicables.

## Documents versionnés

Les versions et empreintes sont centralisées dans `src/lib/legal-documents.ts` :

| Document         | Route                   | Version en vigueur (14/10/2026) |
| ---------------- | ----------------------- | ------------------------------- |
| Mentions légales | `/legal`                | `2026-07-29.1`                  |
| CGVU             | `/conditions-generales` | `2026-10-14.1`                  |
| Confidentialité  | `/privacy`              | `2026-10-13.2`                  |

Toute modification substantielle crée une nouvelle version, une nouvelle empreinte et une date
d’effet. Les empreintes correspondent aux sources des pages publiées et sont contrôlées par un test
automatique ; une acceptation antérieure n’est jamais réécrite.

## Commande Analyse

Avant Stripe, l’utilisateur voit le produit, le prix TTC, la périodicité mensuelle, le renouvellement
jusqu’à résiliation, l’essai éventuel et deux consentements distincts. Le récapitulatif doit être
relu avec la qualification « durée indéterminée » des CGV (voir la validation attendue ci-dessous). Le bouton final porte la mention « Commander avec obligation de
paiement ».

Chaque passage crée une ligne `commercial_acceptances` liée à la Checkout Session. Elle contient les
versions et empreintes documentaires, le prix, les reconnaissances, la date serveur et uniquement des
empreintes de l’email et du user-agent. Le trigger interdit la modification ; la preuve minimale est
isolée du compte et supprimée par le cron après dix ans.

## Exercice des droits

Le portail `/mes-droits` accepte les demandes d’accès, portabilité, rectification, effacement,
limitation, opposition, retrait de consentement et rétractation. L’authentification suffit par défaut
à établir l’identité. Une vérification supplémentaire n’est demandée qu’en cas de doute raisonnable.

Chaque demande reçoit :

- un identifiant stable ;
- un accusé d’enregistrement immédiat dans l’interface ;
- une échéance d’un mois ;
- un statut visible par l’utilisateur ;
- un suivi opérateur dans l’administration.

### Procédure opérateur

1. Ouvrir le panneau « Demandes RGPD et rétractations » au moins chaque semaine.
2. Passer la demande à `in_review`, ou à `identity_verification` si l’identité est réellement douteuse.
3. Rechercher les données du seul utilisateur concerné ; exclure les données de tiers et secrets.
   Pour une demande d’accès ou de portabilité, la copie comprend les déblocages de ventes de l’offre
   Découverte (table `user_sale_unlocks` : vente, date) en plus des favoris, alertes et rapports.
4. Exécuter le droit demandé ou documenter le motif légal d’une limitation/refus.
5. Pour un effacement, supprimer d’abord les objets Storage via l’API Storage, puis le compte Auth ;
   les clés étrangères `on delete cascade` retirent les espaces personnels.
6. Pour une rétractation, vérifier la date et l’usage, calculer le cas échéant la part de service déjà
   fournie, traiter le remboursement dans Stripe et révoquer l’accès via le cycle de paiement existant.
7. Clôturer la demande avec un code de résolution et notifier l’utilisateur sur un support durable.

### Restitution d’un déblocage de vente (procédure manuelle)

Les CGV (§ 2) prévoient la restitution d’un déblocage, sur simple demande, lorsqu’Immojudis retire
elle-même la vente ou en suspend la publication pour une raison qui lui est imputable (erreur de
publication, mise en quarantaine ou retrait de la source décidés par Immojudis, mise en attente de la
vente). Il n’y a pas de restitution quand la vente est reportée, adjugée ou retirée par la
juridiction ou la source. Aucun code automatique. La restitution est un engagement contractuel, pas
un droit RGPD : le même délai d’un mois s’applique par cohérence avec les CGV.

Elle arrive uniquement par l’adresse de contact. Le portail Mes droits n’a pas de type
« restitution » et ses types sont des droits RGPD ou la rétractation Analyse : ne jamais utiliser
« Rétractation Analyse » (`contract_withdrawal`), dont le traitement propose l’annulation de
l’abonnement Stripe et le remboursement. Si une demande de restitution arrive quand même par Mes
droits, la traiter comme un message de contact et la clôturer avec le code de résolution
« hors_rgpd_restitution_deblocage ».

1. Identifier le compte demandeur et la vente (identifiant ou adresse de la fiche) ; ne traiter que
   les déblocages du compte qui écrit. L’identité est établie par l’adresse email du compte : si la
   demande vient d’une autre adresse, demander au titulaire de la renouveler depuis son compte ou
   depuis cette adresse.
2. Vérifier la cause : la vente est-elle retirée ou en attente par décision d’Immojudis
   (interrupteur de retrait d’une source, quarantaine de publication, mise en attente de
   préparation, erreur de publication) ? Si elle est reportée, adjugée ou retirée par la juridiction
   ou la source, refuser en l’expliquant.
3. Retrouver la ligne dans `user_sale_unlocks` (colonnes `user_id`, `sale_id`, `unlocked_at`). Une
   ligne dont la vente a été supprimée a `sale_id` nul : la retrouver par `user_id` et par la date
   du déblocage donnée par le demandeur.
4. Le compteur du mois se calcule sur les lignes du mois. Si le déblocage date du mois civil en
   cours (heure de Paris), supprimer cette seule ligne
   (`delete from public.user_sale_unlocks where id = '<id de la ligne>'`) avec le rôle de service
   depuis l’éditeur SQL de Supabase (accès restreint), en notant dans la demande la requête
   exécutée. Pour un déblocage d’un mois passé, ne rien supprimer (aucun crédit n’est rendu et la
   suppression ferait perdre l’accès à la vente si elle revient en ligne) et le dire au demandeur.
5. La suppression retire aussi l’accès du compte à cette vente. Si le demandeur veut la rouvrir une
   fois la vente de nouveau en ligne, il la débloque à nouveau (idempotent, un crédit).
6. Répondre au demandeur sur un support durable, conserver la demande et la date de suppression
   (notes opérateur de la demande, ou courriel de réponse), puis clôturer la demande avec un code de
   résolution. L’échange est conservé 12 mois après le dernier message (ligne « Formulaire de
   contact » de la politique de confidentialité), puis supprimé.

Une demande simple doit recevoir une réponse au plus tard sous un mois. Une prolongation de deux mois
doit être motivée et annoncée avant la première échéance.

## Validation attendue avant ouverture payante

- identité et médiateur configurés en production ;
- revue juridique écrite conservée ;
- commande Stripe de test et preuve `commercial_acceptances` vérifiées ;
- demande d’accès (copie incluant les déblocages de ventes, table `user_sale_unlocks`), d’effacement et de
  rétractation testées de bout en bout ;
- procédure de remboursement et suppression Storage/Auth répétée sur un compte de test ;
- contrats/DPA et mécanismes de transfert des fournisseurs vérifiés ;
- bouton « Résilier mon abonnement » (page Mon compte) testé de bout en bout, y compris la
  configuration du portail Stripe : la résiliation doit se programmer **en fin de période**
  (`cancel_at_period_end`), comme l'annoncent les CGV et la page Mon compte ;
- email « Confirmation de votre résiliation » reçu après une résiliation (webhook
  `customer.subscription.updated` rejoué : un seul email) et canal Resend configuré ;
- qualification du contrat validée par le conseil : abonnement à durée indéterminée, facturé chaque
  mois, résiliable à tout moment sans frais ni préavis (CGV § 2) ;
- coordonnées du formulaire type de rétractation (raison sociale, adresse, email) renseignées par
  les variables `NEXT_PUBLIC_LEGAL_*` et relues (CGV § 6).

Références de cadrage : [mentions obligatoires](https://www.economie.gouv.fr/entreprises/developper-son-entreprise/innover-et-numeriser-son-entreprise/mentions-sur-votre-site-internet-les-obligations-respecter),
[e-commerce B2C](https://www.economie.gouv.fr/dgccrf/les-fiches-pratiques/e-commerce-les-regles-entre-professionnels-et-consommateurs),
[réponse aux droits](https://www.cnil.fr/fr/repondre-une-demande-de-droit-dacces) et
[durées de conservation](https://www.cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees).
