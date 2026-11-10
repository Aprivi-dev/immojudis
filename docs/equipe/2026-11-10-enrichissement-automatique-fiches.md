# Enrichissement automatique des fiches à partir des réponses reçues (conception, 10/11/2026)

**Mission.** Le propriétaire veut qu'une réponse reçue par l'agent d'information soit analysée par une IA, que les
informations en soient extraites et que la fiche correspondante soit enrichie automatiquement, sans intervention
manuelle. Il a validé le lancement de la conception d'un enrichissement automatique sous conditions.

**Déroulé.** Cinq spécialistes ont travaillé en lecture seule : `architecte-logiciel`, `prompts-llm`,
`qualite-donnees`, `securite-applicative`, `juridique-rgpd`. Aucun fichier n'a été modifié. La base de production
n'a reçu que des SELECT agrégés. Aucun modèle payant n'a été appelé.

**Relecture du chef d'orchestre.** J'ai rouvert dans le code les cinq constats qui portent le plan (section 2) et
relancé moi-même l'essai hors ligne de `prompts-llm`. Les désaccords entre spécialistes sont tranchés en section 4.

---

## 1. Synthèse

L'enrichissement automatique est faisable, mais sur un périmètre étroit et après trois chantiers préalables.

- **Périmètre recommandé pour la première version : surface, surface du terrain, nombre de pièces**, uniquement
  quand le champ est vide sur la fiche. Jamais de remplacement d'une valeur existante.
- **Restent en relecture humaine** : toute contradiction avec la fiche, toute réponse ambiguë, toute pièce jointe,
  et dans un premier temps l'occupation et les visites.
- **Exclus définitivement de l'automatique** : mise à prix, date d'audience, adresse, type de bien, pièces jointes.
- **Trois préalables** : durcir l'extraction (elle laisse passer des formulations pièges), conserver la valeur
  remplacée et afficher la source sur la fiche, mettre à jour les textes juridiques qui promettent aujourd'hui une
  relecture humaine.

Gain attendu, mesuré sur les 900 ventes à venir : 233 sans surface (26 %), 552 sans nombre de pièces, 641 sans
surface de terrain (ces deux derniers chiffres surestiment le besoin : tous les biens ne sont pas concernés),
257 sans statut d'occupation (29 %), 132 sans date de visite (15 %), 847 sans classe DPE.

---

## 2. Constats vérifiés par le chef d'orchestre

| Constat                                                                                                                                              | Preuve                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| La publication exige un administrateur : un automate ne peut pas appeler la RPC actuelle sans mentir sur l'auteur                                    | `supabase/migrations/20260920144219_deterministic_information_agent_llm_request_guards.sql:37-42` |
| Une information acceptée écrase la colonne de la vente sans comparer à la valeur existante ni la conserver                                           | même migration, lignes 100-108 (surface), 133-144 (mise à prix, date)                             |
| La source « avocat poursuivant » n'est affichée nulle part : aucun fichier de `src/` ne lit `information_agent_verified_facts`                       | recherche dans `src/`, aucun résultat hors tests                                                  |
| Le message envoyé aux avocats promet une relecture : « notre équipe la relit avant toute mise à jour de la fiche »                                   | `src/lib/information-agent-email-template.ts:293`                                                 |
| Le validateur de l'extraction par IA accepte 10 formulations pièges sur 11 (conditionnel, autre lot, fourchette, tentative de manipulation, DPE/GES) | essai hors ligne relancé, sans appel de modèle                                                    |
| Le workflow d'analyse tourne sur un horaire GitHub, que la règle du projet interdit pour une tâche métier car ces horaires ne sont pas tenus         | `docs/operations/planification.md:18`, `.github/workflows/information-agent-evidence.yml:6`       |

Corrections apportées à la description initiale : la colonne des candidats s'appelle `status` (pending, conflict,
accepted, rejected), et l'affichage ne passe pas par `auction-fact-claims.ts` mais par les colonnes de
`auction_sales`.

---

## 3. Propositions

