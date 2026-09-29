# État de la file avant publication — 29 septembre 2026

## Relevé de production en lecture seule

Au 28 septembre 2026 à 21 h 50 UTC, la file compte 6 029 tâches non
terminales, dont 5 989 éligibles immédiatement : 2 906 descriptions,
2 602 détails de source, 413 PDF et 68 extractions de faits. Parmi les
tâches éligibles, 3 099 ont plus de 48 heures. Les 24 heures précédentes
comptent 825 tâches terminées, soit environ 34 par heure. Le stock
nécessiterait donc environ sept à huit jours au débit observé, **sans aucune
nouvelle entrée**. Il s'agit d'une estimation de capacité, pas d'une prévision
de résorption.

Le cron de dispatch tourne toutes les 15 minutes. Le planificateur actuel
donne la priorité à une collecte de source dès qu'elle est due ; le worker
d'enrichissement n'est ainsi déclenché qu'environ toutes les 60 à 90 minutes.
Sur 48 heures, 36 workers ont été lancés, dont 14 réussis et 22 en échec.
Le contrôle `operational-health` échoue fréquemment sur un délai SQL. Ces
constats empêchent de qualifier la fraîcheur durable des fiches.

La revue des diagnostics du 13 septembre montre trois réponses HTTP 500
consécutives du dispatch avec `canceling statement due to statement timeout`.
La requête responsable n'est pas encore isolée par un plan SQL. Les journaux
de collecte montrent aussi un blocage du parseur Vench dans BeautifulSoup,
terminé par le watchdog global après cinq minutes : le parseur tourne dans
un thread, où son `SIGALRM` local ne peut pas l'interrompre. Des liens sociaux
ont été présentés comme documents PDF, et Petites Affiches a rencontré des
séquences `301` puis `400` du relais. Ces échecs doivent être corrigés ou
circonscrits avant de conclure que la seule priorité du planificateur suffit.

## Corrections proposées dans la PR 179

La migration `20260928215139_queue_scheduler_fairness.sql` laisse la file
préempter une source due pendant une heure au maximum ; une source plus en
retard reprend la priorité. Le worker alterne les tâches de détail et les
autres enrichissements lorsque l'arriéré dû de ces derniers est plus grand.
Une lecture PostgreSQL facultative, bornée à une tentative de connexion de
trois secondes, à une seconde d'attente de verrou et à trois secondes
d'exécution SQL, guide ce ratio ; les claims SQL restent l'autorité et le
worker revient au cycle historique si la lecture échoue.

Les collecteurs Vench et Avoventes sont lancés dans des sous-processus
terminables avec une limite de 30 minutes ; leurs lots déjà vérifiés sont
transmis au parent pour conserver la publication progressive. Les huit autres
sources conservent leur chemin d'exécution actuel. Les URL sociales et les médias sont écartés avant
la file PDF ; les réponses documentaires 401/403, 404/410 et non exploitables
sont signalées puis revérifiées après leur fenêtre de cache de 24 heures.
Le relais ne réécrit vers HTTPS que les redirections canoniques Petites Affiches
observées sur le même hôte et les chemins publics autorisés. La version 3 de
`source-fetch-relay` a été déployée séparément le 29 septembre pour un
contrôle ciblé, détaillé ci-dessous. Comme le worker automatique de `main`
ne dispose pas encore de la garde d'identité des anciennes fiches, la version
4 a rétabli le comportement antérieur de la version 2 avant leur traitement
automatique. Les autres correctifs sont
dans la branche ou dans les migrations mentionnées ci-dessous.

La migration `20260928230000_optimize_pipeline_health_and_retention.sql`
réduit le coût du contrôle de fraîcheur. Le rejeu Supabase local, l'application
des 12 migrations en production et le contrôle de dérive ont réussi ; il reste
à mesurer la santé et la fraîcheur après un cycle complet. Aucune de ces
corrections ne crée à elle seule de capacité CPU, réseau, OCR ou LLM.

## Critère de publication

La branche reste en brouillon tant que la CI et CodeQL ne sont pas verts sur
son commit exact, y compris le rejeu des migrations et l'intégration locale,
que l'essai fournisseur limité à une adresse de test n'est pas vérifié et que
le contrôle de santé en production n'est pas rétabli. Une mesure sur au moins
un cycle complet de collecte doit montrer une file éligible en diminution,
sans dégrader la fraîcheur des sources. La seule baisse du stock ne suffit pas :
les tâches de plus de 48 heures doivent être résorbées ou explicitement
quarantainées avec un motif exploitable. Les échecs Vench, PDF et relais
doivent être absents ou également quarantainés dans les nouveaux runs. Les
21 champs non résolus par la revue IA et les 11 citations non vérifiées ne
peuvent pas alimenter une valeur présentée comme confirmée.

