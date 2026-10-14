# Demandes d'autorisation écrite : Licitor et Ordre des avocats de Paris (14/10/2026)

Deux textes prêts à envoyer, à compléter aux endroits entre crochets. Le propriétaire les
envoie lui-même. Rien n'a été envoyé et personne n'a été contacté.

## Note au propriétaire

### Avant d'envoyer

- **Les deux textes parlent au nom de la société.** Elle n'existe pas encore. Envoyez-les une
  fois la société créée, pour que la dénomination, l'adresse et le numéro d'immatriculation
  soient les bons. Sinon, signez en votre nom et dites que la société est en cours de création.
- **Ils contiennent des engagements que le produit ne tient pas encore.** Ils sont listés
  ci-dessous. Ils font partie du plan (garde-fous n° 4 du compte-rendu), mais aucun n'est
  livré à ce jour. Ne postez pas les lettres sans avoir décidé de les construire, ou retirez
  la phrase concernée :
  - décodage de l'adresse masquée **en lot, à la collecte** (livré dans la PR #258, avec l'accord oral
    de Licitor invoqué à titre provisoire) : le courrier le demande explicitement, sur le HTML déjà
    récupéré, sans requête supplémentaire. La version « à la demande, fiche par fiche » de la première
    rédaction est abandonnée ;
  - adresse conservée en interne seulement, jamais publiée (livré) ;
  - suppression d'une adresse relevée mais jamais utilisée, au plus tard 28 jours après la dernière
    consultation de l'annonce (livré : purge hebdomadaire, seuil de 21 jours) ;
  - **suspension du décodage et suppression des adresses déjà relevées si Licitor refuse ou ne
    confirme pas** : il n'existe pas d'interrupteur propre au décodage (seul le retrait de la
    source Licitor, `set_catalogue_source_withdrawal`, arrête la collecte, et il retire Licitor du
    catalogue) et la suppression ciblée des adresses n'est pas outillée ; retirez cette phrase ou
    décidez de l'outiller ;
  - opposition qui suit la personne (nom et barreau), pas seulement l'adresse ;
  - test automatique qui refuse toute mention commerciale dans le message ;
  - respect de `robots.txt`, rythme humain, identification de l'agent lors des consultations ;
  - interrogation de l'annuaire de l'Ordre : aucune n'est en service, et aucune ne le sera
    sans réponse écrite favorable.
