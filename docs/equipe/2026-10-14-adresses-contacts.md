# Trouver l'email des professionnels d'une vente (14/10/2026)

Mission du propriétaire : beaucoup de fiches sont incomplètes, et l'agent d'information ne peut
pas écrire au professionnel de la vente quand la fiche n'a pas d'adresse email. Trouver ces
adresses dans un cadre juridique sain.

Cadre fixé par le propriétaire : uniquement des annuaires publics ou des sites où les
professionnels ont publié leur adresse. Pas de listes achetées, pas d'extraction de réseaux
sociaux, pas d'adresse devinée.

Agents :

- `qualite-donnees` : mesure en lecture seule sur la production, le 14/10 à 07:01 UTC ;
- `juridique-rgpd` : cadrage juridique et RGPD ;
- `Plan` : cadrage technique ;
- `developpeur` : correctif Licitor, PR #258 en brouillon.

## En bref

- **1 938 ventes en ligne. Seules 346 (18 %) ont un email que l'agent peut utiliser seul.**
  Les autres ont :
  - un téléphone seulement : 1 048 (54 %) ;
  - un nom seulement : 95 (5 %) ;
  - rien du tout : 415 (21 %).
- **Les fiches les moins complètes sont celles où l'agent peut le moins agir.** Avec 5 champs
  manquants ou plus, 4 % des fiches ont un email exploitable, contre 43 % avec 2 champs
  manquants ou moins.
- **Le travail se compte en professionnels, pas en fiches.** 589 professionnels distincts
  couvrent les 1 558 fiches sans email :
  - 53 d'entre eux ont déjà un email sur une autre fiche (127 fiches couvertes) ;
  - il reste environ 536 adresses à trouver ;
  - 416 fiches ne nomment aucun professionnel (Vench 319, Petites Affiches 93) : c'est une
    lacune d'extraction, à corriger avant de chercher quoi que ce soit.
- **Adresses masquées par Cloudflare** : 202 fiches Licitor (52 %) et 65 fiches Vench, soit
  jusqu'à 174 professionnels.
- **Aucun envoi réel n'est possible aujourd'hui.** L'agent est en mode test
  (`INFORMATION_AGENT_OUTBOUND_CANARY_ONLY`) et refuse d'envoyer sans les mentions légales de la
  société. Les garde-fous ci-dessous peuvent donc être posés avant le premier envoi.

## Verdict juridique par source

| Source                                                       | Verdict             | Pourquoi                                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Licitor et Vench, décodage de toutes les fiches au parseur   | À éviter            | Le masquage montre que l'éditeur refuse la collecte en masse. Stocker des adresses sans besoin va contre la minimisation.                                                      |
| Licitor et Vench, décodage à la demande, fiche par fiche     | Sous conditions     | L'avocat publie l'adresse dans l'annonce pour être contacté sur cette vente. Demander une confirmation écrite à Licitor, car l'accord oral ne couvre pas clairement cet usage. |
| Adresse déjà publiée sur une autre annonce du même avocat    | Sous conditions     | Même attente raisonnable que l'annonce. Correspondance exigée sur le nom et le téléphone, et validation humaine.                                                               |
| Site du cabinet ou de l'étude                                | Feu vert            | Le professionnel y publie son adresse pour être contacté. URL tirée de l'annonce ou d'un annuaire, jamais d'un moteur de recherche.                                            |
| Annuaires des barreaux, annuaire des commissaires de justice | Sous conditions     | Consultation manuelle, fiche par fiche. Les mentions interdisent la reproduction sans écrit, et le droit des bases de données interdit l'extraction systématique.              |
| Interface du barreau de Paris, index des barreaux            | À éviter sans écrit | Interrogation automatique d'une base protégée (CGU de l'Ordre, art. 4.2). Possible seulement avec l'accord écrit de l'Ordre.                                                   |
| Annuaire et jeu ouvert du CNB                                | Identité seulement  | Ils ne publient pas d'email. Le jeu ouvert (Licence Ouverte) sert à distinguer les homonymes.                                                                                  |
| notaires.fr                                                  | À éviter            | Réutilisation commerciale interdite, et le site bloque les robots. Les fiches notariales ont déjà un email à 99 %.                                                             |
| Greffes et tribunaux                                         | Exclusion maintenue | Ce ne sont pas des interlocuteurs de l'agent. Une demande d'information publique reste possible à la main, à l'adresse de service publiée.                                     |
| Adresses RPVA (`@avocat-conseil.fr`)                         | Exclues             | Canal réservé à la procédure.                                                                                                                                                  |

