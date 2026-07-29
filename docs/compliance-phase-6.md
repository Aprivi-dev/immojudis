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

| Document         | Route                   | Version initiale Phase 6 |
| ---------------- | ----------------------- | ------------------------ |
| Mentions légales | `/legal`                | `2026-07-29.1`           |
| CGVU             | `/conditions-generales` | `2026-07-29.1`           |
| Confidentialité  | `/privacy`              | `2026-07-29.1`           |

Toute modification substantielle crée une nouvelle version, une nouvelle empreinte et une date
d’effet. Les empreintes correspondent aux sources des pages publiées et sont contrôlées par un test
automatique ; une acceptation antérieure n’est jamais réécrite.

## Commande Analyse

Avant Stripe, l’utilisateur voit le produit, le prix TTC, la durée, l’absence de renouvellement et
deux consentements distincts. Le bouton final porte la mention « Commander avec obligation de
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
4. Exécuter le droit demandé ou documenter le motif légal d’une limitation/refus.
5. Pour un effacement, supprimer d’abord les objets Storage via l’API Storage, puis le compte Auth ;
   les clés étrangères `on delete cascade` retirent les espaces personnels.
6. Pour une rétractation, vérifier la date et l’usage, calculer le cas échéant la part de service déjà
   fournie, traiter le remboursement dans Stripe et révoquer l’accès via le cycle de paiement existant.
7. Clôturer la demande avec un code de résolution et notifier l’utilisateur sur un support durable.

Une demande simple doit recevoir une réponse au plus tard sous un mois. Une prolongation de deux mois
doit être motivée et annoncée avant la première échéance.

## Validation attendue avant ouverture payante

- identité et médiateur configurés en production ;
- revue juridique écrite conservée ;
- commande Stripe de test et preuve `commercial_acceptances` vérifiées ;
- demande d’accès, d’effacement et de rétractation testées de bout en bout ;
- procédure de remboursement et suppression Storage/Auth répétée sur un compte de test ;
- contrats/DPA et mécanismes de transfert des fournisseurs vérifiés.

Références de cadrage : [mentions obligatoires](https://www.economie.gouv.fr/entreprises/developper-son-entreprise/innover-et-numeriser-son-entreprise/mentions-sur-votre-site-internet-les-obligations-respecter),
[e-commerce B2C](https://www.economie.gouv.fr/dgccrf/les-fiches-pratiques/e-commerce-les-regles-entre-professionnels-et-consommateurs),
[réponse aux droits](https://www.cnil.fr/fr/repondre-une-demande-de-droit-dacces) et
[durées de conservation](https://www.cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees).