- **Durées de conservation.** Elles ne sont pas encore validées par un avocat. Le courrier à Licitor
  cite la durée réelle du relevé en lot (28 jours au plus après la dernière consultation de
  l'annonce) ; les durées de 12 et 24 mois des échanges restent hors du texte. Les captures HTML du
  collecteur d'historique (`licitor_ingestion.captures`) n'ont aucune purge codée : le courrier ne
  s'engage pas sur elles, à trancher avant l'envoi.
- **Mention de la visibilité payante dans la lettre à l'Ordre.** Elle y figure volontairement :
  mieux vaut que l'Ordre l'apprenne de vous. Vous pouvez la retirer. Si vous la retirez, ne la
  remplacez pas par une formule qui la contredit.
- **Faites relire les deux textes par un avocat avant l'envoi.** Ce sont des courriers
  juridiques, pas du conseil. Le cadrage juridique lui-même le demande (points 3 et 5 de sa
  liste de validation).

### Licitor

- **Destinataire :** Ferrari Conseil S.A., éditeur de licitor.com, 41 rue de Richelieu, 75001
  Paris. Téléphone affiché : 01 42 96 01 63.
- **Canal :** la page « Nous contacter » (https://www.licitor.com/contact.html) n'affiche pas
  d'adresse email, seulement un formulaire. Le site dit ne répondre qu'aux personnes dont
  l'adresse email a été vérifiée (vérifié le 14/10/2026). Deux voies, à cumuler :
  1. **Lettre recommandée avec accusé de réception** à l'adresse de l'éditeur. C'est la preuve
     la plus solide. Joignez le texte ci-dessous.
  2. **Formulaire de contact** : collez un court message (deux lignes) qui annonce la lettre et
     demande l'adresse email à laquelle envoyer la demande complète. Si Licitor répond avec une
     adresse, envoyez-y le texte tel quel.
  - Si vous avez un interlocuteur chez Licitor (celui de l'accord oral), envoyez-lui le texte
    en direct et en copie du courrier. Mettez son nom dans le champ prévu.
- **À conserver de la réponse :**
  - la date de réception et la date figurant sur le document ;
  - le nom et la fonction de la personne qui répond, et l'adresse d'où elle écrit ;
  - le texte intégral : l'email avec ses en-têtes complets (pas une capture), ou le courrier
    scanné avec l'enveloppe ;
  - votre demande telle qu'envoyée, et la preuve de son envoi (accusé de réception) ;
  - un classement unique, par exemple `docs/legal/` ou le coffre de la société. Gardez-le
    aussi longtemps que vous décodez des adresses.
- **Une réponse partielle ou orale ne vaut pas confirmation.** Si Licitor n'autorise que (a),
  ne lancez pas (b). Le silence n'est pas un accord.

### Ordre des avocats au barreau de Paris

- **Destinataire :** Ordre des avocats de Paris, Palais de Justice, 4 boulevard du Palais, 75001
  Paris. Les CGU du site institutionnel sont publiées au nom de l'Ordre, avec le Bâtonnier de
  Paris comme responsable de la publication (CGU consultées le 14/10/2026, mise à jour de mai 2026).
- **Service compétent :** je n'ai pas trouvé de service désigné pour ce type de demande. L'article
  4.2 des CGU exige « l'autorisation écrite préalable de l'Ordre des avocats de Paris » sans
  nommer de service ni d'adresse. L'article 7 renvoie au formulaire de contact du site pour les
  questions sur les CGU.
- **Canal conseillé :**
  1. **Lettre recommandée avec accusé de réception** à l'adresse ci-dessus, « à l'attention de
     Monsieur ou Madame le Bâtonnier », avec le texte ci-dessous.
  2. **Copie par email à `contact@avocatparis.org`**. C'est l'adresse de l'accueil général de
     l'Ordre (page « accueil général des avocats », mise à jour le 27 avril 2026). Demandez dans
     l'email le nom du service qui traite la demande. La page affiche aussi une autre adresse
     (`delegationgenerale@avocatparis.org`) dans son lien : ne vous en servez que si l'accueil
     vous y renvoie.
  3. Ne mettez pas le délégué à la protection des données (`dpo@avocatparis.org`) en
     destinataire : cette adresse traite les droits sur les données personnelles, pas les
     autorisations de réutilisation.
- **Point à vérifier avant l'envoi :** je n'ai pas pu ouvrir l'annuaire des avocats de Paris
  (`annuaire.avocatparis.org` ne répondait pas depuis mon poste) ni lire ses conditions. Le
  cadrage juridique ne les a pas lues non plus. Ouvrez l'annuaire, notez l'adresse exacte de la
  page de recherche et complétez le champ prévu. Cherchez aussi des conditions propres à
  l'annuaire. Si elles existent et diffèrent des CGU, citez-les dans la lettre.
- **À conserver de la réponse :** mêmes éléments que pour Licitor. Retenez en plus la **version
  des CGU et des conditions de l'annuaire à la date de la réponse** (imprimez-les en PDF avec la
  date). Notez les conditions posées par l'Ordre (volume, fréquence, durée, révocation) : elles
  deviennent des règles de l'agent.
- **En cas de refus, de condition ou de silence :** pas d'interrogation automatique de l'annuaire.
  Le compte-rendu prévoit la consultation à la main, fiche par fiche, comme voie de repli.

---

## Texte 1 : email à Licitor

**Destinataire :** Ferrari Conseil S.A., éditeur de licitor.com, 41 rue de Richelieu, 75001 Paris
[à l'attention de : nom de l'interlocuteur chez Licitor, s'il est connu]

**Canal :** [lettre recommandée avec accusé de réception | formulaire de contact | email à
l'adresse indiquée par Licitor]

**Objet :** Demande de confirmation écrite sur la réutilisation des annonces de Licitor par
Immojudis

Bonjour,

Je suis [prénom nom], [fonction] d'[dénomination de la société, forme, immatriculation,
adresse], éditeur du site immojudis.com. Immojudis aide les investisseurs à comprendre les
ventes immobilières aux enchères judiciaires en France : pour chaque vente, nous réunissons les
informations publiées (annonce, date d'audience, mise à prix, documents) et des statistiques.

Nous avons échangé oralement avec [nom, fonction] le [date] au sujet de la reprise de vos
annonces par Immojudis. [Résumez en une phrase ce qui a été convenu, tel que vous vous en
souvenez.] Je vous écris pour mettre cet accord par écrit. Il évitera tout malentendu entre
nous, et il me permet de montrer à des tiers que nous agissons avec votre accord.

**Ce que je vous demande de confirmer, par écrit et en indiquant la date**

**(a) La réutilisation des annonces.** Immojudis collecte les annonces publiées sur licitor.com,
les affiche sur son site avec la mention de la source et un lien vers l'annonce d'origine, et en
tire des statistiques. [Si vous ne reprenez pas les photos ou les PDF, dites-le ici.] Confirmez
que vous l'acceptez, et à quelles conditions.

**(b) Le décodage de l'adresse email de l'avocat, en lot, à la collecte.** Dans une annonce,
l'avocat publie son adresse email pour qu'on le contacte au sujet de la vente. Licitor la masque
derrière la protection anti-spam de Cloudflare. Immojudis décode cette adresse **pour toutes les
annonces en cours qu'il collecte**, au moment de la collecte, à partir de la page déjà récupérée
pour l'afficher : le décodage n'ajoute aucune requête vers votre site et ne peut pas se faire
après coup. Nous le faisons ainsi :

- nous lisons l'adresse dans la page telle que votre site la sert à tout visiteur, uniquement dans
  le bloc de l'avocat présenté comme interlocuteur de la vente ; nous ne contournons aucun
  blocage, aucune vérification ni aucune limite d'accès, et nous respectons votre fichier
  `robots.txt` ;
- l'adresse est conservée **en interne seulement**, dans un registre réservé à nos administrateurs.
  Elle n'est jamais publiée : ni sur notre site, ni dans nos données, ni dans nos statistiques ;
- nous écartons les adresses de juridictions, de l'Ordre, des barreaux et des CARPA, la messagerie
  RPVA et les adresses techniques (`noreply`, `dpo`, `rgpd`) ;
- durée : une adresse que nous n'utilisons pas pour écrire est supprimée au plus tard 28 jours
  après la dernière fois que nous avons consulté l'annonce, et elle n'est plus entretenue après la
  date de la vente ;
- elle ne sert qu'à écrire à cet avocat, au sujet de cette seule vente, après validation du message
  par une personne d'Immojudis ;
- nous contrôlons l'opposition par adresse au moment de la collecte, et par identité avant tout
  envoi.

Confirmez que vous l'acceptez, ou précisez ce que vous refusez. **Si vous refusez ou ne confirmez
pas, nous suspendons le décodage** [et supprimons les adresses déjà relevées : à confirmer avant
envoi, voir la note].

**(c) Le périmètre.**

- _Volume :_ une adresse par avocat et par annonce en cours collectée, soit environ [nombre]
  adresses relevées au total.
- _Fréquence :_ un message par adresse et par mois au plus, toutes ventes confondues. Pas de
  relance.
- _Pas d'exportation ni de publication :_ les adresses restent dans notre registre interne ; nous
  n'en faisons ni liste diffusée, ni base commerciale, et nous ne les utilisons pas pour de la
  prospection.

Dites-nous si ce périmètre vous convient, ou quelles limites vous préférez.

**(d) Les oppositions.** Un avocat peut refuser d'être contacté, auprès de vous ou auprès de
nous. Chaque message d'Immojudis contient un lien « Ne plus être contacté ». L'opposition est
enregistrée aussitôt et nous n'écrivons plus à cette personne. Si un avocat s'adresse à Licitor
pour s'opposer, indiquez-nous comment vous souhaitez nous la transmettre : à quelle adresse, sous
quelle forme, et si vous préférez que nous vous informions des oppositions reçues de notre côté.
Nous l'enregistrons dans un délai de [nombre] jours ouvrés après réception.

**Ce que nous garantissons dans chaque message**

- Chaque message est relu et validé par une personne d'Immojudis avant l'envoi. Rien n'est
  envoyé automatiquement.
- Le message ne contient aucune publicité, aucune offre et aucun lien vers un service payant. Il
  ne sert pas à la prospection commerciale.
- Il indique d'où vient l'adresse, avec un lien vers l'annonce Licitor, et l'identité d'Immojudis.
- Il donne les droits de la personne (accès, rectification, effacement, opposition) et un lien
  pour s'opposer en un clic.
- Il ne pose de questions que sur des éléments communicables à tout candidat acquéreur (cahier
  des conditions de vente, procès-verbal descriptif, diagnostics, dates de visite, consignation,
  date d'audience).

Pouvez-vous me répondre par écrit, par retour d'email ou par courrier, en indiquant la date, le
nom et la fonction de la personne qui répond ? Si l'un de ces points ne vous convient pas,
dites-le-moi : je corrigerai notre fonctionnement. Le décodage (point b) repose aujourd'hui sur
votre accord oral du [date] ; à défaut de votre confirmation écrite, nous le suspendons.

Je reste disponible par téléphone au [numéro] ou par email à [adresse] pour en parler.

Cordialement,

[Prénom Nom]
[Fonction]
[Dénomination de la société, forme juridique, capital]
[Adresse]
[Immatriculation : RCS ... / SIREN ...]
[Téléphone] · [Email]
[Date]

---

## Texte 2 : lettre à l'Ordre des avocats au barreau de Paris

**Destinataire :** Ordre des avocats de Paris, Palais de Justice, 4 boulevard du Palais, 75001
Paris. À l'attention de Monsieur ou Madame le Bâtonnier [ou du service indiqué par l'accueil].

**Canal :** [lettre recommandée avec accusé de réception] et copie par email à
contact@avocatparis.org

**Objet :** Demande d'autorisation écrite d'interroger l'annuaire des avocats de Paris pour
retrouver l'adresse professionnelle de l'avocat poursuivant d'une vente judiciaire

Maître, Monsieur le Bâtonnier, Madame la Bâtonnière, [choisir la formule]

Je suis [prénom nom], [fonction] d'[dénomination de la société, forme, immatriculation,
adresse]. Notre société édite immojudis.com. Ce site aide les investisseurs, souvent non
juristes, à comprendre les ventes immobilières aux enchères judiciaires et à décider en
connaissance de cause. Il présente, pour chaque vente, les informations publiées par les
tribunaux et par les avocats.

Les CGU de votre site interdisent toute reproduction ou utilisation sans « l'autorisation écrite
préalable de l'Ordre des avocats de Paris » (article 4.2, version de mai 2026). [Si l'annuaire a
ses propres conditions : les citer ici avec la date de consultation.] Je vous écris pour
demander cette autorisation avant toute utilisation.

**Ce que nous demandons**

L'autorisation d'interroger automatiquement l'annuaire des avocats, au moyen de l'interface de
recherche publique de votre site [adresse exacte de la page de recherche : à compléter après
vérification], pour retrouver l'adresse professionnelle publiée de l'avocat poursuivant d'une
vente judiciaire précise.

Aucune interrogation automatique ne sera lancée avant votre réponse écrite. À ce jour, nous
n'en avons lancé aucune sur votre annuaire.

**Pourquoi**

Certaines annonces de vente ne donnent pas l'adresse email de l'avocat qui poursuit la vente.
Nous voulons lui écrire pour vérifier des informations sur cette vente : date d'audience, mise à
prix, modalités de consultation du cahier des conditions de vente, dates de visite. Une
information exacte sert les candidats acquéreurs, et donc la vente elle-même.

**Ce que nous ne ferons pas**

- Aucune prospection ni mise en avant commerciale dans nos messages : ni offre, ni publicité, ni
  lien vers un service payant. Immojudis propose par ailleurs aux avocats des services de
  visibilité payants. Les adresses relevées dans votre annuaire ne serviront jamais à les
  promouvoir.
- Aucune copie de l'annuaire. Nous ne constituons ni fichier ni base d'avocats à partir de
  votre site. Nous ne conservons que l'adresse de l'avocat concerné par une vente, pour lui
  écrire.
- Aucun contournement : nous ne passons pas outre un blocage, une vérification ou une limite
  d'accès, et nous respectons le fichier `robots.txt` de votre site.

**Volume**

Nous estimons le besoin à quelques centaines d'avocats au plus, [chiffre à ajuster]. Chaque
interrogation concerne un seul avocat, nommé dans une annonce de vente judiciaire, au moment où
nous préparons une demande pour cette vente. Nous n'envoyons pas plus d'une demande par avocat et
par mois, toutes ventes confondues, et nous ne relançons pas.

**Garde-fous**

- Chaque message est relu et validé par une personne d'Immojudis, qui vérifie aussi que l'avocat
  trouvé est bien celui de la vente. Rien n'est envoyé automatiquement.
- Le message indique l'origine de l'adresse (votre annuaire), l'identité de notre société, ses
  droits sur ses données et un lien pour ne plus être contacté, en un clic.
- L'opposition est enregistrée aussitôt. Elle vaut pour tous nos messages et pour la personne, y
  compris sous une autre adresse. Nous ne la contactons plus.
- Des réponses peuvent être classées à l'aide d'un outil automatique. Aucune information n'est
  publiée sans décision d'une personne d'Immojudis.

**Déontologie et secret professionnel**

Nous connaissons les règles qui encadrent la profession d'avocat. Nous ne posons aucune
question qui touche au secret professionnel. Nous ne demandons pas l'avis de l'avocat, la
stratégie du créancier, la situation du débiteur ou de l'occupant, ni les chances d'une enchère.
Nos questions portent seulement sur des pièces et des informations communicables à tout candidat
acquéreur : cahier des conditions de vente, procès-verbal descriptif, diagnostics, dates de
visite, mise à prix, consignation, date d'audience. Le message précise que l'avocat répond
uniquement s'il le peut, sans obligation. Nous n'écrivons pas à un avocat identifié comme conseil
du débiteur ou de l'occupant.

**Notre engagement**

Nous respecterons les CGU du site et les conditions que vous fixerez : volume, rythme,
périmètre, durée, modalités de contrôle ou de retrait de l'autorisation. Nous nous engageons à
cesser toute interrogation sur simple demande écrite de l'Ordre. Si vous préférez une autre voie
que l'interrogation automatique (consultation manuelle, accès dédié, autre interlocuteur), nous
sommes disposés à en discuter.

Je vous remercie de me faire connaître votre décision par écrit, avec la date et le nom de la
personne qui répond, ainsi que le service à joindre pour toute question ultérieure.

Je me tiens à votre disposition par téléphone au [numéro] ou par email à [adresse].

Je vous prie d'agréer, [formule de politesse], l'expression de mes salutations distinguées.

[Prénom Nom]
[Fonction]
[Dénomination de la société, forme juridique, capital]
[Adresse]
[Immatriculation : RCS ... / SIREN ...]
[Téléphone] · [Email]
[Lieu, date]

---

## Sources consultées le 14/10/2026

- Licitor, page « Nous contacter » : https://www.licitor.com/contact.html
- Ordre des avocats de Paris, CGU du site institutionnel (art. 4.2 et 7) :
  https://www.avocatparis.org/conditions-generales-dutilisation-du-site-internet-institutionnel-de-lordre-des-avocats-de-paris
- Ordre des avocats de Paris, accueil général des avocats (mise à jour du 27 avril 2026) :
  https://www.avocatparis.org/contacts/accueil-general-des-avocats
- Cadrage juridique et RGPD du 14/10/2026 (sections 3, 4 et 6), garde-fous et décisions du
  propriétaire : `docs/equipe/2026-10-14-adresses-contacts.md`
- Fonctionnement de l'agent (validation humaine, aperçu, opposition, une sollicitation par
  adresse et par 30 jours) : `docs/runbooks/information-agent.md`

Non vérifié : conditions propres à l'annuaire des avocats de Paris (adresse inaccessible depuis
mon poste). Textes juridiques cités d'après le cadrage, à confirmer sur Légifrance par un avocat.