Priorité : Critique, Haute, Moyenne. Effort : S (moins d'un jour), M (un à trois jours), L (plus).

### Lot A : utile tout de suite, sans dépendance juridique

| N°  | Agent                                | Proposition                                                                                                                                                                                                                            | Priorité | Effort | Avis   |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| 1   | architecte-logiciel                  | Lancer l'analyse par l'IA dès qu'une réponse est en file, depuis la passe des réponses (toutes les 2 minutes), en gardant l'horaire GitHub en filet. Délai visé : 3 à 6 minutes au lieu de 4 à 11 heures. Aucun nouveau secret.        | Haute    | M      | Garder |
| 2   | prompts-llm                          | Durcir l'extraction : contrôle de la phrase entière (conditionnel, « environ », « selon », fourchette, renvoi), citation d'au moins 25 caractères, contrôle du lot, cohérence de la date et du DPE, retrait de « sera » et « serait ». | Critique | M      | Garder |
| 3   | prompts-llm, securite-applicative    | Détecter les tentatives de manipulation (« ignore les consignes… ») et renvoyer toute la réponse en relecture.                                                                                                                         | Haute    | S      | Garder |
| 4   | qualite-donnees, architecte-logiciel | Noyau de publication commun à l'administrateur et à l'automate, qui conserve la valeur précédente et l'auteur réel de la décision (une migration). Corrige aussi la trace « validée par un administrateur » écrite d'office.           | Critique | M      | Garder |
| 5   | qualite-donnees, juridique-rgpd      | Afficher la source sur la fiche : « Information transmise par l'avocat poursuivant le …, non vérifiée par Immojudis ». Vaut aussi pour les informations acceptées à la main.                                                           | Haute    | M      | Garder |

### Lot B : simulation, sans rien publier

| N°  | Agent                            | Proposition                                                                                                                                                                                                            | Priorité | Effort | Avis   |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| 6   | architecte-logiciel, prompts-llm | Moteur de décision « publier ou relire » et réglage à trois modes (arrêt, simulation, automatique), verrouillé sur arrêt. En simulation, l'onglet Réponses affiche « aurait été publié » à côté de chaque information. | Haute    | L      | Garder |
| 7   | securite-applicative             | Verrous : liste fermée de champs figée par un test, fonction de publication séparée et réservée au serveur, plafonds par jour et par dossier, journal en ajout seul, arrêt d'urgence.                                  | Critique | M      | Garder |
| 8   | prompts-llm                      | Jeu d'évaluation de 200 réponses fictives en 8 familles de pièges, avec un seuil de zéro publication fausse. Essai réel du modèle sur ce jeu : environ 3 USD, plafond 5 USD.                                           | Critique | L      | Garder |

### Lot C : activation, soumise aux préalables juridiques

| N°  | Agent                               | Proposition                                                                                                                                                                                                     | Priorité | Effort | Avis       |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ---------- |
| 9   | juridique-rgpd                      | Mettre à jour les textes : demande d'information, pied du message, politique de confidentialité, CGU, page d'information, mise en balance, registre, AIPD. Faire valider huit points par un avocat (section 6). | Critique | M      | Garder     |
| 10  | architecte-logiciel, juridique-rgpd | Retour arrière en un clic pour l'administrateur, retrait à la demande de l'avocat, détection de « ne pas publier » dans la réponse.                                                                             | Haute    | M      | Garder     |
| 11  | tous                                | Mode automatique pour la surface, le terrain et le nombre de pièces, champ vide seulement, avec arrêt automatique au premier retrait et récapitulatif quotidien.                                                | Haute    | M      | Garder     |
| 12  | qualite-donnees, juridique-rgpd     | Ouvrir ensuite l'occupation et les dates de visite à l'automatique, si la simulation ne montre aucune erreur.                                                                                                   | Moyenne  | M      | Discutable |
| 13  | prompts-llm, securite-applicative   | Ouvrir la classe DPE à l'automatique.                                                                                                                                                                           | Moyenne  | M      | Discutable |

### Conditions d'une publication automatique (toutes requises)

1. La réponse vient de l'adresse contactée, avec une authentification complète (DKIM et DMARC), moins de 30 jours
   après l'envoi.
2. L'information vient du corps du message, jamais d'une pièce jointe.
3. L'extraction par règles et l'IA donnent la même valeur, et la réponse n'en contient pas d'autre pour ce champ.
4. La phrase complète ne contient ni conditionnel, ni réserve, ni fourchette.
5. La vente n'a qu'un lot, ou la phrase nomme le lot de la fiche.
6. Le champ est vide sur la fiche et la valeur est plausible pour ce type de bien.
7. La réponse ne contient ni « ne pas publier », ni nom de particulier, ni motif de relecture.

---

## 4. Désaccords tranchés

| Sujet           | Pour l'automatique                                      | Contre                                                                                             | Décision du chef d'orchestre                                                                                  |
| --------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Occupation      | qualite-donnees, juridique-rgpd                         | prompts-llm (temps passé ou futur, « selon le PV »), securite-applicative (concerne des occupants) | Relecture dans la première version. À rouvrir avec les chiffres de la simulation (proposition 12).            |
| Dates de visite | qualite-donnees, juridique-rgpd (date future seulement) | prompts-llm et securite-applicative (texte libre, coordonnées de tiers)                            | Relecture tant que le champ est un texte libre. Possible plus tard avec une date structurée (proposition 12). |
| Classe DPE      | prompts-llm, securite-applicative                       | qualite-donnees (la source officielle est l'ADEME, et la valeur n'a pas de colonne sur la fiche)   | Hors première version : il faut d'abord un affichage (proposition 13).                                        |
| Type de bien    | architecte-logiciel                                     | qualite-donnees (aucune vente sans type), prompts-llm                                              | Écarté : aucun gain.                                                                                          |

---

## 5. Écartés

- **Mise à prix et date d'audience en automatique** : elles viennent de la source judiciaire et une erreur fausse
  directement une décision d'enchère.
- **Adresse en automatique** : texte libre, et le géocodage en dépend.
- **Pièces jointes et photos en automatique** : le masquage des données de tiers exige un humain.
- **Remplacement d'une valeur existante** : toute contradiction reste en relecture.
- **Nom de l'avocat sur la fiche** : « l'avocat poursuivant » suffit ; un nom pourrait laisser croire à un
  partenariat.
- **Appel direct de l'IA depuis l'application** : il faudrait dupliquer le prompt et se passer de la lecture des
  pièces.

---

## 6. Préalables juridiques (juridique-rgpd)

Avis : favorable sous conditions, sur un périmètre étroit. Ce rapport n'est pas un avis d'avocat.

- Les textes publiés et le message envoyé promettent aujourd'hui une relecture humaine. Activer l'automatique sans
  les modifier rendrait ces textes inexacts.
- Immojudis deviendrait l'éditeur d'une information qu'elle n'a pas vérifiée. Les CGU ne couvrent que les annonces
  de tiers (`src/routes/conditions-generales.tsx:300-302`). La protection passe par l'étiquetage de la source, pas
  par une clause d'exclusion.
- L'avocat doit être prévenu dans la demande, avant de répondre, et pouvoir écrire « ne pas publier ».
- L'AIPD doit recevoir un nouveau risque (publication automatique d'une information inexacte, confidentielle ou mal
  attribuée) et son risque sur les données de tiers doit être réévalué.

