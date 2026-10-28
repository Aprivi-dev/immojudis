# Synthèse hebdomadaire des retours

Rituel du lundi, **30 minutes**, pour le propriétaire (n° 91 du compte-rendu du 27/10/2026, rapport
`synthese-retours`). Il sert à répondre à une seule question : _qu'est-ce que les personnes qui
utilisent le site nous disent, et qu'en décide-t-on cette semaine ?_

Aucun retour d'utilisateur externe n'était cité dans `docs/equipe/` au 27/10/2026 : tous venaient
du fondateur. Ce rituel commence donc par ranger ce que le site recueille déjà.

## Les canaux

| Canal                                          | Où le lire                                                                                          | Ce qu'il juge                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Formulaire de contact et « Signaler »          | Boîte de contact (email). Le lien « Signaler une erreur » de la fiche porte la vente et la rubrique | Erreurs de données (date, prix, plafond, pépite)   |
| « Utile / Pas pertinent » (3 signaux)          | `/admin/pilotage` (agrégats) ; `/admin/pepites` et `/admin/quality` (par vente)                     | Bande d'écart au marché, points à vérifier, pépite |
| « Me prévenir de l'ouverture » + questionnaire | `/admin/pilotage`, carte « Questionnaire de la liste d'attente »                                    | Profils, repères de prix (déclaratifs), entretiens |
| Événements d'usage                             | Console Vercel Analytics ; `/admin/pilotage` (par compte)                                           | Parcours, essai, pépite, accueil                   |
| Inscriptions                                   | `/admin/inscriptions` (colonnes d'usage, filtre « essai fini sans activité »)                       | Essais qui finissent, comptes sans activité        |

Hors de ce rituel : les emails entrants de l'agent d'information (`/admin/agent-ia`) sont des
réponses de tiers (tribunaux, avocats), pas des retours d'utilisateurs. Toute demande de ne plus
être contacté va le jour même à `juridique-rgpd`.

Absents de la mesure : les visiteurs anonymes (le bouton « Utile » exige un compte), ceux qui
partent sans écrire, et le compte administrateur (exclu des agrégats).

## Parcours (dans cet ordre)

1. **Boîte de contact.** Une ligne par message dans une feuille hors dépôt, sans nom ni email,
   identifiant `R1`, `R2`… (thème, profil, gravité, volume ci-dessous).
2. **Accueil de l'admin**, carte « Retours de la semaine », puis `/admin/pilotage` : « Retours sur
   les signaux d'une vente », « Questionnaire de la liste d'attente », « Intérêt pour l'offre
   Analyse », « Parcours ».
3. **`/admin/inscriptions`** : nouveaux comptes sur 7 jours, essais qui finissent dans la
   semaine, filtre « Essai fini sans activité ».
4. **`/admin/pepites`** : compteurs, presque-pépites, et le tableau « Retours "Pas pertinent" sur
   le repère Pépite, par vente ».
5. **`/admin/quality`** (tableau des retours par vente sur les points à vérifier et l'écart au
   marché), `/admin/compliance`, `/admin/agent-ia` (réponses reçues).
6. **Vercel Analytics** : `signup_submitted` (par `entry`) puis `signup_confirmed`,
   `home_example_used`, `sample_report_viewed`, `pepite_block_viewed`, `pepite_filter_used`,
   `opening_notification_requested`.

## Grille de classement

- **Thème** : lenteur, exactitude des données, compréhension de la pépite, plafond, essai et
  prix, inscription, alertes, avocats, autre. Au troisième retour sur « pépite et plafond », ce
  thème a sa propre ligne.
- **Profil** : débutant, aguerri, marchand de biens, avocat, inconnu. Seul le questionnaire donne
  aujourd'hui un profil (4 valeurs).
- **Gravité** : bloque l'usage ; fait douter de l'exactitude ; gêne ; souhait.
- **Volume** : nombre de messages, de comptes distincts, du canal. Sous 30 comptes
  (`PILOTAGE_MIN_ACCOUNTS`), lecture qualitative seulement, jamais de pourcentage.

## Règles

- **Une erreur de date, de prix ou de localisation sort du cycle** : traitée le jour même (vers
  `qualite-donnees`), pas le lundi suivant.
- **Toute demande de droits ou « ne plus me contacter »** : le jour même, `juridique-rgpd`.
- Chaque semaine, **une décision par thème qui revient** (corriger, expliquer, attendre avec une
  date de relecture). Les décisions vont dans le compte-rendu de la semaine (`docs/equipe/`).
- Le tableau « Retours par vente » donne des nombres, jamais un compte. Ne pas chercher à
  identifier qui a répondu.

## Biais à rappeler à chaque lecture

- Les mécontents et les enthousiastes écrivent plus que les autres.
- Les premiers testeurs sont des proches.
- L'essai gratuit fausse la perception du prix.
- Les repères de prix du questionnaire viennent de personnes qui se sont inscrites elles-mêmes à la
  liste d'attente : ce ne sont pas des intentions d'achat.
- Quelques retours ne font pas une tendance.

## Pour aller plus loin

- Règle de décision chiffrée de l'essai et de la pépite :
  [mesure-essai-et-pepite](../operations/mesure-essai-et-pepite.md).
- Séances avec des utilisateurs : [etude-utilisateurs](../operations/etude-utilisateurs.md).