## Maintenance interne autorisée et exécutée

L'utilisateur a autorisé explicitement cette étape le 29 septembre. Le canari
Resend a envoyé un seul message à `delivered@resend.dev` (HTTP 200, identifiant
`01a0ec1c-662f-7570-9da7-1f231e2b3a35`) avec un environnement isolé, sans
annonce ni contact réel. L'envoi aux interlocuteurs reste désactivé.

Le relevé de production du 29 septembre à 07 h 38–07 h 41 UTC compte 6 126
tâches non terminales : 3 479 enrichissements et 2 647 détails de source.
Parmi elles, 6 092 sont dues et 3 134 ont plus de 48 heures. La fraîcheur
constatée est de 2 355 annonces sur 3 144 (74,9 %). Ces nombres sont le point
de comparaison de la maintenance et ne valident pas la publication.

Les 12 migrations de la PR 179 ont été appliquées au commit
`37df1a4c023da3bb9a8f41b021fdab21f1d23a3a` par le
[workflow de maintenance](https://github.com/Aprivi-dev/immojudis/actions/runs/36538092013).
L'historique distant contient leurs 12 versions ; le contrôle de dérive du
schéma a réussi. La nouvelle fonction de fraîcheur répond en lecture seule.

La migration a aussi programmé un appel toutes les deux minutes à
`/api/cron/information-agent-inbound`, route encore absente du site public
(HTTP 404 sur `immojudis-dezt.vercel.app`, HTTP 401 sur la prévisualisation de
la PR). Le cron `immojudis-information-agent-inbound` a donc été suspendu en
production avant tout essai de réception. Il devra être réactivé après la mise
en ligne de la route, puis sa réponse authentifiée et son suivi de santé
devront être vérifiés. Le worker d'enrichissement du commit validé a été lancé
séparément par le
[run 36538417993](https://github.com/Aprivi-dev/immojudis/actions/runs/36538417993).
Le run a réussi à 08 h 08 UTC : 32 tâches traitées en 1 424,5 secondes,
réparties également entre détail de source et enrichissement, avec un plus
long lot de détail à 163,1 secondes pour deux claims. Il s'est arrêté sur
son budget de temps, sans expiration de claim observée. Sept tâches PDF
ont échoué avec `Document extraction incomplete; retry required` ; le
diagnostic montre un certificat intermédiaire TLS non transmis par Cessions
État, des pages quasi vides qui font échouer l'OCR chez Info Enchères et des
pages image seulement ou très longues chez Vench. Les documents incomplets
restent signalés comme tels ; le correctif TLS ciblé et la politique de
reprise OCR doivent être vérifiés avant de clore ces incidents. Deux tentatives
Petites Affiches ont rencontré `301` puis `400` avant le déploiement du relais
version 2.

L'[audit cloud en lecture seule](https://github.com/Aprivi-dev/immojudis/actions/runs/36541112205)
effectué après ce déploiement a certifié 245 URL uniques Cessions État et
632 Petites Affiches sans erreur d'inventaire. Entre 08 h 10 et 08 h 14 UTC,
les 93 appels au relais version 2 observés dans les journaux Supabase ont tous
répondu HTTP 200. Un prochain cycle `source_detail` doit encore confirmer
la correction des redirections de fiches, car les deux échecs du worker ont
précédé le déploiement du relais.

À 08 h 10 UTC, la file non terminale est passée de 6 126 à 5 991 tâches,
dont 5 989 dues et 3 093 dues depuis plus de 48 heures. Ce différentiel
comprend les annulations de tâches supplantées par une révision d'entrée plus
récente et l'activité du pipeline régulier ; il ne mesure donc pas à lui seul
le débit net du nouveau worker. Quatre alertes opérationnelles restent
ouvertes, dont `cron.stale` et `valuation.queue.degraded` critiques. Le run
planifié sur `main` a démarré après celui de maintenance. Le critère de
publication reste non satisfait.

Les contrôles `operational-health` de 07 h 45, 08 h 00 et 08 h 15 UTC ont
réussi en 1,8 à 4,3 secondes après plusieurs délais SQL antérieurs à la
migration. Ils continuent de signaler quatre alertes : l'appel inbound est
volontairement suspendu tant que sa route n'est pas publiée ; les autres
cron obsolètes (`cnb-lawyer-directory` et `precompute-valuations`), la file
de valorisation et l'échec d'import AGRASC restent à traiter séparément.
Le [run planifié sur `main`](https://github.com/Aprivi-dev/immojudis/actions/runs/36538496575)
a échoué sur deux URL publiques AGRASC nouvellement découvertes, une fiche
opérateur notarial et une page vendeur Agorastore, qui n'ont pas été émises.

Le [contrôle de 10 fiches Petites Affiches avant la version 3](https://github.com/Aprivi-dev/immojudis/actions/runs/36542487879)
n'avait pu en récupérer que 2. Le [même contrôle après la version 3](https://github.com/Aprivi-dev/immojudis/actions/runs/36543683179)
en récupère 8 ; les 2 autres ne figurent plus dans l'inventaire courant et
nécessitent une vérification distincte de leur conservation. Le statut
`review_required` est appliqué par le programme d'audit à toute fiche
récupérée : il n'indique pas à lui seul une anomalie. Les comparaisons de
champs montrent toutefois au moins un écart sur 5 de ces 8 fiches. Quatre
d'entre elles renvoient une ville différente de celle de l'ancienne URL,
accompagnée de changements de date et de prix ; ces réponses doivent être
rejetées pour l'identité d'annonce avant mise à jour. La cinquième, stockée
comme Juvisy-sur-Orge, ne donne pas de ville exploitable sur la page renvoyée
et affiche un prix de 290 000 € au lieu de 30 000 € en base ; son identité et
sa provenance doivent être vérifiées avant
toute correction du prix. La garde de ville ajoutée au worker protège les
quatre premiers cas. Une seconde garde rejette le détail Juvisy, qui ne donne
aucune ancre d'identité exploitable. Ces gardes doivent encore être exercées
par un run sur le commit corrigé avant de conclure sur les données stockées.
Le relais de production est revenu en version 4 active, contenant les fichiers
de la version 2 : les anciennes redirections non vérifiables échouent donc
à nouveau au lieu de fournir une autre fiche à l'ancien worker. La version
avec redirections de détail ne doit être redéployée qu'avec le worker doté
des gardes d'identité.

Le correctif PDF en branche utilise uniquement le certificat intermédiaire
public vérifié pour le domaine exact Cessions État, et classe comme presque
vides les pages demeurées sans texte après OCR seulement si leur rendu a moins
de 0,5 % de pixels sombres. Le PDF original et la preuve d'échec OCR restent
conservés ; la couverture documentaire est alors partielle. Les pages image
riches demeurent incomplètes et réessayables. Ces modifications nécessitent
encore la CI et une mesure de production ciblée.

À 09 h 00 UTC, une autre lecture de la file compte 6 067 tâches non
terminales, 6 063 dues et 3 122 dues depuis plus de 48 heures. Le flux de
nouvelles tâches a donc dépassé la baisse observée après le worker de
maintenance ; la résorption durable reste à démontrer. Les quatre alertes
opérationnelles précitées sont encore ouvertes.

Le [run Avoventes de `main` à 08 h 45 UTC](https://github.com/Aprivi-dev/immojudis/actions/runs/36544708613)
a publié progressivement 23 identités puis s'est arrêté avec le code 245.
Le diagnostic de pile déclenché à 300 secondes montrait BeautifulSoup dans
un thread lors de la lecture d'une fiche ; il ne démontre pas à lui seul la
cause exacte de l'arrêt 20 secondes plus tard. Le garde de parsing de dix
secondes ne s'applique pas aux threads. La branche isole maintenant Avoventes
dans un processus enfant terminable, comme Vench, pour borner ce parcours ;
le correctif doit être validé sur un run de source avant publication.

À 09 h 21 UTC, la file compte 6 099 tâches non terminales, dont 6 096 dues
et 3 124 dues depuis plus de 48 heures. La baisse transitoire du premier
worker n'a donc pas produit de résorption durable. Le débit du canari
(`32` tâches en `1 424,5` secondes) équivaut à environ 81 tâches par heure
de calcul actif ; ce n'est pas une capacité garantie face aux nouveaux lots,
aux échecs de fournisseurs et à la sérialisation des workflows. Aucune hausse
de concurrence n'est engagée sans mesure des claims et des limites fournisseurs.

La branche ajoute une classification stricte des URL d'opérateurs AGRASC.
La page vendeur Agorastore, qui n'identifie aucun bien, reste dans la preuve
d'inventaire avec un motif d'exclusion explicite. Une fiche produit
Agorastore accepte seulement la redirection canonique vers l'origine connue,
avec vérification de l'identifiant produit et du `robots.txt` de l'origine
finale. La page Trocadéro fournit ses faits français, contacts et documents
PDF de même origine ; une surface Carrez reste distincte d'une surface
habitable. Ces changements et l'isolation Avoventes ont passé leurs tests
locaux ciblés. Ils attendent la CI sur le nouveau commit et un cycle de
collecte représentatif.

La migration `20260929091424_operational_health_manual_jobs.sql`, encore en
branche, retire du contrôle `cron.stale` les jobs CNB et pré-calcul de
valorisation, volontairement manuels. Elle laisse le contrôle de l'inbound,
de la file de valorisation et de la file d'enrichissement en place. Son bloc
SQL a été exécuté sur une instance PostgreSQL jetable avec la définition
production ; le rejeu intégral et le test pgTAP attendent la CI du commit.
La file de valorisation compte environ 2 881 tâches dues : l'endpoint existant
traite au plus 100 lignes par appel et 75 par défaut, avec une durée maximale
de 300 secondes. Une relance en série ne pourra commencer qu'après contrôle
de sa configuration de production, de l'absence de job concurrent et de la
première réponse canari ; aucun vidage automatique de cette file n'est lancé.

## Vérifications du commit suivant

Le commit `de32c6bd` a passé les tests Python 3.11/3.12, CodeQL, le rejeu
complet des migrations avec pgTAP, les tests des parcours et la
prévisualisation Vercel. Le contrôle web s'est arrêté sur une règle de taille :
`pdf_enrichment.py` avait 1 596 lignes pour une limite de 1 500. Le commit
`310f8cbe` extrait le transport documentaire dans son propre module et ramène
le fichier à 1 457 lignes ; ses 123 tests PDF et de fiabilité ont passé
localement. Sa CI complète, y compris le budget web, le rejeu Supabase avec
pgTAP et le parcours Playwright, est verte.

L'[inventaire AGRASC du premier commit](https://github.com/Aprivi-dev/immojudis/actions/runs/36550732573)
a montré une page vendeur générique visible dans la preuve publique mais non
émise par le parseur. Elle figurait alors comme URL non traitée, malgré le
test de l'exclusion sur une ligne émise. Le second commit classe maintenant
les URLs vendeurs directement depuis la preuve de catalogue, avec un motif
explicite, et préserve le caractère partiel des anciennes cartes vendues sans
identifiant. Le second inventaire réel a confirmé le classement dans le
certificat du collecteur, mais le certificat recalculé par l'audit indépendant
conservait cette URL comme non traitée. Une correction de l'audit redérive
cette exclusion depuis les URLs publiques tracées ; son prochain inventaire
doit confirmer les deux certificats.

L'[audit de quatre sources en lecture seule](https://github.com/Aprivi-dev/immojudis/actions/runs/36550193394)
a réussi. Il a relevé une ancienne URL Cessions État répondant 404, qui reste
non vérifiée. Sur une fiche AGRASC de local commercial en copropriété à Nice,
la page opérateur donne 70,53 m² Carrez et 4 609 m² de parcelle. Le second
commit conserve la parcelle comme preuve avec une portée « copropriété » et
cesse de la présenter comme le terrain privatif du local.

À 09 h 49 UTC, la file compte 6 116 tâches non terminales, dont 6 113 dues
et 3 124 dues depuis plus de 48 heures. Vingt-huit jobs ont épuisé quatre
tentatives. Vingt-et-un sont liés au texte PDF ou à la qualité d'un résumé
IA et seront candidats à un rejeu contrôlé après correction ; deux détails
AGRASC pourront être reconsidérés après l'adaptateur. Quatre détails
Notaires ont été retirés de l'inventaire actuel : leur API répond 400 et leurs
pages publiques 410, alors qu'une annonce active répond 200 sur la même API.
Un détail Cessions État répond 404. Ces cinq dernières URL ne doivent pas
être réessayées à l'identique. Le worker de la branche les classera en revue
permanente ; sa mise en production reste soumise au critère de publication.

La revue IA seule des 73 captures a produit 21 champs indécidables et 11
citations de type de bien non vérifiées. Le manifeste de cette revue n'est
pas encore relié durablement aux identités canoniques des fiches ; une fiche
authentifiée peut donc afficher une valeur litigieuse comme une donnée
ordinaire. Ce lien et un affichage explicite des champs non résolus restent
un blocage de publication, même si aucune relecture humaine n'est demandée.
