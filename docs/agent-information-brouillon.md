# Page publique de l’outil de recherche d’adresses (brouillon)

**Brouillon : outil non encore en service.** Ce texte ne doit pas être publié, ni lié depuis la
politique de confidentialité, tant que l’outil de recherche d’adresses n’existe pas et ne fait pas
exactement ce que la page annonce. Il est destiné à devenir la page `/agent-information` (à créer
avec l’outil) vers laquelle pointera le user-agent. Rédigé le 14/10/2026 d’après l’avis juridique
du même jour ; à faire valider.

## Points à tenir avant l’activation

1. **Identification de l’outil.** Un jeton `robots.txt` exact, par exemple `ImmojudisAdresses`, et
   un user-agent identique dans toutes les requêtes :
   `ImmojudisAdresses/1.0 (+https://<domaine>/agent-information)`. Le jeton et l’adresse de la page
   doivent être repris tels quels dans la page publique, afin que les éditeurs puissent
   l’interdire dans leur `robots.txt`.
2. **Aucune liste ni cache pour la recherche de l’outil.** L’outil de recherche ne conserve aucune
   liste de noms ou d’adresses web : n’en annoncer aucune. Cette phrase ne couvre ni le relevé en lot
   des adresses des annonces Licitor (adresses décodées conservées dans le registre interne, voir le
   paragraphe Licitor de la page), ni les captures HTML du collecteur d’historique Licitor
   (`licitor_ingestion.captures`, sans purge codée à ce jour) : ne rien annoncer qui les contredise.
3. **Pas de journal de consultation distinct.** La trace des tentatives (source essayée, résultat,
   domaine, nombre de pages lues, sans contenu) est conservée avec la demande, pas ailleurs : ne
   rien annoncer de plus.
4. **Liste exacte de ce qui sera stocké.** Seuls : l’adresse retenue, l’adresse web de la page, la
   date de consultation, le type de source, la règle et le score d’appariement, l’administrateur
   qui valide. Pour Licitor : l’adresse décodée, le nom et la fonction imprimés dans le bloc de
   l’avocat, le lien de l’annonce et la date de relevé. Aucun contenu de page, aucun extrait. À confirmer avec
   l’implémentation (l’avis prévoyait un hash et un extrait de 240 caractères facultatifs : ils ne
   figurent pas dans ce texte).
5. **Sources.** La liste annoncée doit être celle des sources activées (registre des sources avec
   statut et date de revue juridique). Paris, Marseille et notaires.fr restent désactivés sans
   autorisation écrite.
6. **Politique de confidentialité.** Ajouter la phrase « Un outil de recherche automatisé consulte
   ponctuellement, pour une vente précise, une page publique du professionnel concerné. Aucune copie
   de page n’est conservée. » et le lien vers la page, au moment de l’activation, avec une
   nouvelle version du document. Le pied du message contient déjà la mention de la recherche
   automatique, qui n’apparaît que pour une adresse trouvée par l’agent hors de l’annonce.
7. **AIPD.** L’analyse de seuil de `docs/rgpd-mise-en-balance-agent-information.md` doit être
   validée avant l’activation.

## Texte de la page

### L’outil de recherche d’adresses d’Immojudis

Cette page présentera un outil automatisé d’Immojudis : qui l’exploite, à quoi il servira, ce qu’il
consultera et comment vous y opposer. Elle s’adresse aux professionnels des ventes aux enchères
(avocats, notaires, commissaires de justice, gestionnaires) et aux éditeurs des sites qu’il pourra
consulter.

#### Qui l’exploite

L’outil sera exploité par Immojudis, {entité}, situé à {adresse}. Contact : {email de contact}.

#### À quoi il servira

Lorsqu’un administrateur d’Immojudis préparera une demande d’information sur une vente précise,
l’outil pourra consulter ponctuellement une page publique du professionnel qui mène cette vente pour
retrouver son adresse professionnelle : une autre annonce publique du même professionnel
enregistrée par Immojudis, ou le site de son cabinet ou de son étude cité dans l’annonce de la vente.
Cette adresse ne servira qu’à lui
écrire au sujet de cette vente. L’outil ne fera aucune prospection : les messages ne contiendront
aucune offre commerciale, et chacun sera relu et validé par un membre de l’équipe avant envoi.

#### Ce qu’il fera, et ce qu’il ne fera pas

- Il cherchera un seul professionnel à la fois, pour une vente précise.
- Il lira trois pages au plus du site d’un cabinet (accueil, contact, mentions légales ou
  présentation), jamais un site entier : aucune pagination, aucun formulaire.
- Il respectera le fichier `robots.txt` de chaque site (jeton `ImmojudisAdresses`), avancera à un
  rythme lent et s’arrêtera dès qu’un site le lui refusera ; il ne contournera aucun blocage.
- Il ne conservera pas la page lue. Seront enregistrés : l’adresse retenue, l’adresse web de la
  page, la date de relevé, le type de source et le critère de rapprochement utilisé. Aucune liste
  de noms ou d’adresses web n’est conservée.
- Adresse relevée à la collecte de l’annonce et non utilisée pour un envoi : conservée tant que le détail de l’annonce est relu, jamais rafraîchie après la date de la vente, et supprimée au plus tard 28 jours après la dernière consultation de l’annonce (purge hebdomadaire, seuil de 21 jours).
- Il s’identifiera à chaque requête : le jeton `ImmojudisAdresses` et l’adresse de cette page
  figureront dans son user-agent.

#### Annonces publiées sur Licitor

Les adresses professionnelles des avocats figurant dans les annonces publiées sur Licitor, que le
site masque par une protection anti-spam, sont relevées automatiquement lors de la collecte de
l’annonce. Elles sont conservées en interne, jamais publiées, et ne servent qu’à une demande
d’information validée par un membre de l’équipe sur la vente concernée. Durée : adresse relevée à la collecte de l’annonce et non utilisée pour un envoi : conservée tant que le détail de l’annonce est relu, jamais rafraîchie après la date de la vente, et supprimée au plus tard 28 jours après la dernière consultation de l’annonce (purge hebdomadaire, seuil de 21 jours). Opposition : voir ci-dessous ; elle est contrôlée par adresse à la collecte et par identité avant tout envoi.

#### Comment vous y opposer

Vous pouvez vous opposer à tout moment, sans motif. Si vous avez reçu un message, utilisez le lien
« Ne plus être contacté » qu’il contient, ou répondez-y. Sinon, écrivez à {email de contact} en
indiquant votre nom et votre barreau ou votre ville. Votre opposition est enregistrée pour votre
adresse et pour votre identité : elle vaut pour tous nos canaux, et vous ne serez plus sollicité
sous une autre adresse.

Éditeurs de sites : pour que l’outil ne consulte plus tout ou partie de votre site, ajoutez le
jeton `ImmojudisAdresses` à votre fichier `robots.txt` ou écrivez à {email de contact}.

#### Vos droits

Vous pouvez demander l’accès, la rectification, l’effacement ou la limitation du traitement de vos
données, ou saisir la CNIL (<https://www.cnil.fr/fr/plaintes>). Le traitement complet (base
juridique, durées, destinataires) est décrit dans la politique de confidentialité.
