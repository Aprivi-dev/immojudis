# Offre Pro pour les ventes immobilières — feuille de route produit interne

_Proposition initiale du 23 septembre 2026. Mise à jour : 28 septembre 2026. Document interne de découverte et de décision ; il ne constitue ni une promesse commerciale, ni une autorisation de créer un abonnement payant._

## Décision de classement

Cette feuille de route est conservée comme **chantier produit séparé** du nettoyage et du durcissement de l’agent d’enrichissement par email. Le choix actuel est de classer et préciser ce chantier ; l’abonnement Pro payant, Stripe, les droits et le parcours commercial ne sont pas construits dans cette passe.

Le socle de pilotes professionnels existe déjà en production via les PR 168 et 171 : espaces tribunal, notarial et domanial, entrée depuis les pages de vente et suivi manuel. La production est maintenant au commit de la PR 175 (`3206125c`). Ces pilotes ne constituent pas un abonnement Pro commercialisé.

## État actuel et périmètre manquant

| Sujet                  | État au 28 septembre 2026                                                                                                                        | Décision                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Pilotes professionnels | Livrés par les PR 168 et 171 ; ils servent à apprendre et à qualifier les dossiers.                                                              | Conserver et mesurer séparément.                            |
| Plans et droits        | `src/lib/plans.ts` expose toujours `decouverte` et `analyse`. Analyse inclut déjà exports, API, rapports, comparables, alertes et collaboration. | Ne pas appeler ces droits « Pro ».                          |
| Facturation            | Analyse est vendue pour 30 jours ; les webhooks historiques normalisent encore vers `analyse`.                                                   | Aucun abonnement récurrent Pro à activer.                   |
| Produit Pro            | Note de décision sourcée, contrôle humain borné, scénarios reproductibles et suivi des changements restent à spécifier et tester.                | Découverte et pilote assisté avant de coder les droits.     |
| Sources                | Les accès et droits de collecte sont inégaux, en particulier pour le domanial.                                                                   | Ne promettre ni fraîcheur uniforme ni couverture nationale. |

## Hypothèse de produit à tester

Le segment initial à interroger est celui des marchands de biens et petites équipes d’acquisition qui étudient plusieurs dossiers chaque mois. L’hypothèse de prix initiale est **249 € par mois**, dans une fourchette de 200 à 300 €, mais elle ne vaut ni tarif décidé ni preuve de disposition à payer.

La promesse à tester est un dossier d’aide à la décision : faits critiques sourcés, inconnues visibles, scénarios financiers dont les hypothèses sont explicites et prochaine action adaptée à la procédure. La génération ou l’envoi d’une offre ou d’une enchère restent hors périmètre initial. Un contrôle humain ne remplace pas l’avis d’un avocat, d’un notaire ou d’un conseil financier.

## Jalons proposés

| Étape                              | Livrable                                                                                                                                   | Condition de passage                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 0. Valider l’achat et les sources  | 10 à 12 entretiens, 5 pilotes réellement engagés, mesure du temps par dossier et audit de dossiers tribunal/notariaux/domaniaux.           | Cas récurrent, prix réellement accepté et sources utilisables. Sinon réviser l’offre.                 |
| 1. Registre de preuves et dossiers | Faits typés avec source/page/date, statuts `vérifié/à confirmer/conflit`, file de revue, profil d’investissement et scénarios calculables. | Aucun fait critique partageable sans provenance ; RLS, confidentialité et reproductibilité vérifiées. |
| 2. Pilote tribunal                 | Note d’adjudication, occupation, frais, visite, audience, sensibilités et paquet partageable sur au moins 20 dossiers variés.              | Zéro fait critique erroné dans les notes relues ; gain de temps mesuré.                               |
| 3. Pilote notarial                 | Distinction vente interactive/adjudication, règles de visite et d’agrément, fenêtre d’offres et dossier partageable.                       | Aucune confusion de procédure ; chaque délai est sourcé.                                              |
| 4. Pilote domanial                 | Mode de cession, pièces, canal de dépôt, rapprochement cadastral/urbanisme/risques et suivi des avenants.                                  | Accès autorisé et stable ; sinon bêta assistée sans promesse de veille.                               |
| 5. Facturation et lancement limité | Seulement après validation : code `pro`, droits serveur/RLS, Stripe récurrent, impayé/annulation, quotas, support et liste d’attente.      | Webhooks et permissions testés de bout en bout ; critères économiques et qualité atteints.            |

## Mesures avant toute décision commerciale

- temps de qualification avant/après et temps de revue humaine par dossier ;
- faits critiques corrigés, conflits détectés et sources manquantes ;
- dossiers ouverts, étudiés, partagés et décisions prises ;
- coût variable réel par client : analyste, acquisition, IA/OCR, stockage, support et paiement ;
- renouvellements réellement payés et motifs d’abandon sur deux cycles ;
- fraîcheur par source et taux de reprise lorsque l’accès échoue.

Tester un quota de contrôle factuel et un délai cible seulement après mesure du coût. Ne pas figer le quota, le prix ou le nombre de dossiers inclus sur des intentions déclarées.

## Ce qui est explicitement hors de cette passe

La feuille de route ne déclenche pas :

- l’ajout de `pro` dans la matrice de plans ;
- une migration de droits ou de RLS ;
- un abonnement Stripe récurrent ;
- une page commerciale, une promesse de délai ou une facturation de pilote ;
- une prédiction judiciaire présentée comme validée ;
- une garantie de fraîcheur pour une source dont l’accès reste instable.

Le document sera rouvert après les entretiens et le pilote assisté. Tant que ces décisions n’ont pas été prises, les pilotes professionnels déjà publiés restent un outil d’apprentissage et l’offre Pro reste une proposition interne.
