# Protocole de validation des réponses avec pièces jointes

## Périmètre et règle d'exploitation

L'envoi reste réservé au back-office administrateur. Aucun essai ne doit envoyer d'email à un contact réel sans autorisation explicite. L'indicateur `INFORMATION_AGENT_OUTBOUND_ENABLED` reste désactivé. Les essais utilisent des boîtes de test et des annonces fictives. Une publication du code ou du modèle de mail ne constitue pas une autorisation d'envoi.

## Comportement attendu

- Le mail demande toujours des photos récentes, de préférence JPG/PNG, même si l'annonce a déjà des images. Il conseille moins de 10 Mo par fichier et des réponses séparées de 20 Mo maximum.
- Le contact répond à l'adresse liée au dossier. Les pièces de chaque réponse sont rattachées au bon `case_id`, `message_id` et `sale_id` ; un expéditeur différent ne produit pas de données publiables.
- Les pièces sont paginées, le téléchargement est borné à 20 Mo par fichier et 40 Mo par réponse. Au-delà de 500 pièces ou si un format/taille est refusé, la réponse passe en revue manuelle avec un motif visible.
- Les vidéos ne sont pas ingérées et leur disponibilité est seulement demandée dans le mail. Aucun lien externe n'est ouvert automatiquement.
- Les originaux autorisés restent dans le stockage privé. À l'acceptation admin, la photo publiée est un WebP sans EXIF, de 1 920 px maximum et de 2 Mo maximum. Une conversion impossible bloque la publication de cette photo.

## Mises en situation de test

| Scénario | Données de test | Résultat exigé |
| --- | --- | --- |
| Réponse simple | Texte et 2 JPEG | Les faits et 2 photos sont candidats du bon dossier, sans publication automatique. |
| Photos nombreuses | 101 JPEG, pagination Resend en 2 pages | 101 pièces listées ; aucun oubli silencieux. |
| Plusieurs réponses | Deux emails du même contact, 15 puis 15 photos | Deux messages distincts, même dossier, 30 candidats associés. |
| Dépassement de volume | Taille annoncée faible, flux réel trop grand ; cumul > 40 Mo | Lecture arrêtée à la limite ; rejet motivé, autres pièces conservées. |
| Format illisible | Faux PNG, HEIC non décodable, JPEG corrompu | Aucun original illisible publié ; motif de conversion ou d'analyse visible. |
| Vidéo | MP4/MOV en pièce jointe | Vidéo refusée et signalée en revue ; aucune publication. |
| Mauvais expéditeur ou dossier | Réponse depuis une autre adresse ou adresse de dossier contradictoire | Aucun candidat publiable ; rattachement erroné impossible. |
| Photos intégrées à la signature | Logo inline et photos de bien | Revue humaine capable d'écarter le logo ; pas de publication automatique. |
| Reprise après erreur | Échec stockage après plusieurs pièces, puis nouvelle livraison du même webhook | Pas de doublon ; reprise des pièces manquantes. |
| Publication | JPEG/PNG/WebP valides de dimensions et poids variés | Le média public est WebP ≤ 1 920 px et ≤ 2 Mo, sans EXIF ; l'original privé reste lié à la preuve. |
| 500+ pièces | 6 pages de pièces jointes | Traitement borné, troncature et revue manuelle explicites. |

## Critères avant tout essai avec des contacts réels

1. Exécuter les tests unitaires, les tests d'intégration avec Resend et Supabase de test, puis vérifier chaque scénario du tableau avec des boîtes contrôlées. Vérifier les noms, tailles, hashes et identifiants en stockage et en base.
2. Chronométrer des réponses de 20 et 40 Mo avec photos multiples. Le webhook traite encore les téléchargements de façon synchrone ; si la durée approche la limite d'exécution, déplacer la réception vers une file durable avant l'essai réel.
3. Vérifier le décodage HEIC/HEIF sur l'environnement de déploiement ou les retirer de l'allowlist. Vérifier la disponibilité des vidéos uniquement par réponse textuelle tant qu'un canal dédié n'existe pas.
4. Vérifier que l'admin peut consulter toutes les pièces, écarter les logos/signatures, confirmer les droits et contrôler la version compressée avant acceptation. L'aperçu intégré n'est pas encore présent dans le panneau de revue.
5. Conserver l'envoi désactivé jusqu'à autorisation explicite ; activer d'abord un essai supervisé sur une adresse possédée par l'équipe.

## Vérifications automatisées de ce changement

`information-agent-attachments.test.ts` couvre la pagination au-delà de 100 pièces, l'arrêt d'un flux trop grand, la conversion JPEG/PNG/WebP, la taille/dimension du dérivé et le refus d'une image corrompue. `information-agent-email-template.test.ts` vérifie les consignes photo et vidéo. Les scénarios de bout en bout ci-dessus restent à exécuter dans un environnement de test isolé ; ils ne sont pas déduits des seuls tests unitaires.