Points à faire valider par un avocat : article 22 du RGPD et arrêt SCHUFA ; intérêt légitime pour une publication
attribuée ; responsabilité d'éditeur et pratique trompeuse ; déontologie de l'avocat ; secret professionnel et
secret des correspondances ; article 50 du règlement européen sur l'IA ; contenu de l'AIPD et consultation
éventuelle de la CNIL ; informations concernant l'occupant.

### Textes proposés

**Demande d'information** (remplace la phrase de `src/lib/information-agent-email-template.ts:293`) :
« Ces informations manquent à la fiche ou y sont contradictoires. Une réponse même partielle nous est utile. Une IA
lit votre réponse et en extrait les informations demandées. Celles qui sont simples et sans ambiguïté peuvent être
publiées automatiquement sur la fiche, sans relecture préalable. Elles portent la mention « information transmise
par l'avocat poursuivant, non vérifiée par Immojudis » et la date de votre réponse, sans votre nom ni le texte de
votre message. Les autres informations et les pièces jointes sont relues par notre équipe. Si une information ne
doit pas être publiée, écrivez « ne pas publier » dans votre réponse. »

**Pied du message, rubrique « Utilisation de votre réponse »** :
« Votre réponse est lue par un outil d'IA qui en extrait les informations demandées. Certaines peuvent être
publiées automatiquement sur la fiche de la vente, attribuées à « l'avocat poursuivant » et datées, sans votre nom,
sans citation et sans pièce jointe. Pour faire retirer ou corriger une information publiée, répondez à ce message
ou écrivez à [contact]. Nous la retirons de la fiche dans l'attente de vérification. »

**CGU, fin de l'article 8** :
« Certaines informations d'une fiche proviennent de réponses de l'avocat poursuivant, extraites par un outil
automatique et publiées sans vérification par Immojudis. Elles sont signalées comme telles, avec leur date. Elles
peuvent être incomplètes, périmées ou mal extraites. Seuls le cahier des conditions de vente et les pièces de la
procédure font foi : vérifiez-les avant d'enchérir. Signalez toute erreur à [contact] ; nous la corrigeons ou la
retirons dans les meilleurs délais. »

**Libellé sur la fiche** :
« Surface : 54 m². Information transmise par l'avocat poursuivant le 12/11/2026, extraite automatiquement, non
vérifiée par Immojudis. Vérifiez dans le cahier des conditions de vente. [Signaler une erreur] »

La liste des champs cités dans ces textes est à aligner sur le périmètre finalement validé. Les autres textes
(politique de confidentialité, page d'information, mise en balance, registre, AIPD) suivent la même ligne et seront
rédigés au moment de la proposition 9.

---

## 7. Points non vérifiés

- Le comportement réel du modèle sur les formulations pièges : seul le validateur a été éprouvé, sans appel de
  modèle.
- L'effet d'une nouvelle collecte de l'annonce sur une valeur déjà publiée : le pipeline pourrait l'écraser sans le
  signaler.
- La fiabilité des résultats d'authentification transmis par Resend dans le cas d'un transfert d'email.
- La durée réelle de l'analyse par message une fois déclenchée à la demande.
- L'effet d'une opposition reçue après publication : aujourd'hui elle bloque les contacts mais ne retire rien.