Il manque aussi des garde-fous dans l'agent actuel, à poser avant le premier envoi réel :

- le type et la date de la source sont enregistrés ; le libellé d'origine du message est exact
  (aujourd'hui, une adresse d'annuaire serait présentée comme « figure dans l'annonce ») ;
- les adresses jamais utilisées sont purgées sous 30 jours ;
- l'opposition suit la personne (nom et barreau), pas seulement l'adresse ;
- un test refuse toute mention commerciale dans le message ;
- le pied de message art. 14 est complet : catégories, destinataires, droits, CNIL ;
- le test de mise en balance de l'intérêt légitime est rédigé ;
- le registre des traitements et la politique de confidentialité sont mis à jour ;
- le prestataire d'IA qui lit les réponses est identifié.

## Propositions numérotées

| N°  | Proposition                                                                                                                                                                                                      | Gain                                   | Effort | Avis du chef |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------ | ------------ |
| 1   | Refaire la PR #258 : décoder l'adresse masquée par Cloudflare à la demande, quand un administrateur prépare une demande sur la fiche (Licitor et Vench), sans stockage en masse                                  | jusqu'à 174 professionnels, 267 fiches | M      | garder       |
| 2   | Réemployer l'adresse déjà publiée par le même professionnel sur une autre annonce (même nom et même téléphone), avec la page d'origine, validée par l'administrateur                                             | 53 professionnels, 127 fiches          | S      | garder       |
| 3   | Corriger l'extraction du nom et du téléphone de l'avocat chez Vench et Petites Affiches                                                                                                                          | 411 fiches qui deviennent adressables  | M      | garder       |
| 4   | Garde-fous juridiques de l'agent (liste ci-dessus) et textes RGPD                                                                                                                                                | condition du premier envoi réel        | M      | garder       |
| 5   | Assistant d'annuaires : liens directs vers l'annuaire du barreau du tribunal, l'annuaire des commissaires de justice et le site du cabinet, puis saisie structurée de l'adresse (source, URL, date). Aucun robot | le reste des ~536 adresses             | M      | garder       |
| 6   | Rédiger pour le propriétaire les demandes d'autorisation écrite : Licitor (n° 1) et Ordre des avocats de Paris (recherche automatique, plus tard)                                                                | sécurise 1, ouvre 7                    | S      | garder       |
| 7   | Recherche automatique dans les annuaires (Paris, barreaux), seulement avec un accord écrit                                                                                                                       | à mesurer après 1 à 5                  | L      | plus tard    |

Ordre conseillé : 6 (envoi des demandes), puis 4 et 3, puis 1, 2 et 5. L'agent ne peut pas
envoyer avant la création de la société : rien ne presse côté envoi, mais tout se prépare.

Points à faire valider par un avocat :

- la mise en balance de l'intérêt légitime ;
- le décodage Cloudflare : il n'est pas qualifié de contournement de mesure technique ;
- la portée de l'accord de Licitor ;
- les durées de conservation ;
- le secret professionnel du destinataire (questions limitées aux pièces communicables à tout
  candidat acquéreur) ;
- l'identification du sous-traitant IA.

## Décisions du propriétaire

14/10/2026. Objectif du propriétaire : l'agent d'information trouve seul les adresses nécessaires à
la prise de contact. Les propositions sont réorganisées en trois niveaux de sources, et le
propriétaire répond oui à quatre décisions :

1. **Niveau 1, recherche autonome sur les sources sûres.** Quand l'agent prépare une demande, il
   cherche seul :
   - l'annonce, y compris l'adresse masquée par Cloudflare (Licitor, Vench), décodée pour cette
     fiche seulement (refonte de la PR #258) ;
   - la même adresse publiée par le même professionnel sur une autre annonce (même nom et même
     téléphone) ;
   - le site du cabinet cité par l'annonce ou par un annuaire.

   Viennent avec ce niveau :
   - les garde-fous juridiques (n° 4) ;
   - la correction de l'extraction Vench et Petites Affiches (n° 3).

2. **Niveau 2, annuaires publics interrogés par l'agent fiche par fiche.** Un professionnel à la
   fois, sans copie de l'annuaire. À construire seulement après un nouvel avis de `juridique-rgpd`
   sur ce mode ciblé.
3. **Niveau 3, avec autorisation écrite.** Le chef d'orchestre rédige les demandes d'autorisation :
   Licitor, et l'Ordre des avocats de Paris.
4. **Validation de l'envoi.** L'envoi reste validé d'un clic par l'administrateur, après l'aperçu :
   l'agent trouve et prépare, il n'envoie pas seul.
