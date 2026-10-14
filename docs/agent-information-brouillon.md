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
2. **Cache.** Ne parler que d’une liste de noms et d’adresses web « conservée temporairement
   (24 heures au plus) », jamais « en mémoire » : le support réel (mémoire du worker, disque
   temporaire) doit correspondre à ce qui est écrit. Jamais en base ni dans un index partagé.
3. **Journal de consultation de 6 mois.** Avant de l’annoncer : créer la table (site, page,
   résultat, date, vente, sans contenu), la purge à 6 mois dans `run_data_retention`, la ligne de
   la matrice de conservation et la mention dans la politique de confidentialité.
4. **Liste exacte de ce qui sera stocké.** Seuls : l’adresse retenue, l’adresse web de la page, la
   date de consultation, le type de source, la règle et le score d’appariement, l’administrateur
   qui valide. Aucun contenu de page, aucun extrait, aucune copie d’annuaire. À confirmer avec
   l’implémentation (l’avis prévoyait un hash et un extrait de 240 caractères facultatifs : ils ne
   figurent pas dans ce texte).
5. **Sources.** La liste annoncée doit être celle des sources activées (registre des sources avec
   statut et date de revue juridique). Paris, Marseille et notaires.fr restent désactivés sans
   autorisation écrite.
6. **Politique de confidentialité.** Ajouter la phrase « Un outil de recherche automatisé consulte
   ponctuellement, pour une vente précise, une page publique du professionnel concerné. Aucune copie
   d’annuaire n’est conservée. » et le lien vers la page, au moment de l’activation, avec une
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
retrouver son adresse professionnelle : l’annonce de la vente, sa fiche dans un annuaire
professionnel officiel ou le site de son cabinet ou de son étude. Cette adresse ne servira qu’à lui
écrire au sujet de cette vente. L’outil ne fera aucune prospection : les messages ne contiendront
aucune offre commerciale, et chacun sera relu et validé par un membre de l’équipe avant envoi.

#### Ce qu’il fera, et ce qu’il ne fera pas

- Il cherchera un seul professionnel à la fois, pour une vente précise.
- Il lira des pages précises (une fiche, une page de contact ou de mentions légales), jamais un
  annuaire entier : aucune pagination, aucun formulaire de recherche, aucune copie d’annuaire.
- Il respectera le fichier `robots.txt` de chaque site (jeton `ImmojudisAdresses`), avancera à un
  rythme lent et s’arrêtera dès qu’un site le lui refusera ; il ne contournera aucun blocage.
- Il ne conservera ni la page lue ni une copie d’annuaire. Seront enregistrés : l’adresse retenue,
  l’adresse web de la page, la date de consultation, le type de source et le nom de la personne qui
  a validé. Une liste de noms et d’adresses web pourra être conservée temporairement (24 heures au
  plus). Le journal des consultations (site, page, résultat, date), sans contenu, sera conservé
  6 mois au plus.
- Une adresse qui ne serait finalement pas utilisée pour un envoi sera supprimée sous un mois.
- Il s’identifiera à chaque requête : le jeton `ImmojudisAdresses` et l’adresse de cette page
  figureront dans son user-agent.

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
