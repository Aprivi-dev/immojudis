# Validation de l'extraction des annonces — 28 septembre 2026

## Ce qui est mesuré

Le corpus versionné `services/data-pipeline/tests/fixtures/extraction_corpus.json` contient
11 cas synthétiques annotés. L'évaluateur
`services/data-pipeline/scripts/evaluate_extraction_corpus.py` compare les champs présents,
les absences, les valeurs explicitement inconnues et l'identité des lots. Le dernier passage
avant cette mise à jour donne 183 valeurs présentes correctes sur 183, 24 absences conservées,
2 inconnues conservées et aucune erreur d'identité de lot. Ces résultats vérifient les règles
sur ces cas ; ils ne mesurent pas la précision des dix sources en production.

Le fichier `services/data-pipeline/config/qualification-sample-20260912.json` fixe 100 URL
réparties sur dix sources. Il ne contient pas de vérité terrain annotée. Le script
`services/data-pipeline/src/quality_sample_audit.py` compare la fiche stockée avec une nouvelle extraction de la
source : une égalité ne prouve pas que la source ou le parseur a raison, et une différence
demande une revue humaine. Les captures locales et les documents OCR contiennent des données
personnelles et restent hors Git.

## Régression issue d'une capture réelle

La lecture d'un procès-verbal public a révélé la formulation « libres de toute occupation ».
Elle n'était pas reconnue au pluriel. Les tests ajoutés reproduisent uniquement cette courte
formulation et vérifient que « visite libre » et « photos libres de droits » ne deviennent pas
une preuve de vacance. Le document complet et son texte OCR ne sont pas ajoutés au dépôt.

## Prochaine mesure sur sources réelles

1. Prélever un échantillon stratifié par source, type de bien, document disponible et état
   d'accès. Conserver séparément les sources inaccessibles et les annonces sans preuve ; ne
   jamais les compter comme des extractions exactes.
2. Stocker les captures dans un espace privé avec URL, date, empreinte du document et repère de
   page. Retirer les coordonnées et données personnelles avant toute fixture publiée.
3. Faire annoter indépendamment par deux personnes les champs décisionnels (lot, date,
   mise à prix, surfaces par nature, occupation, pièces, stationnement). Résoudre les désaccords
   en conservant la citation et son emplacement.
4. Publier les dénominateurs et les erreurs par source et par champ : valeur correcte,
   valeur incorrecte, champ omis, absence justifiée, inconnu et confusion de lot. Présenter
   séparément les métriques synthétiques et les métriques réelles, avec la taille des
   échantillons. Une comparaison entre fiche et source sans annotation humaine reste un
   signal de contrôle, jamais un taux de précision.

Cette mesure doit précéder toute affirmation de fiabilité globale ou activation supplémentaire
des sources et des envois à de vrais interlocuteurs.
