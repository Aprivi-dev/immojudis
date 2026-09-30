# État de la file avant publication — 29 septembre 2026

## Synthèse actuelle — 30 septembre, 22 h 35 UTC

| Chantier | État vérifié |
| --- | --- |
| SQL et CI | `e3deadf6` : CI/CodeQL verts, 2 091 tests Python par version, 1 481 assertions pgTAP, Next.js 16.3.8 et audit production à zéro vulnérabilité. Reprises PG texte/page blanche exécutées par stockage et collecte normale. Nouvel artefact IA v4.6 autorisé localement : 77 tests ciblés, Ruff, diff et 201 versions uniques verts ; nouvelle CI/pgTAP exacte et migration requises. |
| Santé | À 21 h 05, quatre alertes : inbound absent, fraîcheur EImmo et Notaires, enrichissement stalled. Santé globale non qualifiée. |
| Worker automatique | Production sur le tag protégé `immojudis-workers-f695a739`. Warm ordinaire `e3deadf6` réussi, cache réellement absent ; nouveau cold en cours. Routage inchangé ; prochain canari de queue avec vérification indépendante de tous ses UUIDs requis. |
| Collecte Avoventes | Warm `e3deadf6` : 240 annonces et 241/241 requêtes réussies, zéro échec de transport ; collecte/publication complètes, enrichissement partiel. Les preuves manuelles ne remplacent pas les timestamps du dernier run automatique. |
| Autres sources | Six dernières collectes complètes sur neuf sources autorisées. AGRASC conserve 25 archives vendues sans identité ; EImmo timeout de transport, Notaires interrompu sur l’ancien worker. Nouvelle collecte Notaires qualifiée requise. |
| Documents | Warm `e3deadf6` : reprise SQL réellement passée de 75/95 à 95/95 pages, même SHA de fichier, texte enrichi, zéro page échouée et manifeste des quatre documents complet. Trois PDF entiers restent strictement réutilisables. Cold courant requis avant qualification finale. |
| Capacité | À 22 h 24 : 6 044 ouverts, 6 024 dus réessayables, 2 619 anciens sous plafond, 13 épuisés, zéro running/stale. Ouverts −193 depuis 21 h 05, sans preuve de résorption durable. À 22 h 28 : valorisation zéro ouvert ; 26 pending observés à 22 h 24 ont été traités. |
| Revue IA | v4.6 figée : deux passes aveugles sur 76 captures/912 champs, 152 hashes de prompt, 1 181/1 181 citations strictes. Troisième lecture des 76 désaccords : 29 documentés, 47 unresolved. Onze champs relus sur modèle AGRASC lié restent incertains. Dry-run : 346 admissibles/566 bloqués ; aucun import ni mesure d’exactitude réelle. |
| Resend/portail | Clé, domaines, webhook et canari fournisseur vérifiés. Ajout du secret portail à Vercel Production refusé par auto-review, accord précis en attente. Aucun interlocuteur réel sollicité. |
| Inbound | Route non publiée sur l’origine canonique, cron absent. Canari canonique authentifié puis activation et récupération automatique de santé requis après déploiement. |
| Enchères Publiques | Source désactivée, gardes qualifiées sur `3400eb58`. Accord écrit et flux promis non reçus. Aucune nouvelle collecte. |
| Publication finale | PR en brouillon. Preview `b95ea5a9` READY, canonique inbound 404. Aucun import IA, publication finale ou nettoyage. |

### Qualification des textes stockés — 30 septembre, 12 h 01 UTC

Le candidat Avoventes `85ee013a-ebd4-40fd-9f78-d1b073b1550b` possède bien
quatre PDF, sur une source active et disponible. Ses quatre lignes documentaires
sont `downloaded/extracted`, mais la dernière extraction `pdf_text` de
11 h 58 min 55 s ne comporte ni `complete`, ni `extraction_status`, ni clé
`failed_pages`, ni hash de texte, ni preuve de cache datée. Les longueurs des
profils et des textes de cette extraction ne concordent pas non plus. Il ne
qualifie donc pas une reprise à froid moderne. Le run Avoventes observé de
11 h 46 à 12 h 01 ne fournit pas de SHA du writer dans son résumé : la proximité
temporelle ne permet pas d'en attribuer un.

La même relecture distingue les échecs de faits anciens des échecs PDF : le job
`5810e89f-d8f4-4f96-aa74-f452cfb45409`, sans document, porte un rejet de qualité
du résumé daté du 23 septembre. Son état courant ne prouve pas un incident de
budget ou de cooldown. Aucun job n'a été réinitialisé ou clôturé pour cette
qualification.

Les sections suivantes conservent la chronologie. Leurs compteurs datés ne
doivent pas être utilisés comme l'état courant sans lire cette synthèse et
les derniers relevés en fin de document.

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
champs `unresolved` ou `unverified` de la revue IA ne peuvent pas
alimenter une valeur présentée comme confirmée. L'export v4 courant en compte
respectivement 128 et 23 ; les nombres antérieurs de 21 et 11 décrivent un
état provisoire de l'audit.

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

La migration `20260929091424_operational_health_manual_jobs.sql` retire du
contrôle `cron.stale` les jobs CNB et pré-calcul de valorisation,
volontairement manuels. Elle laisse le contrôle de l'inbound, de la file de
valorisation et de la file d'enrichissement en place. Son bloc SQL a été
exécuté sur une instance PostgreSQL jetable avec la définition production,
puis a passé le rejeu intégral et les tests pgTAP. Le
[workflow de maintenance](https://github.com/Aprivi-dev/immojudis/actions/runs/36553023142)
l'a appliquée en production sur le commit `310f8cbe` ; le contrôle de dérive
du schéma est vert. La base confirme la version et l'absence des deux entrées
manuelles, tout en conservant celle de l'inbound. L'évaluation programmée de
10 h 15 UTC a réussi en 3,7 secondes : `cron.stale` ne mentionne plus que
`information-agent-inbound`. L'alerte d'import est résolue ; restent ouvertes
les alertes de l'inbound, de la file de valorisation et de l'enrichissement.
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
doit confirmer les deux certificats. Le
[nouvel inventaire](https://github.com/Aprivi-dev/immojudis/actions/runs/36553221574)
confirme cette fois `unhandled_public_urls=[]` dans les deux certificats et
l'inventaire des annonces adressables. La découverte AGRASC reste partielle :
26 cartes anciennes déjà vendues n'exposent aucun identifiant de fiche, et
les deux certificats conservent donc `public_discovery_certified=false`. Le
même run certifie la découverte publique Notaires pour 817 URLs validées,
sans URL non traitée.

L'[inventaire complet des dix sources](https://github.com/Aprivi-dev/immojudis/actions/runs/36553732731)
certifie l'inventaire adressable de huit sources. Avoventes échoue avant la
preuve : sa page catalogue contient 5,67 millions de caractères pour un
plafond de parsing de 4 millions. Une inspection du DOM public montre que
deux sélecteurs de villes contiennent chacun environ 32 630 options et
représentent 4,9 millions de caractères ; le reste de la page fait environ
0,83 million de caractères. Le collecteur et l'audit retirent désormais
uniquement ces deux contrôles avant le parsing, sans retirer les cartes des
ventes. Ce correctif a passé 40 tests ciblés mais doit encore être éprouvé
par un nouvel inventaire réel. Enchères Publiques renvoie HTTP 403 à l'audit
direct ; le test navigateur en lecture seule a également rencontré un défi
Cloudflare, sans l'assimiler à un inventaire vide.

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
être réessayées à l'identique pendant leur fenêtre d'exclusion, puis doivent
être revérifiées : leur indisponibilité pourrait être transitoire. La page
vendeur AGRASC, dépourvue d'identité de bien, exige une exclusion durable.
La mise en production de cette garde reste soumise au critère de publication.

La revue IA seule des 73 captures a produit 21 champs indécidables et 11
citations de type de bien non vérifiées. Le manifeste de cette revue n'est
pas encore relié durablement aux identités canoniques des fiches ; une fiche
authentifiée peut donc afficher une valeur litigieuse comme une donnée
ordinaire. Ce lien et un affichage explicite des champs non résolus restent
un blocage de publication, même si aucune relecture humaine n'est demandée.

## Relevé complémentaire du 29 septembre, 10 h 25 UTC

La CI complète du commit `4fba0612` est verte : tests Python 3.11 et 3.12,
vérification web, Playwright, rejeu des migrations et pgTAP, CodeQL et
prévisualisation Vercel. Le
[nouvel inventaire en lecture seule](https://github.com/Aprivi-dev/immojudis/actions/runs/36555120215)
certifie Avoventes sur 233 URLs uniques et Vench sur 643 URLs, avec
`unhandled_public_urls=[]` et aucune erreur pour ces deux sources. Le passage
Enchères Immobilières de ce même run a expiré sur sa page catalogue avant
lecture ; sa certification obtenue lors du passage précédent ne remplace pas
un contrôle de stabilité. Un
[second passage immédiat](https://github.com/Aprivi-dev/immojudis/actions/runs/36556066931)
a certifié 204 annonces Enchères Immobilières, ainsi que 233 Avoventes et
643 Vench, sans erreur ni URL publique non traitée. Le premier délai reste
un incident intermittent à surveiller. Le
[test navigateur Enchères Publiques](https://github.com/Aprivi-dev/immojudis/actions/runs/36554613019)
a confirmé un défi Cloudflare HTTP 403. Aucune tentative de contournement
de ce défi ni conclusion d'inventaire vide n'en découle. Une ouverture
manuelle en lecture seule de l'hôte canonique sans `www` et du chemin
`/fr/ventes/immobilier` affiche la même vérification de sécurité ; le simple
changement d'hôte ne donne donc pas une source exploitable au collecteur.

Le rapprochement exact `(source_name, source_url)` de la revue IA avec les
ventes courantes donne 54 captures rattachées une seule fois, 19 non
rattachées et aucune ambiguïté parmi les 73 captures. Ce relevé est ponctuel
et doit être rejoué avant l'import des projections. Les cas non rattachés
restent privés ; aucune association par similarité d'URL ou contenu ne leur
sera attribuée. La migration et l'import de la projection sont en revue :
aucun statut IA n'a encore été appliqué aux ventes de production.
La comparaison exacte des 27 autres cas de l'échantillon, sans capture
exploitable, trouve 24 ventes courantes uniques et 3 URL absentes ; aucune
ambiguïté. Les 24 ventes devront porter un statut de cas privé qui les
quarantaine sans inventer de hash de capture ni de preuve.
Le rapprochement a été rejoué dans une seule lecture cohérente le 29
septembre à 11 h 06 min 51 s UTC. Son instantané privé hors dépôt est
`/private/tmp/immojudis-ai-review-sale-mapping-20260929.json`, SHA-256
`bf75ad7823ef55eb122a930025b9f2e7f2f6ae2af0bc29d18821be81cd552ebf`.
Il confirme 54 captures exactes, 19 absentes, 24 cas non capturés exacts,
3 absents et 0 ambigus. Cet instantané n'autorise pas une association si
l'identité change avant l'import : la base recalculera chaque correspondance.

Une ligne de production AGRASC provenait d'une page vendeur générique sans
identité de bien : `98e9df19-1075-4a98-ae17-f7106400cf54`. Une maintenance
ciblée lui a ajouté le marqueur `publication_quarantine` à 10 h 25 UTC. Les
vues fiche et découverte ne la retournent plus. La vue publique
`v_auction_sales_app_preview` et la fonction de recherche de secours v3
n'appliquent toutefois pas encore ce marqueur ; cette exposition résiduelle
bloque une publication tant que leurs contrats ne sont pas corrigés et
vérifiés. L'exclusion durable de la page vendeur et le traitement borné des
jobs épuisés sont également en revue.

À 10 h 40 UTC, cette vente AGRASC a en outre reçu le statut
`quarantined`, avec contrôle de son URL et de son identifiant exacts. La
recherche v3 ne la retourne désormais plus ; l'aperçu public reste à une
ligne. La correction générale des accès preview et des anciens RPC demeure
nécessaire, car un prochain cas quarantainé pourrait garder un statut
éligible à la recherche.

Le [second worker d'enrichissement de la branche](https://github.com/Aprivi-dev/immojudis/actions/runs/36553470288)
s'est terminé avec succès à 10 h 28 UTC après environ 21 minutes de traitement.
La lecture des lignes de file modifiées dans sa fenêtre montre 14 détails de
source, 9 PDF, 4 descriptions et 2 extractions de faits terminés. Huit lignes
ont fini en échec : quatre PDF (trois Vench, un Avoventes), deux détails
Enchères Immobilières expirés et deux détails Petites Affiches pour lesquels
le relais a refusé ou n'a pas répondu. Ce relevé est une corrélation temporelle
avec le run, pas une attribution parfaite de chaque ligne à son identifiant
GitHub ; les journaux détaillés doivent encore être conservés. À environ
10 h 34 UTC, la file non terminale compte 6 141 lignes, dont 6 131 dues et
3 106 âgées de plus de 48 heures. Le stock ne décroît donc pas durablement.

À 10 h 52 UTC, un premier appel borné au pré-calcul de valorisation a été
déclenché par `app_private.invoke_market_valuation_precompute_endpoint()`.
Cette fonction lit l'URL et le secret dans Supabase Vault puis appelle la
route de production ; aucun secret n'a été copié dans la branche ou dans un
workflow. La réponse réseau est HTTP 200. L'exécution
`793a2f83-86d2-44ec-8469-5a6bca03073b` s'est terminée en 27 secondes :
75 dossiers pris et examinés, 67 valorisations prêtes, 8 données
insuffisantes, 0 échec. Un deuxième appel strictement séquentiel, après
vérification qu'aucune exécution n'était active, a reçu l'identifiant réseau
`2643`. Il a lui aussi répondu HTTP 200 : l'exécution
`4722659c-382a-4a05-82ed-7e085586578b` a traité 75 dossiers en 25
secondes, dont 74 prêts, 1 à données insuffisantes et aucun échec. Ces deux
appels font 150 dossiers examinés, 141 prêts, 9 insuffisants et zéro échec.
Le cron
automatique demeure désactivé tant que la capacité et les alertes ne sont
pas stabilisées.

La migration `20260929143000_queue_scheduler_throughput_fairness.sql` prépare
un compteur de tours du planificateur : après trois collectes consécutives
déjà en retard, elle accorde un tour borné à la file d'enrichissement. Elle
attend encore le rejeu Supabase et les tests pgTAP sur son commit exact.

Deux revues indépendantes des correctifs IA ont relevé des chemins de
publication encore ouverts avant l'import : une projection partielle pouvait
laisser paraître la valeur canonique ; un badge « Vérifié » ne comparait pas
la valeur IA à la valeur effectivement affichée ; la carte Mapbox lisait
directement certains champs bruts. Une fiche pouvait aussi être lue par
un client connecté directement dans `auction_sales` malgré son marqueur de
quarantaine. La branche ajoute maintenant une restriction à la politique
`auction_sales_authenticated_read` pour les clients non administrateurs.
Les autres chemins restent en correction et doivent être vérifiés en CI et
sur le commit exact avant tout import ou publication.

Parmi les 54 captures IA rattachées exactement, cinq ventes n'ont pas de
`content_hash` canonique au relevé de production. Leur revue peut être
conservée comme preuve privée, mais la fiche doit rester en quarantaine tant
que cette empreinte est absente : un changement de contenu à URL stable ne
serait autrement pas détectable. La migration introduit un hash canonique
figé à l'import et un blocage si le hash courant change ; le test du cas
sans hash est en cours.
Un second instantané privé des dix champs canoniques directement stockés,
pris à 11 h 30 min 03 s UTC pour les 54 captures rattachées, est conservé
hors dépôt sous `/private/tmp/immojudis-ai-review-canonical-values-20260929.json`
(SHA-256 `f1075d2d47d5f92f2b69fa95d7e626f5ce19c9a9309bf6d1097ee12b72151c85`).
Une comparaison des 320 valeurs IA « resolved » correspondantes,
avec normalisation des types, dates et espaces, relève 84 désaccords sur
dix champs. Un seul relève de l'accentuation ; les autres incluent des
écarts de ville, de surface et de prix. La comparaison métier et la
réconciliation des valeurs doivent donc
être vérifiées avant d'étiqueter une fiche comme confirmée ou de publier
les projections. Le garde de l'API masque désormais toute divergence qu'il
détecte, sans modifier automatiquement la valeur canonique.

La seconde analyse en lecture seule reprend les 54 captures rattachées et
320 projections « resolved » sur les dix champs directement comparables.
Elle confirme les 84 écarts initiaux ; après normalisation des accents,
83 restent substantiels. Cinquante-et-un contredisent une valeur déjà
présente en base et 32 proposent un renseignement pour un champ vide.
Les cinq écarts de mise à prix dépassent chacun 10 %, et cinq dates de vente
diffèrent réellement. Un accord des deux lectures IA indépendantes, puis
une comparaison explicite à la valeur canonique, sont nécessaires avant
toute promotion ; une valeur trouvée pour un champ vide reste une candidate
privée avec sa provenance. Les désaccords restent en quarantaine.

Le projecteur privé exige maintenant l'accord des deux passes IA
indépendantes avant de retenir un champ `present`. L'adjudicateur IA ne peut
plus départager seul une divergence. Le recalcul du manifeste figé conserve
876 lignes de champs, dont 433 satisfont les seuls critères de consensus,
de citation et de mapping du projecteur ; 129 sont bloquées pour désaccord
entre passes et 11 pour citation non vérifiée. L'ancien export qui indiquait
462 lignes publiables est périmé et ne doit pas être importé. Ces 433 lignes
ne sont pas encore autorisées à paraître : la comparaison au canonique et
les gardes de publication SQL restent à valider.

La file d'enrichissement compte 6 238 lignes non terminales à 11 h 02 UTC,
dont 6 232 dues et 3 084 dues depuis plus de 48 heures. La règle de trois
tours de collecte pour un tour de file limite sa famine, mais le writer
GitHub unique, le plafond de 90 jobs ou 1 200 secondes par worker et le
limiteur Replicate de 60 appels par heure plafonnent toujours le débit.
Le stock reste donc un blocage de capacité mesurée ; aucune concurrence
supplémentaire n'est activée sans limiteur partagé.

La reprise séquentielle de valorisation a ensuite traité 33 lots de 75
dossiers, chacun avec HTTP 200 et zéro échec. La file `pending` de
`auction_sale_market_estimates` est passée de 2 814 avant l'opération à 339
à 11 h 27 UTC ; 2 218 lignes sont `ready`, 335 sont classées
`insufficient_data`, et aucune ligne `processing` n'a dépassé son lease de
300 secondes. Le dernier lot a duré 65,9 secondes : le garde opérationnel
fixé à 60 secondes a donc arrêté les relances suivantes. Le cron demeure
désactivé ; ce ralentissement doit être compris avant un nouveau lot.

Après exclusion d'une exécution concurrente et contrôle de l'absence de
claims expirés, trois nouveaux lots canaris strictement séquentiels de 75
dossiers ont répondu HTTP 200, sans échec. Leurs durées sont 43,6 s, 22,0 s
et 18,7 s ; la reprise demeure sous surveillance et le cron automatique
restait désactivé à ce stade.

Un quatrième lot canari de 75 dossiers a ensuite réussi en 16,4 s, toujours
sans échec. À 11 h 46 UTC, la file de valorisation est vide : 0 `pending`,
0 `processing`, 0 `failed`, 2 544 `ready` et 355 `insufficient_data`.
Le job `immojudis-market-valuations` a été réactivé à `*/10 * * * *`
au lieu de son ancien intervalle de cinq minutes. Son premier passage
automatique et l'évolution de la file restent à contrôler avant publication.

Le premier passage automatique, à 11 h 50 UTC, a réussi : 44 dossiers
apparus depuis la vidange ont été pris et 44 estimations sont prêtes, sans
échec. La fonction de santé actuelle conserve néanmoins l'alerte
`valuation.queue.degraded` dès que moins de 95 % des dossiers ont une
estimation chiffrée. Les 355 dossiers correctement classés
`insufficient_data` abaissent artificiellement cette couverture à 87,8 %.
La migration `20260929150000_valuation_health_terminal_coverage.sql`
sépare la couverture des estimations et le taux de dossiers traités ; elle
doit passer pgTAP et être appliquée avant d'interpréter cette alerte.

Le second passage automatique, à 12 h 00 UTC, a traité 37 nouveaux dossiers
avec 37 estimations prêtes et aucun échec en 17,2 s. Ce cron est désormais
actif toutes les dix minutes. La mesure de santé reste faussée jusqu'à
l'application de la migration ci-dessus.

Le correctif de visibilité publique `20260929133000_public_quarantine_visibility.sql`
a passé la CI complète et CodeQL au commit `6755b12bdd6b079c8eed2e26f64b2cd0f5f9edda`.
Il a été appliqué en production par le
[workflow de migration](https://github.com/Aprivi-dev/immojudis/actions/runs/36566606793),
dont le contrôle de dérive a réussi. Une requête de lecture après application
confirme que la ligne AGRASC `98e9df19-1075-4a98-ae17-f7106400cf54`
reste en base avec le marqueur de quarantaine, tandis que les vues d'aperçu,
de fiche et de découverte en renvoient chacune zéro. La migration ultérieure
`20260929170000_status_quarantine_visibility.sql` doit encore faire appliquer
le même blocage aux lignes dont seul le statut vaut `quarantined`.

La purge de rétention a échoué par dépassement du délai SQL à 11 h 55,
12 h 00, 12 h 05 et 12 h 10 UTC. À 12 h 15, elle a répondu rapidement
`busy=true` tandis que la tâche de santé réussissait en 6 s. Deux ventes
étaient éligibles à la purge au relevé en lecture seule. À 12 h 20, une
exécution a supprimé ces deux lignes en 8,0 s, juste à la limite du délai
SQL. L'attente d'un verrou et le coût de traitement par ligne peuvent donc
tous deux contribuer aux quatre échecs précédents. La migration
`20260929160000_nonblocking_sale_retention.sql` prépare un `LOCK NOWAIT`,
un retour `busy` pour éviter d'attendre un writer et une seule suppression
par appel RPC ; la boucle du cron pourra poursuivre lors de la même
exécution ou à son prochain passage. Les règles de conservation restent
inchangées. La migration attend ses tests pgTAP et une mesure en production
après application ; des réponses `busy` répétées devront être surveillées
explicitement.

La migration `20260929153000_enrichment_drain_mode.sql` prépare une fenêtre
de drainage d'au plus six heures, désactivée par défaut. Elle permet à la
file due d'utiliser chaque tick du planificateur tout en gardant le writer
unique et les tours équitables des sources. Les tests ciblés sur PostgreSQL
isolé ont réussi ; le passage CI et une mesure réelle de débit restent
nécessaires avant toute activation. Le stock de 6 428 tâches en attente,
dont 3 489 de plus de 24 heures au relevé de 11 h 45, interdit encore la
publication.

Le relevé ultérieur à 12 h 18 UTC compte 7 147 tâches non terminales,
dont 7 144 immédiatement dues, 3 487 âgées de plus de 24 heures et 25
épuisées. Les 24 dernières heures n'ont terminé que 744 tâches. Le dernier
worker `enrichment-queue` a commencé à 06 h 46 UTC et s'est terminé en
échec à 07 h 06 ; toutes les exécutions automatiques ultérieures examinées
jusqu'à 12 h 19 ont été des collectes de sources. Le mode de drainage et la
fairness sont donc des mesures de capacité à vérifier rapidement après la
CI, mais aucune résorption n'est encore démontrée.

L'audit Resend en lecture seule a confirmé à 12 h 24 UTC que la clé de
production répond à l'API du fournisseur (HTTP 200), que le domaine
`immojudis.com` et le sous-domaine de réponse sont vérifiés et qu'un
déploiement Vercel protégé contient la route webhook, qui rejette une
signature absente (HTTP 400). Aucun nouveau message n'a été envoyé. Le
canari historique de livraison reste la seule preuve d'envoi ;
`INFORMATION_AGENT_OUTBOUND_ENABLED` demeure absent et les contacts réels ne
reçoivent rien. `ALERT_EMAIL_FROM` a ensuite été configuré en Production avec
l'adresse existante `ImmoJudis <assistant@immojudis.com>` ; cette modification
n'a pas déclenché de déploiement. Un contrôle séparé de l'origine canonique
enregistrée dans Supabase Vault, `https://immojudis-dezt.vercel.app`, renvoie
encore HTTP 404 sur `/api/cron/information-agent-inbound`. Le worker entrant
reste donc non planifié jusqu'à ce que cette route soit déployée sur l'origine
utilisée par le scheduler et vérifiée avec son authentification.

Le commit opérationnel `aa032b004227020cf0d70ab0c12a7699486dfb41`
a passé la CI complète, CodeQL et les 1 155 assertions pgTAP. Les six
migrations `20260929124000`, `143000`, `150000`, `153000`, `160000` et
`170000` ont été appliquées à 12 h 54 UTC par le
[workflow de maintenance](https://github.com/Aprivi-dev/immojudis/actions/runs/36571174745) ;
le contrôle de dérive distant a réussi. Le mode de drainage est toujours
désactivé. Le précontrôle de 12 h 54 comptait 7 320 tâches dues et une
collecte `encheres_immobilieres` active depuis 12 h 46. Cette collecte doit
terminer avant l'activation d'une fenêtre de drainage bornée et surveillée.

Le rapprochement des 19 captures sans vente courante a été affiné avec le
journal `auction_collection_items`. Cinq des six cas initialement considérés
sans trace avaient bien été découverts et publiés, puis purgés après leur
audience ; le sixième est une ancienne page Petites Affiches datant de 2012.
Le constat ne démontre donc aucun nouveau défaut de découverte pour ces six
cas. L'instantané privé de mapping ne consultait pas ce journal et ne doit
plus qualifier leur absence courante de `never_discovered`. Les 19 restent
sans rattachement à une vente actuelle : aucune projection ne peut leur être
attribuée par similarité ou par historique seul.

L'importeur de la revue IA exige deux passes distinctes avec métadonnées
d'exécution et citations vérifiées dans la capture. Pour les pages Notaires
dont le contenu provient de l'API officielle, il vérifie l'identifiant
numérique identique dans l'URL publique, l'URL d'API et le JSON capturé.
L'export privé recalculé le 29 septembre est
`/private/tmp/immojudis-ai-review-export-20260929-consensus-v4.json`, SHA-256
`624a3d0cf6df621dad154de351659b95522634683f604ed5d535b041040f2d60`.
Il contient les 100 statuts de cas et 876 lignes de projection en dix lots.
Parmi les 100 cas, 73 ont une capture et deux passes IA ; les 27 autres sont
7 échecs de capture, 2 sources inaccessibles et 18 cas non tentés. Les 876
champs v4 se répartissent en 424 `resolved`, 219 `absent`, 82 `unknown`,
128 `unresolved` et 23 `unverified`. Seuls les 73 cas capturés peuvent être
qualifiés de relus par deux IA.
Une capture étiquetée AGRASC mais servie par l'API Notaires n'a pas de preuve
d'identité de source suffisante ; ses douze champs sont conservés en
`unverified`, sans valeur publiable. Les 32 tests locaux de l'importeur et de
la projection, Ruff et la compilation Python ont réussi. L'ancien export v3
ne doit pas être importé. La migration SQL et ses tests pgTAP sont en CI ;
aucun import de cet export v4 n'a encore eu lieu.

Après application de la garde `source_detail`, la maintenance transactionnelle
bornée `supabase/maintenance/20260929124000_quarantine_agrasc_seller_and_close_excluded_jobs.sql`
a vérifié les six identités exactes et les a passées de `failed` à
`cancelled`. Elle a confirmé le statut `quarantined` et le marqueur de la
page vendeur AGRASC. Une lecture indépendante trouve zéro ligne pour cette
identité dans les vues d'aperçu, de fiche et de découverte. Les cinq
exclusions temporaires doivent être recontrôlées après leur fenêtre de sept
jours ; elles ne constituent pas une disparition définitive de ces biens.

La migration de projection IA a ensuite passé le rejeu complet et pgTAP sur le
commit `d2dbf0a4` ; CodeQL, les tests Python et Playwright sont aussi verts.
La CI globale de ce commit reste rouge uniquement sur le build Next : le
résolveur `next/font/google` a signalé `next/font/google queries have exactly
one entry` pour IBM Plex Sans, sans changement du module de police dans ce
commit. Le build du commit précédent avait réussi. Un nouveau build sur le
commit final doit confirmer si cet échec est transitoire ; la migration IA ne
sera pas appliquée avant une CI intégralement verte.

La collecte Vench du 29 septembre, lancée à 13 h 00 UTC, s'est terminée
correctement à 13 h 18. Le contrôle de 13 h 21 constate cependant 7 521
tâches d'enrichissement immédiatement éligibles, dont 3 085 âgées de plus de
48 heures. Le drainage temporaire reste actif jusqu'à 14 h 59 UTC, mais
aucune baisse durable n'est encore démontrée. L'alerte
`pipeline.source.encheres_publiques.missed` reste ouverte : le site répond
HTTP 403, son dernier inventaire complet a échoué le 22 septembre et le
collecteur est suspendu jusqu'au 30 septembre à 01 h 01 UTC. Les 26 annonces
encore actives pour cette source ne sont pas fraîches. Le confinement du
connecteur évite de transformer ce refus d'accès en fausse absence ; il ne
rétablit pas l'accès. Le domaine canonique et un éventuel flux autorisé sont
en cours de vérification. Le précontrôle HTTP de 13 h 30 a ensuite trouvé le
même défi Cloudflare (`403`, `cf-mitigated: challenge`) sur le domaine canonique
et sur `www` après redirection ; changer l'hôte du collecteur ne résoudrait
donc pas le refus. Les [conditions d'utilisation de la source](https://encheres-publiques.com/cgu)
interdisent la rediffusion, même partielle, sans accord. Le
[jeu historique publié sur data.gouv.fr](https://www.data.gouv.fr/datasets/distribution-des-prix-de-vente-des-biens-immobiliers-des-tribunaux-judiciaires-francais)
s'arrête à 2024 et ne peut pas
remplacer un inventaire courant. La décision de conserver la source en pause
ou de fournir un accord/flux partenaire est demandée au propriétaire produit ;
aucun contournement d'accès n'est engagé.

La relecture des chemins serveur utilisant le service role a ajouté la garde
de publication aux exports, aux comparaisons, aux rapports sauvegardés et aux
agrégats. Les lectures de visibilité en lots utilisent désormais le seul
marqueur `publication_quarantine` au lieu du JSON complet, et les listes
judiciaires continuent leur pagination après une page pleine même si certaines
ventes de cette page sont quarantainées. Les tests locaux de ces chemins,
TypeScript et les invariants de sécurité passent ; la CI du commit final reste
à obtenir.

Le commit `7457deb07174bbc8fc61dbc7873de263d8325e66` a passé le build
Next, le rejeu des migrations et pgTAP, les tests Python, Playwright et
CodeQL. La seule vérification rouge est le budget global de JavaScript client :
4 389 571 octets pour une limite de 4 370 000, soit 19 571 octets de trop.
La limite reste en place ; une réduction du bundle et une nouvelle CI sur le
commit corrigé sont nécessaires avant la migration IA. Le run de drainage
démarré à 13 h 30 UTC était encore actif à 13 h 41, avec 6 113 tâches dues,
dont 3 066 depuis plus de 48 heures. Cette mesure ne prouve pas encore une
résorption des tâches âgées.

Le propriétaire produit indique disposer d'une autorisation écrite de
réutilisation pour Enchères Publiques et d'un accès au flux partenaire. Le
document, l'URL, le contrat de réponse et les modalités d'authentification
ne sont pas encore fournis ni vérifiés. Le collecteur HTML demeure suspendu ;
aucun contournement du défi Cloudflare n'est engagé. L'adaptateur sous licence
devra conserver l'URL publique canonique comme identité de chaque bien,
refuser les instantanés incomplets et éviter toute nouvelle requête HTML de
détail lorsque le flux porte déjà les faits complets.

Le commit `0058f765` a ensuite obtenu une CI et CodeQL intégralement verts.
Après vérification qu'aucun run automatique n'était actif, la migration IA
`20260929103000` a été appliquée en production par le
[workflow de maintenance](https://github.com/Aprivi-dev/immojudis/actions/runs/36584497748)
à 14 h 41 UTC ; les étapes de migration, de configuration du contrôle de santé
et de dérive distante ont toutes réussi. Les deux tables IA sont encore vides,
la lecture anonyme et authentifiée y est interdite, et le contrôle de sécurité
Supabase n'a ajouté que deux avis informatifs attendus sur leurs politiques RLS
fermées. Aucun lot de revue IA n'a été importé. L'import v4 attend toujours le
déploiement des gardes applicatives publiques du même changement.

Le code de chargement différé des filtres et statistiques de la recherche est
sur `b993dd10`, puis le dialogue temporaire accessible sur `8a90c5dc`. Les
deux commits ont obtenu une CI complète et CodeQL verts ; le dernier inclut
également le parcours Playwright. La taille initiale de la route des ventes
respecte le budget contrôlé par la CI. Le run de drainage du 29 septembre à
14 h 16 UTC a traité 48 jobs mais a été déclaré en échec parce qu'un PDF Vench
a épuisé sa quatrième tentative. Les 40 jobs terminés restent acquis, six jobs
ont échoué et les documents incomplets restent traçables dans la file. Le stock
à 14 h 49 était encore de 6 110 jobs dus, dont 3 032 âgés de plus de 48 h.
La fenêtre de drainage a expiré à 14 h 59 UTC sans prolongation. Le correctif
de statut du runner et une optimisation du claim SQL sont en préparation ;
leurs nouveaux commits et contrôles devront être consignés ici avant release.

Le correctif du runner `42e2a9b5` conserve un job épuisé en échec terminal,
mais classe le run `partial_success` si le processus s'est terminé normalement
et a réellement achevé au moins un autre job. Les codes non nuls et les
timeouts du processus restent des échecs. Les compteurs et identifiants
protégés des jobs épuisés sont conservés sans erreur brute ni URL de document.
La migration `79519cb0` calcule une fois par vente la date de conservation lors
du nettoyage préalable au claim, sans changer l'éligibilité ni les tentatives.
Une mesure de plan en lecture seule sur la production passe de 7,78 à 1,12 s
au premier passage et de 1,90 à 1,03 s à chaud. Les tests locaux ciblés Python
et le contrôle des versions de migration sont verts ; le rejeu complet et
pgTAP restent à confirmer par la CI du commit final avant toute application de
la migration SQL en production.

Une nouvelle inspection des 27 cas sans capture a confirmé qu'aucun ne dispose
d'un fichier source ni de deux relectures IA. L'export v4 reste inchangé ;
zéro champ a été inféré pour ces cas. L'évaluation privée est conservée dans
`/private/tmp/immojudis-ai-review-noncaptured-assessment-20260929.json`,
SHA-256 `dab79f2362b18b644e379caf087963dae969ef6bd10bd7d418c10a17c4ee8020`.

Le commit `ca3f251a` a passé la CI complète
([run 36590361088](https://github.com/Aprivi-dev/immojudis/actions/runs/36590361088))
et CodeQL
([run 36590361049](https://github.com/Aprivi-dev/immojudis/actions/runs/36590361049)).
Le rejeu de toutes les migrations et les 1 232 assertions pgTAP sur 64 fichiers
sont verts. Il groupe les écritures d'observations canoniques par lots de 25,
dans des transactions indépendantes et rejouables. La migration
`20260929180000` a ensuite été appliquée à la production avec contrôle de
dérive réussi par le
[workflow 36591139260](https://github.com/Aprivi-dev/immojudis/actions/runs/36591139260).
La migration `20260929160000` de rétention non bloquante est également bien
présente en production ; les réponses HTTP 500 ponctuelles observées sur
`sale-retention` et `operational-health` nécessitent encore une mesure des
prochains passages du planificateur. `pg_stat_statements` rapporte 569 appels
au claim du planificateur, avec une moyenne de 5,9 s et un maximum de 7,98 s :
la marge avant timeout reste faible.

L'importeur IA a été exécuté en mode lecture seule sur un instantané des
identités de ventes de production, sans écrire dans les deux tables IA : 100
cas examinés, dont 73 avec deux lectures IA, 27 sans capture, 54 identités
exactes, 19 sans vente correspondante et aucune ambiguïté. Sur 876 champs
projetés, 319 passent la règle locale de publication et 557 restent bloqués.
L'instantané privé est conservé dans
`/private/tmp/immojudis-ai-review-sales-snapshot-20260929.json` (SHA-256
`888e574f8f9a5b8392b1dbc154adf896fd896df44ee3f7a558b44dfd8fc43140`).
L'import réel reste suspendu jusqu'au déploiement de la garde applicative et
à une nouvelle vérification des identités. Sur la prévisualisation Vercel du
commit `ca3f251a`, la route
`/api/cron/information-agent-inbound` existe et renvoie `401 AUTH_REQUIRED`
sans secret ; elle répond encore `404` sur le domaine canonique, ce qui est
attendu avant publication. Aucun message n'a été envoyé à un interlocuteur
réel et le cron entrant n'a pas été activé.

Le [run Vench 36591912352](https://github.com/Aprivi-dev/immojudis/actions/runs/36591912352)
a confirmé 648 URL publiques sur 648 et 89 requêtes sur 89 sans erreur de
collecte. Il a publié 150 éléments de contrôle, mais le processus a terminé
avec un `SIGSEGV` pendant la préparation de l'upsert `auction_sales` du lot
151–175. La finalisation a marqué le run `failed/interrupted` ; la source n'a
pas été déclarée complète et les points de reprise publiés sont conservés.
Les 25 charges déjà persistées de ce lot mesurent 20–27 Ko et ne révèlent
pas d'anomalie de taille. Le parcours récursif de préparation JSON doit être
sécurisé et vérifié avant toute relance Vench. Une fenêtre interne de drainage
de deux heures a été activée jusqu'au 29 septembre à 17 h 51 UTC ; le
planificateur garde la priorité aux sources échues au plus trois passages
consécutifs. Le stock dû était encore de 6 218 jobs à 16 h 03 UTC, dont 39
en échec ; cette fenêtre ne démontre pas encore une résorption durable.

Le correctif `0c6e4262` sépare par copie profonde la preuve brute d'une
observation avant une fusion et refuse les graphes JSON circulaires ou plus
profonds que 64 niveaux avec un chemin d'erreur. Il traite une cause plausible
du `SIGSEGV` Vench, qui n'a pas pu être démontrée à partir des seules charges
déjà persistées. Les 64 tests ciblés et Ruff passent localement ; la
[CI 36596335136](https://github.com/Aprivi-dev/immojudis/actions/runs/36596335136)
et [CodeQL 36596335152](https://github.com/Aprivi-dev/immojudis/actions/runs/36596335152)
sont lancés sur ce commit exact. Aucune nouvelle exécution Vench n'est lancée
pendant leur contrôle ni pendant un run automatique concurrent.

La collecte Avoventes démarrée à 16 h 01 UTC s'est achevée à 16 h 14 avec un
inventaire certifié de 235 annonces, sans erreur de requête : 197 publiées,
25 expirées selon la date de conservation et 13 mises en quarantaine pour
identité conflictuelle ou ambiguë. Le planificateur a réservé ensuite un run
`enrichment-queue` à 16 h 15 UTC, conformément à la règle de priorité de la
file après trois passages de sources.

La [CI 36596335136](https://github.com/Aprivi-dev/immojudis/actions/runs/36596335136)
et [CodeQL 36596335152](https://github.com/Aprivi-dev/immojudis/actions/runs/36596335152)
ont terminé avec succès sur `0c6e4262`, y compris le rejeu des migrations,
pgTAP, les deux versions Python, le typage, le lint et Playwright. L'essai
réel Vench après ce correctif reste à faire, sans chevauchement avec le worker
réservé à 16 h 15. À 16 h 20, celui-ci avait achevé huit jobs ; 6 158 jobs
restaient dus, dont 3 053 âgés de plus de 48 heures. Il est trop tôt pour
qualifier ce débit de résorption durable.

L'analyse du plan de `claim_autonomous_pipeline_run` a isolé la recherche
des tâches `source_detail` ouvertes : elle parcourt l'historique d'environ
76 000 jobs alors que 3 041 ventes éligibles produisent environ 9 308 alias.
Le rôle HTTP a une limite SQL de 8 s, proche du maximum observé de 7,98 s.
Le commit `5b84f6fb` ajoute un index partiel sur l'identité des jobs ouverts et
sépare la vérification de signature de celle des jobs en cours, avec des tests
pgTAP pour les signatures terminées, les jobs ouverts et les échecs épuisés.
Il reste à obtenir la CI exacte, appliquer la migration par maintenance puis
mesurer le plan et les prochains ticks en production. Aucun élargissement de
la concurrence des workers n'est activé à ce stade.

Le test pgTAP de cette migration a d'abord échoué parce qu'il cherchait deux
occurrences littérales de `where not exists`, alors que la seconde
anti-jointure commence par `and not exists`. Le commit `3edf61a3` corrige
uniquement cette assertion. La
[CI 36598880613](https://github.com/Aprivi-dev/immojudis/actions/runs/36598880613)
et [CodeQL 36598880341](https://github.com/Aprivi-dev/immojudis/actions/runs/36598880341)
sont verts sur ce commit. Le
[workflow 36599631747](https://github.com/Aprivi-dev/immojudis/actions/runs/36599631747)
a ensuite appliqué `20260929183000` en production et confirmé l'absence de
dérive de schéma. L'index partiel existe et a déjà été utilisé au moins une
fois par le planificateur. Le cumul des appels SQL englobe encore les passages
antérieurs à l'index : trois cycles comparables restent nécessaires avant de
conclure à une amélioration durable du débit et de la fraîcheur.

Les commits `625c2049` et `04fb6b89` durcissent respectivement les sorties IA
face aux instructions contenues dans une source et le portail de contribution :
un lien est désormais lié à la mission, à son destinataire et à une version
monotone qui change si le dossier ou le destinataire change ; les pièces et
faits reçus par mail exigent une authentification d'expéditeur vérifiée ; les
écritures du worker entrant respectent son bail. La migration
`20260929190000` porte cette version de jeton. La
[CI 36600333770](https://github.com/Aprivi-dev/immojudis/actions/runs/36600333770)
et [CodeQL 36600334083](https://github.com/Aprivi-dev/immojudis/actions/runs/36600334083)
doivent encore confirmer le commit `04fb6b89` avant l'application de cette
migration. Aucune mission n'existe en production ; ces liens anciens ne sont
donc pas en circulation. L'envoi réel et l'import IA restent désactivés.

Un parcours Vench complet a été relancé sur `3edf61a3` dans le
[run 36600177762](https://github.com/Aprivi-dev/immojudis/actions/runs/36600177762).
Il est encore en cours : son résultat et son état final en base déterminent si
le correctif de préparation JSON permet de terminer la collecte.

La [CI 36600333770](https://github.com/Aprivi-dev/immojudis/actions/runs/36600333770)
a passé Web, Playwright, Python et CodeQL, puis a échoué dans le nouveau pgTAP
`393` : sa première assertion comparait le domaine SQL `character_data` à
`text`. Le commit `dd05cab2` ajoute le cast requis. La
[CI 36601037387](https://github.com/Aprivi-dev/immojudis/actions/runs/36601037387)
a passé les 14 premières assertions de ce test, puis a révélé une seconde
erreur de forme : un `UPDATE` imbriqué dans un `SELECT`. Le test est corrigé
localement en deux instructions ; aucun de ces deux échecs ne provient du
rejeu des migrations. Une nouvelle CI complète reste nécessaire.

L'audit de sécurité du nouveau flux a trouvé un chemin public où le champ
`summary` de l'extraction IA remplaçait `auction_sales.description` sans
contrôle de preuve. Ce résumé de secours passe désormais par
`verify_display_claims` avant écriture ; 22 tests ciblés et Ruff sont verts.
Une requête en lecture seule sur la production ne trouve aucune fiche dont la
description actuelle est égale au `summary` stocké dans `llm_extraction`, ni
aucun texte suspect dans ce sous-ensemble. Le même audit a relevé une fenêtre
de course entre bail entrant et écritures métier ; un correctif de clôture
atomique est en cours, avec migration et tests, avant publication.

Le run AGRASC de 16 h 46 UTC a terminé partiellement : six cartes collectées,
cinq persistées et trois URL d'opérateurs rejetées. Il utilisait encore
l'ancien code pour Trocadéro et Agorastore ; la troisième URL appartient à
une agence notariale précise associée à une carte AGRASC. La branche accepte
désormais uniquement cet hôte et la forme exacte de sa page de bien, conserve
les faits de la carte et classe le détail externe `unsupported` tant qu'aucun
adaptateur sûr n'existe. Aucun joker sur `*.notaires.fr` ni récupération
générique n'a été introduit. Les 33 tests ciblés et Ruff sont verts.

Le triage des documents a identifié sept profils PDF encore incomplets, dont
Villeparisis avec un job épuisé. Le code local distingue maintenant un texte
partiel d'une extraction complète dans `auction_documents` et versionne
l'identité de reprise PDF avec la version de l'extracteur, sans effacer le job
précédent. Les 52 tests Python groupés et Ruff sont verts. Un passage réel des six
jobs en attente et de la nouvelle génération Villeparisis reste à mesurer.

Le portail de contribution reçoit un plafond SQL sérialisé de 12 URL signées
et 480 Mio par dossier. Chaque URL réserve les 40 Mio que le bucket Storage
peut accepter, même pour un fichier déclaré plus petit. Une réservation
expirée reste comptée tant que le nettoyage administratif n'a pas prouvé
l'absence d'objet privé. Le jeton Storage est créé côté serveur, puis le quota
est réservé ; le jeton n'est transmis au navigateur que si la réservation
réussit. Un incident Storage ne consomme donc pas de capacité. L'API et le
formulaire montrent la capacité restante. La migration, pgTAP et les tests
d'intégration doivent passer sur le commit final.

Le [run Vench 36600177762](https://github.com/Aprivi-dev/immojudis/actions/runs/36600177762)
s'est achevé à 17 h 17 UTC avec un job GitHub vert et un état SQL `succeeded`.
Les 648 annonces ont été collectées, normalisées et dédupliquées, 642 ventes
admissibles publiées, 655 observations écrites et aucune erreur de source
Vench. Le verdict applicatif reste `partial_success` à cause de deux erreurs
documentaires sur deux ventes ; le correctif de reprise PDF et leur résultat
réel doivent encore être vérifiés. Le crash `SIGSEGV` du premier essai ne
s'est pas reproduit sur ce parcours complet.

Le triage des deux échecs documentaires Vench identifie Noisy-le-Grand
(`73982.pdf`, téléchargement inconnu, job de reprise en attente) et
Ris-Orangis (`73502.pdf`, pages 19 et 20 en échec OCR, job de reprise en
attente). Le second document de Ris-Orangis (`73503.pdf`) est maintenant
entièrement extrait et ne demande pas de reprise spécifique. Les deux ventes
restent publiées avec une couverture documentaire incomplète ; ce run ne
certifie donc pas encore la qualité documentaire de Vench. Les jobs doivent
terminer et les statuts de couverture doivent être revérifiés.

La clôture atomique des baux entrants est maintenant implémentée localement
dans `20260929201000` et le worker : la prise d'un job inscrit le même bail
sur son message dans la transaction SQL, puis les écritures de pièces, faits,
dossiers et missions vérifient le bail et l'identité du dossier au moment de
l'écriture. Les clés transitoires sont retirées des métadonnées persistées.
La même série inclut `20260929200000` pour le quota du portail et la
correction du pgTAP `393`. Les contrôles locaux passent : 27 tests Web ciblés,
52 tests Python groupés, TypeScript, ESLint, Prettier, Ruff et unicité des
190 migrations. pgTAP et la CI distante restent requis avant application
de ces migrations en production.

Une vérification directe de `supabase_migrations.schema_migrations` à 17 h 40
UTC confirme que les versions de garde IA `20260929103000`, de visibilité
publique `20260929133000` et de statut quarantainé `20260929170000` sont
appliquées, ainsi que l'index `20260929183000`. Les versions `1900`, `2000`
et `2010` attendent encore le résultat de la CI du commit `2fe7f01a`.
Le run automatique
[36605383311](https://github.com/Aprivi-dev/immojudis/actions/runs/36605383311)
s'est achevé avec un état GitHub `success` à 17 h 38 UTC ; les journaux de
source détaillés n'étaient pas disponibles au dernier relevé. Le rapport de
file à 17 h 17 compte 6 119 jobs à traiter, soit 24 de plus qu'à 16 h 38.
La seule réussite du workflow ne valide donc pas encore le débit ni la
fraîcheur de chaque source.

À 18 h 13 UTC, la
[CI 36609950281](https://github.com/Aprivi-dev/immojudis/actions/runs/36609950281)
et [CodeQL 36609950343](https://github.com/Aprivi-dev/immojudis/actions/runs/36609950343)
ont validé le commit `268616f1`, notamment le rejeu des 190 migrations,
pgTAP `396`, les tests Web et Python et le parcours Playwright. Le
[workflow de maintenance 36608080831](https://github.com/Aprivi-dev/immojudis/actions/runs/36608080831)
a appliqué en production les migrations `20260929190000`, `20260929200000`
et `20260929201000` et confirmé l'absence de dérive de schéma. Une requête
directe sur `supabase_migrations.schema_migrations` confirme ces trois
versions. Aucune mission ni aucun message entrant n'existe encore en
production ; l'envoi réel demeure désactivé.

La relecture du planificateur confirme que la migration `20260929143000`
borne déjà à trois claims de collecte la priorité des sources en retard de
plus d'une heure. Cette borne laisse encore trop peu de créneaux à la file
quand chaque collecte dure plusieurs dizaines de minutes. Toutes les tâches
partagent le même groupe GitHub à un seul écrivain. Entre 07 h 06 et
16 h 38 UTC, les quatre familles observées ont augmenté malgré quatre
workers de 48 à 66 jobs chacun. À 17 h 17, 704 jobs avaient été créés sur
24 heures et 539 terminés ; 2 155 attendaient depuis plus de 48 heures. Un
arbitrage borné de la file dans le planificateur est en préparation. Aucun
accroissement de parallélisme n'est décidé sans preuve sur les baux et la
capacité des fournisseurs.

Le [run automatique Notaires 36607163795](https://github.com/Aprivi-dev/immojudis/actions/runs/36607163795)
s'est ensuite terminé avec un état SQL `succeeded` et une couverture
`complete` : 832 cartes collectées et dédupliquées, 204 ventes écrites et
206 observations, sans erreur de source. Il a occupé le créneau d'écriture
pendant environ 33 minutes. Le
[canari AGRASC 36609055353](https://github.com/Aprivi-dev/immojudis/actions/runs/36609055353)
a terminé avec une couverture `partial_success` : huit annonces collectées,
sept ventes écrites, six détails d'opérateur complets et deux non pris en
charge, sans erreur de récupération source. Les 25 cartes d'archives sans
URL ni identité ne permettent pas de certifier l'inventaire public ; le
nettoyage de catalogue reste désactivé. L'unique erreur documentaire concerne
la page 96 des diagnostics d'Uckange. Le code local limite aussi désormais
la pagination à la vue immobilière, afin d'ignorer les paginations voisines.

## Derniers correctifs et contrôles de reprise

La migration locale `20260929203000` donne à une file due un créneau après
un seul claim de source en retard. Elle conserve le writer unique, les baux,
la cadence de 30 minutes et la protection des sources récentes. Les tests
pgTAP antérieurs `386` et `388` sont adaptés au schéma final ; le nouveau
test `397` vérifie aussi le véritable RPC de claim. Le rejeu CI reste requis.

Le [canari d'enrichissement 36612419562](https://github.com/Aprivi-dev/immojudis/actions/runs/36612419562)
s'est achevé avec un statut GitHub vert à 18 h 50 UTC : 64 tâches traitées,
32 de détail et 32 d'enrichissement, en 1 206 secondes. « Traitées » ne
signifie pas 64 extractions réussies : les deux PDF Vench ont encore échoué
avec l'ancien plafond de 300 pages et l'OCR des cartes de Ris-Orangis. Un
claim SQL a rencontré un timeout, puis a réussi au retry. Ces résultats ne
valident pas encore une résorption durable de la file.

Le rapport Noisy-le-Grand contient 416 pages pour environ 9,6 Mo. Le workflow
local porte son plafond à 500 pages, avec le budget OCR par passe et la limite
de téléchargement de 50 Mo inchangés. Pour Uckange, le correctif ne classe
comme décorative qu'une page sans texte, annotation ni image, contenant un
unique tracé rempli et simple sur un bord. Les cartes des pages 19 et 20 de
Ris-Orangis restent exclues de cette règle et signalées en échec OCR. Le PDF
original, le numéro de page et le motif OCR restent conservés. Une nouvelle
génération de job permet la reprise après cette correction sans invalider
les caches complets. Les 130 tests Python ciblés et Ruff passent ; un run
réel sur le nouveau code reste requis.

Le cron des estimations avait une cadence réelle de dix minutes, alors que
la migration prévoit cinq minutes. Son retour autorisé à cinq minutes a
traité des lots de 75, 52 puis trois éléments sans échec. Les lectures à
18 h 41 et 18 h 50 UTC trouvent zéro estimation due, aucun retard et aucune
ligne `pending`. Les réponses 500 observées dans les crons concernent le
nettoyage des ventes ; son scan JSON et son comptage restent à corriger puis
mesurer. Le timeout distinct du claim d'enrichissement est mentionné ci-dessus.

La migration locale `20260929210000` calcule désormais le délai de rétention
à l'écriture, avec un remplissage initial borné et un index partiel. Le purgeur
lit cette valeur au lieu de reparcourir les gros JSON de toutes les ventes,
et conserve le comptage exact du restant. Le trigger passe après les gardes
existantes et détecte aussi leurs changements de statut ou de données source.
Les verrous non bloquants, l'archivage statistique et la limite d'une vente par
transaction sont conservés. pgTAP, application et mesure du temps réel restent
requis avant de conclure que les timeouts de ce cron sont corrigés.

## Vérifications complémentaires, 19 h 20 UTC

La [CI 36616380084](https://github.com/Aprivi-dev/immojudis/actions/runs/36616380084)
du commit `d56f5157` a validé les deux suites Python, Playwright, les invariants
de sécurité, le build Web et le rejeu des 192 migrations sans dérive.
[CodeQL 36616380098](https://github.com/Aprivi-dev/immojudis/actions/runs/36616380098)
est vert. La CI globale est toutefois rouge : le module PDF dépasse de six
lignes le plafond de 1 500, une assertion SQL dépend des espaces, et le
scénario de file vide de `397` conserve les jobs de référence. Le helper de
page décorative est extrait dans un module dédié sans relever le plafond ;
les deux scénarios SQL sont corrigés. Les 24 assertions de `398`, y compris
le changement de statut par un trigger précédent, avaient déjà réussi.
Une nouvelle CI complète sur le prochain commit demeure nécessaire.

Une extraction réelle du PDF de Noisy-le-Grand avec le plafond de 500 pages
a parcouru les 416 pages en deux passes bornées : 412 pages produisent du
texte, dont 136 par OCR, et quatre cartes ou plans (285, 328, 372, 412)
restent en échec OCR. Cette preuve privée ne constitue pas encore un run
cloud ni une couverture documentaire complète. La nouvelle règle de page
décorative ne s'applique à aucune de ces quatre pages.

La migration locale `20260929220000` réutilise le délai de rétention
matérialisé dans les claims et ajoute un index pour la recherche des baux
actifs par URL source. Elle conserve les verrous, les baux, l'ordre des
familles et l'annulation des révisions. Le coût du tri global des révisions
subsiste ; la réduction réelle des durées SQL doit être mesurée après
application. Les métriques Python distinguent désormais les tâches traitées
(`handled`) de leur statut final observé. Une lecture facultative, bornée et
indexable, compte les statuts des seuls identifiants réellement claimés et
conserve l'identifiant GitHub du run ; son échec n'affecte pas le worker.

Le [run automatique 36612495549](https://github.com/Aprivi-dev/immojudis/actions/runs/36612495549)
s'est terminé à 19 h 08 UTC sur l'ancien code de `main`. Son message
« completed 90 jobs » compte des tâches traitées et ne certifie pas 90
réussites. Noisy-le-Grand a encore rencontré le plafond de 300 pages. Une
lecture à 19 h 16 UTC compte 5 979 tâches éligibles non terminales, dont
5 945 dues et 2 985 dues depuis plus de 48 heures ; 14 ont épuisé leur budget
de tentatives. Ces critères sont identiques à ceux du relevé de 18 h 57
(6 103 éligibles, 6 092 dues, 2 999 anciennes). La baisse ponctuelle n'établit
pas encore la capacité durable ni la résorption des tâches anciennes.

L'extension privée de la revue IA `v4.1` est rejetée : les deux passes des
trois nouveaux cas avaient été construites par copie des mêmes labels, sans
deux exécutions indépendantes. Aucun import de données n'a eu lieu. Les
captures source vérifiées sont conservées et deux agents
distincts ont exécuté de nouvelles passes aveugles le 29 septembre, avec
instructions, résultats bruts et heures réelles conservés. Leur assemblage
`v4.2` est vérifié : 35 accords sur 36 champs, avec un désaccord sur le nombre
de pièces d'AGRASC 362606 conservé sans adjudication. Le manifeste privé a
pour SHA-256 `1fc0cab8cb191476d073f384ce52e14a05a1ce953bed4f75521d0eecc12e95ae`.
Il compte 76 captures sur 100 cas, 57 identités exactes, 19 sans vente
correspondante et aucune ambiguïté dans l'instantané. Sur 912 projections,
347 passent la garde locale de provenance et 565 restent bloquées. Ces
chiffres ne décrivent pas une exactitude statistique ni des valeurs déjà
publiées. Le cas AGRASC dont l'endpoint ne correspond pas à l'URL source reste
entièrement non vérifié.

Les 73 anciens cas sont conservés sans changement : leurs sorties et labels
diffèrent entre les deux passes, sans preuve concrète de duplication, mais
leurs 146 passes ne conservent ni identifiant d'exécution ni hash de prompt.
Cette limite de traçabilité historique est explicite ; ces cas ne sont pas
présentés comme de nouvelles exécutions. L'ajout de l'artefact `v4.2` exact
aux gardes d'import Python et SQL est préparé dans la migration locale
`20260929230000`, et `v4.1` reste refusé. Cette migration refuse aussi
explicitement les métadonnées obligatoires absentes ou `NULL`, au lieu de
laisser le comportement SQL de `NULL` échapper à un `IF`. Les 125 tests Python
PDF et worker, les 22 tests d'import IA, Ruff, Prettier et le contrôle des
194 versions de migrations passent localement ; les nouveaux tests SQL
nécessitent encore le rejeu CI.

Le dry-run du script d'import, sur l'instantané privé, a relu le manifeste v4.2
avec la nouvelle autorisation : 912 lignes, 57 correspondances exactes,
19 sans correspondance, 347 lignes passant la garde locale après la garde de
provenance, et 565 bloquées. Aucun `--apply` n'a été exécuté. L'export privé
sanitisé [v4.2](/private/tmp/immojudis-ai-review-export-20260929-v4.2.json)
contient 11 lots et 912 lignes, sans chemin de capture ni extrait privé ; son
SHA-256 est
`66097999f18459d672f815a0708bb7bdbdb67387445818f949a02f1f773abd28`.

La relecture SQL indépendante ne trouve pas de régression de rétention ni de
bail dans `2100` et `2200`. Le remplissage initial ne nomme ni `content_hash`
ni les colonnes des triggers d'enqueue ; les triggers génériques d'audit et
de quarantaine peuvent toutefois s'exécuter. Les deux nouvelles colonnes de
calcul sont lisibles par les utilisateurs authentifiés au même titre que les
autres colonnes autorisées d'`auction_sales` ; elles ne contiennent aucun
secret. Une future modification de la politique `sale_retention_deadline()`
devra inclure un nouveau remplissage des valeurs matérialisées.

## CI et maintenance confirmées, puis réduction des relectures inutiles

La [CI 36619711898](https://github.com/Aprivi-dev/immojudis/actions/runs/36619711898)
et [CodeQL 36619712038](https://github.com/Aprivi-dev/immojudis/actions/runs/36619712038)
sont verts sur `dbf84f20`. Le rejeu vérifie 194 migrations, 1 382 assertions
pgTAP dans 73 fichiers, la concurrence des quotas et les deux scénarios
d'intégration du circuit de contribution sur un véritable Supabase local.
Les suites Python, le Web, ses budgets et Playwright sont également verts.

Le [workflow de maintenance 36620546689](https://github.com/Aprivi-dev/immojudis/actions/runs/36620546689)
a appliqué `20260929203000`, `20260929210000`, `20260929220000` et
`20260929230000`, puis validé l'absence de dérive. La lecture de production
à 19 h 39 UTC confirme ces quatre versions, les deux nouveaux index et zéro
vente sans délai matérialisé. Les tables de statuts et projections IA sont
toujours vides : aucun import ni changement de visibilité lié à cet artefact
n'a été effectué. L'export privé approuvé `v4.2` compte 11 lots pour 912
projections ; son SHA-256 est
`66097999f18459d672f815a0708bb7bdbdb67387445818f949a02f1f773abd28`.

Les passages du purgeur à 19 h 40 et 19 h 50 UTC effectuent réellement le
scan : 6,06 ms puis 10,07 ms, contre une moyenne historique de 2 370,80 ms.
Ils répondent HTTP 200, sans ligne à supprimer. À 19 h 45, le passage de
5,10 ms signale `busy=true` : le verrou occupé lui fait sauter le scan.
Ces observations concernent le purgeur. À 20 h 05, le compteur des claims
ajoute 23 appels pour 4 208,37 ms, soit 183 ms de moyenne sur cet intervalle.
Une fenêtre complète et les statuts réellement terminés restent à mesurer.
Le contrôle de santé échoue encore à 19 h 45 après 10,3 s avec un timeout
SQL ; celui de 20 h 00 réussit en 7,4 s. La fonction d'observation répétant
les mêmes agrégations de source est en cours d'optimisation. Le timeout
revient à 20 h 15 après 9,9 s ; la santé n'est donc pas déclarée restaurée.

Un diagnostic de code montre qu'une variation structurée de prix/date/statut,
sans changement des preuves documentaires, peut activer simultanément
`source_operational_changed` et `source_content_changed`. Le chemin d'enqueue
crée alors une nouvelle révision de résumé IA. Une reproduction locale de
changement de prix seul confirme ce cas. Le relevé du worker de 18 h 50
compte 4 063 créations display sur 24 heures et 3 921 annulations récentes,
mais ne permet pas d'attribuer rétrospectivement chacune à cette cause : les
hashes sont opaques et la base ne conserve pas les transitions antérieures.
Le correctif en cours utilise la reconstruction déterministe existante avant
l'enqueue quand elle est suffisante, conserve la relecture en cas de preuve
modifiée ou de qualifications documentaires, et protège les invalidations
antérieures encore non réconciliées.

La cadence récurrente des détails se fonde déjà sur les captures source.
À 19 h 58, 9 246 références brutes représentent 3 133 couples distincts
(vente canonique, source, alias), et 3 131 URLs distinctes pour 3 043 ventes
admissibles. Les 2 661 tâches ouvertes bloquent la création de nouvelles
révisions dues. Parmi elles, 1 364 ont une vérification du bon alias et de
la bonne version postérieure à leur création et encore fraîche, mais seules
224 observations portent explicitement un marqueur de lecture détail.
La fraîcheur seule ne permet donc pas de conclure ces tâches. Le correctif
en cours exige une preuve détail durable, puis revalide la vente et le bail
dans la transaction de clôture, en conservant les cadences exactes 5 h / 23 h.
La migration `20260929233000` réutilise le délai de rétention matérialisé
dans l'enqueue des détails, en conservant les alias et les règles de reprise.
Les tests SQL vérifient ventes futures, reportées, sans date et expirées.

Le cycle Vench `36619679198` terminé à 19 h 48 parcourt 54 pages, émet
648 lignes et déclare une couverture de catalogue complète, sans erreur
source. Il conserve 648 observations et écrit 642 ventes finales ; 504
lectures détail sont évitées par le cache existant. Ces compteurs de collecte
ne prouvent pas une validation documentaire de chaque fiche. Ce cycle tourne
encore sur `main`, avant les nouvelles protections de cache et de résumé.

## Correctifs de cohérence et contrôle de santé préparés

La relecture indépendante a reproduit une date opérationnelle conservée dans
une citation légale, une réserve PDF perdue par le fallback et un cache
ancien réestampillé sous un nouveau prompt. Les trois parcours sont corrigés :
les citations contenant prix/date/visite/report nécessitent la relecture,
les biens documentés exigent un manifeste factuel actuel, et le cache doit
déjà correspondre aux versions de prompt et d'affichage avant toute mutation.
Le modèle réel du provider est conservé. Une invalidation documentaire
antérieure, y compris sans motif connu, demeure bloquante après fusion avec
un second collecteur ou changement de prix/date.

Le worker peut clore sans HTTP un ancien contrôle satisfait par une capture
de détail plus récente, avec preuve explicite dans `source_checks`. Il exige
le même alias, source et version, une date postérieure à la création de la
tâche et une fraîcheur strictement inférieure à 5 h / 23 h. La transaction
revérifie la preuve et le bail exact sous verrou, puis restitue l'essai qui
n'a consommé aucune requête. Une simple capture de listing ou une ancienne
observation sans preuve liée au contrôle courant ne suffit pas.

La migration `20260929234000` préagrège les métriques des runs courants et la
baseline historique du contrôle de santé. Elle conserve les 28 runs distincts,
le dernier snapshot de chaque run, le JSON et les seuils d'alerte existants.
Les deux nouvelles migrations ont reçu une relecture IA indépendante ;
leurs tests pgTAP restent à exécuter dans la CI avant maintenance.

La suite locale consolidée vérifie 287 tests et saute 16 scénarios nécessitant
PostgreSQL jetable. Ruff, Prettier, `git diff --check` et les 196 versions
uniques de migrations passent. Les scénarios PostgreSQL de preuve/bail,
les nouvelles assertions pgTAP et la suite complète sont requis dans la CI.

## CI et maintenance validées, diagnostic du coût à froid

La [CI 36627249061](https://github.com/Aprivi-dev/immojudis/actions/runs/36627249061)
et [CodeQL 36627249055](https://github.com/Aprivi-dev/immojudis/actions/runs/36627249055)
sont verts sur `5a5a5552`. Le rejeu compte 196 migrations et 1 404 assertions
pgTAP dans 75 fichiers. Les tests de concurrence, les deux intégrations
Supabase local, les suites Python 3.11/3.12 (1 896 tests), Web et Playwright
passent. La prévisualisation Vercel est également verte sur ce commit.

La [maintenance 36627934832](https://github.com/Aprivi-dev/immojudis/actions/runs/36627934832)
a appliqué `2330` et `2340` sur ce même commit puis validé l'absence de
dérive. Le contrôle de santé de 20 h 45 UTC dépasse pourtant encore son délai
après 9,68 secondes ; celui de 21 h réussit en 6,89 secondes. Ces passages
alternés ne démontrent pas une restauration durable.

Le diagnostic en lecture seule isole `auction_all_source_freshness()` : son
plan à froid prend 12 650 ms avec 9 760 blocs lus et 40 543 blocs déjà en
cache, contre 821 ms à chaud. Il parcourt 3 043 ventes actives et détache
`source_checks` des gros `raw_payload` ; la relation TOAST correspondante
occupe environ 311 Mo. Le plan des agrégations introduites dans `2340`
prend environ 1 128 ms, et les autres évaluateurs restent sous 1,7 seconde.
Aucun verrou pertinent n'a été constaté lors de ce diagnostic ; cela
n'exclut pas une attente de verrou à un autre instant.

La correction en préparation conserve les contrôles dans une table privée
compacte, remplie directement sans `UPDATE auction_sales`, et maintenue par
trigger dans la transaction de chaque révision. Fraîcheur et admission des
détails doivent conserver leurs alias, dates, exclusions et cadences. Le
dispatcher doit aussi résoudre le bail du writer actif avant l'admission
facultative de nouveaux détails. Ces nouveaux correctifs nécessitent leur
rejeu SQL, la relecture et une mesure réelle avant déclaration de succès.

La relecture indépendante de `2350` et `2355` est terminée. Un garde étroit
refuse fraîcheur et admission si une vente active manque dans la projection,
plutôt que réduire silencieusement le dénominateur. Le worker n'a que le droit
de lecture sur la table privée ; le trigger assure les écritures. Les fichiers
`403` et `404` ajoutent respectivement 25 et 20 assertions, notamment les
timestamps futurs, le cache incomplet et les branches de bail/retry. Les 198
versions de migration et les vérifications statiques passent ; ces 45 assertions
restent à exécuter dans la CI.

Le [canari 36628465977](https://github.com/Aprivi-dev/immojudis/actions/runs/36628465977)
sur `5a5a5552` démarre à 21 h 07 UTC après le writer Petites Affiches
`36626783222`, terminé avec succès après 632 éléments de collecte. Les jobs PDF
Uckange et Ris-Orangis ont reçu une priorité de 1 000 sans remise à zéro des
essais ; Noisy-le-Grand était déjà à cette priorité et prend son quatrième
essai à 21 h 08. Le résultat documentaire du canari reste à mesurer,
y compris les pages image qui demeurent illisibles.

L'instantané privé de 20 h 52 UTC conserve 78 ventes correspondantes : les
76 captures de la revue `v4.2` donnent 57 identités exactes, 19 non rattachées
et zéro ambiguïté. Le dry-run conserve 100 cas, 912 projections, 347 champs
passant la garde locale et 565 bloqués. La comparaison actuelle de dix champs
stockés, avec les règles de type/date/espaces/casse de la route applicative,
compte 313 valeurs : 244 concordantes, 35 contradictoires et 34 proposées pour
un champ canonique vide. Les 34 champs d'énergie nécessitent une comparaison
séparée. Ce périmètre diffère du relevé ancien de 320 valeurs : le nombre
d'écarts ne constitue donc pas une mesure d'amélioration de l'exactitude.

Huit des 54 anciennes fiches ont changé depuis le relevé de 11 h 30,
dont six empreintes de contenu ; huit de ces 54 fiches n'ont pas d'empreinte
actuelle. Les candidates, contradictions et preuves sans hash restent
bloquées. Les instantanés et le rapport de comparaison restent privés sous
`/private/tmp/immojudis-ai-review-*-20260929-resume.json` et
`/private/tmp/immojudis-ai-canonical-comparison-20260929-resume.json`.
Aucun import de revue IA, déploiement applicatif ni nettoyage de branche
n'a eu lieu à cette étape.

Le premier rejeu du commit `615a1f92`,
[CI 36632419666](https://github.com/Aprivi-dev/immojudis/actions/runs/36632419666),
applique les 198 migrations et valide la dérive et les quotas concurrents,
mais s'arrête dans pgTAP. Le nettoyage des fixtures concurrentes contourne les
triggers/FK et laisse des contrôles privés orphelins : l'assertion de parité les
détecte. Le test `403` doit aussi archiver ses ventes dans Outcome Graph avant
leur suppression normale ; `404` doit cibler le hash de son job explicite pour
ne pas compter celui créé par le trigger automatique. Les corrections portent
sur les fixtures et leur nettoyage, sans changer les deux migrations. Un
nouveau rejeu complet est requis avant maintenance. Le canari d'enrichissement
`36628465977` est terminé avec succès ; son bilan des statuts et documents
reste à examiner.

## Reprise validée, 21 h 45 UTC

La [CI 36634428200](https://github.com/Aprivi-dev/immojudis/actions/runs/36634428200)
et [CodeQL 36634428352](https://github.com/Aprivi-dev/immojudis/actions/runs/36634428352)
sont verts sur `f695a739`. Les 198 migrations, 1 449 assertions pgTAP dans
77 fichiers, quotas concurrents, catalogue HTTP et deux intégrations Supabase
local passent, ainsi que les suites Python, Web et Playwright.
La [maintenance 36635178998](https://github.com/Aprivi-dev/immojudis/actions/runs/36635178998)
a appliqué `2350` et `2355`, puis validé l'absence de dérive. La lecture de
production compte 3 372 ventes et autant de projections, zéro ligne absente,
zéro incohérence scalaire et zéro orpheline. RLS est actif ; seul le service
peut lire la table, sans INSERT/UPDATE/DELETE, et les rôles publics ne la lisent pas.

Le contrôle de santé planifié à 21 h 45 réussit en 1 593 ms. Le premier plan
borné de fraîcheur après maintenance prend 141,539 ms, avec 3 483 blocs en
cache et huit lus, sans écriture temporaire. La projection occupe 3,31 Mo,
contre 310,98 Mo de TOAST dans la table canonique. La projection vient d'être
remplie : cette mesure n'est pas présentée comme une preuve à froid et des
ticks ultérieurs restent requis pour conclure à la stabilité.

Le canari `36628465977` termine 41 traitements sur 40 identifiants distincts :
26 terminés, six échoués, six annulés et deux remis en file. Il consomme
1 200,1 secondes, dont 568,2 pour les détails et 630,3 pour l'enrichissement ;
le plus long batch détail dure 161,6 secondes. Son estimation initiale de
3 869 enrichissements et 2 597 détails choisit l'alternance 1/1. Aucun
Retry-After ou bail expiré n'est observé. Ces traitements ne constituent pas
un débit de réussites. Le checkpoint cloud de Noisy contient 332/416 pages ;
le résultat local antérieur 412/416 ne lui est pas attribué. Ris-Orangis reste
incomplet ; Uckange n'a pas été réclamé dans ce run.

Le [second canari 36634662182](https://github.com/Aprivi-dev/immojudis/actions/runs/36634662182)
attend le worker automatique sur l'ancien `main`. Pour éviter que ce worker
au plafond de 300 pages épuise la dernière tentative de Noisy, une maintenance
CAS reporte ce seul job `queued`, sans bail et avec trois essais, de
21 h 40 min 54,17234 s à 22 h 30 UTC. Le nouveau worker démarre à
21 h 50 min 59 s ; le CAS suivant restaure l'échéance originale, avec les
trois essais conservés. Noisy prend ensuite son quatrième essai sous le
nouveau plafond. Uckange est admissible, sans bail ni ancienne révision, mais
le tri donne d'abord la priorité aux ventes dans les sept prochains jours :
son échéance du 29 octobre le place derrière 442 candidats.

La comparaison diagnostique de 34 valeurs énergie par la fonction SQL exacte
retourne 52 lignes : 18 valeurs canoniques manquantes produisent aussi une
seconde ligne de conflit, car deux branches `RETURN NEXT` omettent `RETURN`.
Ces 18 lignes supplémentaires ne sont pas des contradictions de données.
La migration `20260929235900` ajoute les deux sorties manquantes strictement
à l'intérieur des branches, sans changer l'identité ni les droits de la
fonction. Le test `405` ajoute 20 assertions : cardinalité des champs absents,
occupation inconnue et contrôles positifs match/conflit/valeur invalide.
La relecture indépendante est validée ; le rejeu CI et l'application restent
requis avant tout import IA. Les clés, domaines et webhook Resend sont présents et vérifiés ;
la route cron inbound n'est pas encore disponible dans l'app publique.
Le secret de signature du portail est absent et n'a aucun fallback ; sa
configuration reste nécessaire avant publication de ce parcours. Le ref du
worker automatique est encore `main` par défaut. Un routage vers un tag du
worker validé exige le redéploiement du code applicatif actuellement en ligne ;
la nouvelle application conserve ses gates de publication.
Aucun import IA, déploiement applicatif final ou envoi à un interlocuteur
n'a eu lieu.

## Reprise et routage du worker, 22 h 35 UTC

La [CI 36636802663](https://github.com/Aprivi-dev/immojudis/actions/runs/36636802663)
et [CodeQL 36636802906](https://github.com/Aprivi-dev/immojudis/actions/runs/36636802906)
sont verts sur `c19125ae` : 199 migrations, 1 469 assertions pgTAP dans
78 fichiers, quotas concurrents, catalogue HTTP, deux intégrations Supabase
local, Python 3.11/3.12, Web et Playwright. La
[maintenance 36637603863](https://github.com/Aprivi-dev/immojudis/actions/runs/36637603863)
a appliqué `2359` sur ce commit et validé l'absence de dérive. La comparaison
énergie exacte donne désormais 34 lignes pour 34 clés : 16 concordances,
18 champs canoniques absents et zéro conflit. Cette lecture de 22 h 10 UTC
ne remplace pas le snapshot des autres champs de 20 h 52 UTC et ne mesure
pas une amélioration de l'exactitude.

Le second canari d'enrichissement `36634662182`, sur `f695a739`, réussit :
58 traitements sur 55 jobs distincts, dont 36 terminés, un échoué, huit
annulés et dix remis en file. Le cycle 1/1 consomme 1 201,5 secondes, dont
194,8 pour 29 détails et 1 005,5 pour 29 enrichissements. Le batch détail
maximal dure 8,7 secondes ; aucun bail expiré, HTTP 429 ou Retry-After
n'est observé. Sept reports dus au budget LLM restaurent la tentative ;
cinq checkpoints de faits et deux prérequis PDF expliquent les reprises.
Ces compteurs ne sont pas un débit de réussites et ne justifient pas une
augmentation de la concurrence ou des budgets.

Le quatrième essai de Noisy termine réellement dans ce canari cloud : le
document canonique conserve le même hash et ses 416 pages, toutes extraites,
dont 276 par PyMuPDF et 140 par OCR. Il ne reste aucun statut failed,
retryable ou fallback. Les quatre pages précédemment échouées sont des
cartes strictement identiques : leurs OCR identiques de 84 caractères,
confiance 0,56, demeurent pauvres. L'achèvement textuel ne certifie pas
l'interprétation des cartes ou du zonage. Ris-Orangis reste incomplet sur
deux documents ; aucune remise à zéro des essais ni complétude fictive.
Le report temporaire de Noisy est entièrement levé.

Le tag `immojudis-workers-f695a739` pointe exactement sur le worker validé
`f695a739ab6e60079cf5c95fb432cb7ef6900ba1`. Le ruleset `24214045` interdit
sa modification et sa suppression, sans bypass. Vercel Production utilise
ce tag pour `GITHUB_SCROLL_REF` et conserve `main` pour
`OPERATIONS_ALERT_GITHUB_REF`. Le redéploiement interne
`dpl_DzzDsTAXi97DoEMCeBSrXfR6fem8` est READY sur le **même code public main**
`05cff558ada55ef4e0e99ab2e733f3a12adda49e` ; l'origine canonique répond 200.
Les nouvelles fonctionnalités applicatives de cette PR ne sont pas publiées.

Le run automatique Avoventes accepté à 22 h, encore pending et sans job
GitHub commencé, a été annulé puis redispatché sur le tag protégé avec le
même identifiant SQL. Le CAS du nouveau worker est intervenu avant
l'expiration du bail accepté ; aucun writer actif n'a été interrompu.
Le [cycle 36637742101](https://github.com/Aprivi-dev/immojudis/actions/runs/36637742101)
est terminé avec succès : 235 annonces, couverture complète et 136/136
requêtes réussies, sans PDF ou LLM ciblé. Le
[canari AGRASC 36638340560](https://github.com/Aprivi-dev/immojudis/actions/runs/36638340560)
sur ce même tag termine en `partial_success`, donc avec un code retour 1.
Il émet huit annonces avec 7/7 requêtes réussies, zéro erreur ou refus,
six opérateurs complets et deux unsupported. L'arrêt
`published_links_exhausted` ne dispose pas d'une preuve indépendante de
total d'inventaire ou de page terminale ; la collecte et la publication
restent partielles et le nettoyage catalogue est désactivé. Une annonce
est volontairement rejetée pour absence de prix et de surface. Les huit
PDF sont téléchargés et traités sans erreur ; le document de 96 pages
d'Uckange est extrait avec hash et 98 453 caractères. La seule cible LLM
est analysée en 3,94 secondes, JSON valide, sans erreur ou report de budget.
L'échec ne démontre donc aucune panne PDF/LLM. La recherche d'une preuve
terminale propre à cette source se poursuit sans assouplir les contrôles.

Les quatre contrôles de santé après `2350` réussissent à 21 h 45, 22 h,
22 h 15 et 22 h 30, respectivement en 1 594, 2 797, 6 432 et 2 893 ms.
La variation demeure réelle. Une comparaison SQL dans un même snapshot
prouve l'équivalence de la baseline historique étroite : 5 115 candidats,
390 runs et huit agrégats, sans différence intermédiaire ou finale.
Le plan chaud passe de 45,1 à 32,4 ms et de 938 blocs temporaires écrits
à zéro ; la largeur passe de 598 à 104 octets. Ce gain ponctuel supprime
le transport du JSON dans les deux tris, sans prouver le coût à froid.
La migration `20260930002000` conserve les 28 runs distincts, le dernier
snapshot, l'exclusion du run courant et le cast numérique après filtrage.
Le test `406` prépare 12 assertions. La relecture indépendante a reconstruit
le patch et confirme les mêmes invariants, seuils, alertes, queue et ACL ;
le rejeu CI reste requis avant application. La preuve de comparaison reste
privée dans `/private/tmp/immojudis-baseline-2340-narrow-proof.json`.

Le contrôle automatique d'autorisation a refusé l'ajout de
`INFORMATION_AGENT_PORTAL_SECRET` à Vercel Production, en demandant une
autorisation explicite pour ce secret et cette destination. La question
précise est posée à l'utilisateur ; aucune autre méthode de transfert n'est
tentée. Le secret reste uniquement dans un fichier privé local et sa valeur
n'est pas affichée. Le flux autorisé Enchères Publiques et son accord écrit
restent à recevoir. Aucun import IA, publication applicative finale,
envoi à un interlocuteur ou nettoyage de branche n'a eu lieu.

## Maintenance de la baseline et diagnostic de capacité, 22 h 50 UTC

La [CI 36640799126](https://github.com/Aprivi-dev/immojudis/actions/runs/36640799126)
et [CodeQL 36640798983](https://github.com/Aprivi-dev/immojudis/actions/runs/36640798983)
sont verts sur `520abb05` : 200 migrations, 1 481 assertions pgTAP dans
79 fichiers, quotas concurrents, catalogue HTTP, deux intégrations Supabase
local, Python 3.11/3.12, Web et parcours navigateur. La
[maintenance 36641397586](https://github.com/Aprivi-dev/immojudis/actions/runs/36641397586)
applique `20260930002000` et valide la dérive. Les lectures avant et après
confirment l'OID `322363`, SECURITY DEFINER, le `search_path` vide et l'ACL
exacte `{postgres=X/postgres,service_role=X/postgres}` ; les rôles publics
n'exécutent toujours pas la fonction. La projection étroite est présente.
Le tick de santé de 22 h 45 réussit en 3 599 ms ; les trois prochains ticks
permettront de suivre le comportement après cette dernière maintenance.

L'audit de backlog de 22 h 45 min 48 s compte 2 795 jobs ouverts créés
depuis plus de 48 heures : 2 764 sont effectivement claimables. Les 31
autres comprennent neuf essais épuisés, 21 prérequis de source bloqués
(Enchères Publiques) et un retry différé. Aucun n'est une ancienne révision,
une vente hors rétention, un bail actif, un scheduler désactivé ou une vente
absente. Il y a 101 candidats claimables dont la vente est dans les sept
jours, 2 431 hors de cette fenêtre et 232 sans date. Une quarantaine massive
masquerait donc du travail réel ; elle n'est pas proposée. Le rapport agrégé
reste privé dans `/private/tmp/immojudis-backlog-over48h-audit-20260930.json`.

Un relevé voisin compte 5 896 jobs non terminaux au total. Les historiques
de `display_description` comprennent 56 816 empreintes pour 3 206 ventes,
avec 3 991 annulations superseded sur 24 heures contre 133 complétions.
Ces annulations ne sont pas du débit. Le diagnostic examine maintenant les
entrées volatiles éventuelles des fingerprints et la répartition du temps
entre familles, sans relâcher les règles de provenance ou augmenter les
budgets et la concurrence. Le cycle automatique `36639927563` démarre
à 22 h 30 min 54 s sur le tag qualifié ; son bilan fournira une troisième
observation, à comparer seulement après vérification de ses paramètres.

La vérification officielle AGRASC expose une vue Drupal immobilière isolée,
avec un lien explicite de dernière page. Les marqueurs du canari passent de
5 à 6 : un parcours dont le terminal change n'est pas une preuve stable.
Un snapshot ultérieur des pages 0 à 6 conserve un terminal stable, mais des
cartes vendues sans lien ; l'inventaire adressable peut être certifié alors
que la découverte publique complète reste partielle. La raison explicite
`advertised_terminal_page_changed_or_ambiguous` est ajoutée à la certification.
Elle ne transforme pas un verdict partiel en succès et n'autorise aucun
nettoyage de catalogue.

La relecture AGRASC corrige un faux positif du statut d'archive : la classe
`sold` doit être accompagnée du badge structuré
`.fr-card__start .fr-badge--error`, avec un libellé complet vendu/archivé.
Une occurrence de ces mots dans le titre ou la description ne suffit pas.
Les 25 cartes du snapshot réel ont toutes cette preuve et des empreintes
distinctes. Chaque occurrence, page et multiplicité est conservée dans le
certificat ; aucune identité de vente canonique n'est créée. Les 26 tests
ciblés et Ruff passent. Le test du terminal instable conserve toutes les
pages et un compteur cohérent, afin de démontrer que ce seul changement
refuse la certification.

Le troisième cycle `36639927563` réussit : 36 détails et 35 traitements
généraux en 1 205,2 secondes, dont 200,2 pour les détails et 1 003,5 pour
le général. Il conserve le ratio 1/1. Ses 71 traitements ne sont pas 71
réussites : des claims répétés et un identifiant absent du snapshot final
nécessitent les statuts par transition. Après l'épuisement du budget LLM à
22 h 49 min 29 s, sept autres jobs généraux sont réclamés puis différés,
consommant environ 80 secondes. Le correctif en préparation arrête les
nouveaux claims généraux pour ce worker et poursuit les détails dans les
mêmes limites ; il ne relève pas les budgets, ne remet pas les essais à zéro
et ne modifie pas encore le ratio de familles. Cette suspension générale
temporaire doit aussi tenir compte des jobs PDF sans LLM. La preuve agrégée
reste privée dans `/private/tmp/immojudis-capacity-cycles-20260930.json`.

Les neuf jobs de plus de 48 heures aux essais épuisés concernent huit
prérequis PDF sans texte exploitable et un rejet de qualité sans document
associé. Les huit premiers ont 37 lignes documentaires uniques, encore
pending/unknown dans ce relevé. La récupération doit extraire leurs PDF
avant toute nouvelle révision fact/display ; elle ne consiste pas à
relancer le même input ou à déclarer les tâches complètes. Un nouveau détail
Petites Affiches épuisé à 22 h 47 est examiné séparément pour une erreur
de relais/authentification. La lecture de Ris indique désormais trois
documents téléchargés et extraits, mais le manifeste page par page doit
confirmer cette complétude avant de clore le cas. Le premier tick de santé
après `30002000`, à 23 h, réussit en 2 864 ms.

## Trois ticks SQL et correctifs de churn, 23 h 38 UTC

Les trois ticks `operational-health` postérieurs à la maintenance
`30002000` réussissent : 23 h en 2 864 ms, 23 h 15 en 2 351 ms et
23 h 30 en 4 003 ms. Il s'agit de contrôles planifiés réels ; aucune
invocation mutante supplémentaire n'est exécutée pour mesurer leur durée.

Le commit `78a32ab5` arrête les nouveaux claims généraux lorsque le worker
rencontre un épuisement réel du budget LLM. Les détails de source peuvent
continuer dans les mêmes limites de 90 traitements et 1 200 secondes.
Les checkpoints, délais de refroidissement et prérequis PDF n'activent pas
ce circuit. Les essais sont restaurés par le mécanisme existant de report.
Le bilan distingue les claims, les demandes de report et les statuts
observés, dont les identifiants absents du snapshot. La suspension générale
concerne aussi temporairement les PDF sans LLM ; aucune complétion de PDF
n'est déduite de cette suspension. Les 40 tests ciblés passent, dont un
scénario composé passant par le véritable chemin d'exception LLM. La
relecture indépendante approuve le correctif.

Le commit `5534db5b` retire les seules lignes de compteurs Licitor contenant
les glyphes de vues et favoris avec des nombres, des textes publics utilisés
pour les empreintes factuelles. Dans 585 paires de checkpoints dont les
champs structurés sont identiques et le texte diffère, 584 différences
proviennent exclusivement de ces compteurs. Les prix, surfaces, dates et
numéros de lots sont conservés. Le texte des `source_lots` reste brut pour
les preuves de catalogue et de multiplicité ; il ne fait pas partie des
champs factuels comparés. Les 86 tests ciblés passent et la relecture
indépendante approuve les chemins listing, lots fusionnés et détail.
La preuve agrégée est privée dans
`/private/tmp/immojudis-licitor-counter-proof-20260930.json`.

Ces deux commits et le correctif AGRASC `646746f6` attendent encore le
rejeu CI sur le HEAD final et leur qualification cloud. Aucun nouveau
worker de production n'est routé sur ces commits à ce stade.

Le cas Ris-Orangis reste incomplet : le manifeste réel de trois PDF compte
deux documents extraits et un document incomplet avec deux pages échouées.
Les lignes canoniques optimistes ne suffisent donc pas à clore le job.
Le patch PDF en relecture exige une preuve de cache correspondant aux
empreintes du fichier et du texte, préserve la reprise des checkpoints
partiels et distingue la réutilisation de faits déjà vérifiés d'une
nouvelle génération documentaire.

Le nouvel échec Petites Affiches n'est pas une panne d'authentification.
À 22 h 47 min 15 s, l'ancienne URL du job
`1bc9baf8-a5cd-4970-997a-4761b8e0264a` reçoit une redirection puis un
HTTP 400 du relais : sa destination utilise le chemin public
`/vente/immobiliere/n/`, absent de l'allowlist de la version 4. La fiche
actuelle correspondante, avec même titre et date, est récupérée en HTTP 200
à 22 h 50 min 58 s. La variable et le secret GitHub du relais sont présents,
et d'autres requêtes répondent HTTP 200 entre ces deux horaires. Le patch
en relecture autorise uniquement cette forme publique sur le même hôte,
sans query, fragment, identifiants ou port alternatif ; la garde d'identité
des détails reste requise. Le diagnostic Python distingue désormais le
refus de cible d'un refus d'authentification sans afficher l'URL ou le
corps de réponse. Aucun déploiement du relais n'a encore été effectué.
Les vérifications ciblées passent : cinq tests Deno, 30 tests Python
et sept cas ignorés, Ruff et contrôle de whitespace. Une relecture
indépendante est en cours avant commit et qualification cloud.

## Correctifs PDF et relais figés, 30 septembre à 00 h 07 UTC

Le correctif PDF passe 87 tests de fraîcheur, cache et file de tâches,
ainsi que 94 tests PDF avec répertoires temporaires, soit 181 cas ciblés.
Ruff, compilation et contrôle de whitespace passent. Les tests couvrent
les checkpoints partiels, l'absence de cache, les empreintes incohérentes,
les pages échouées, les profils mal formés et un dossier mixte avec un PDF
complet et un PDF vide. Une preuve complète persistée peut autoriser la
réutilisation de faits déjà vérifiés après disparition du cache éphémère ;
elle n'autorise pas une nouvelle génération de faits sans cache complet.
La file calcule cette réutilisation avant le contrôle du prérequis PDF.
Le document vide reste visible comme indisponible pour l'analyse ; il ne
certifie aucun fait documentaire. Ris-Orangis n'est pas déclaré complet
par ce correctif local et attend sa vraie extraction cloud.

La revue indépendante du relais a identifié une fuite de `Location` dans
les erreurs persistées : une redirection externe refusée pouvait encore
transporter des identifiants ou paramètres. Le commit `96d5c2a` refuse
désormais ces redirections avec une réponse 502 bornée, sans le header
ou le corps upstream. Seules les redirections publiques HTTPS de la même
origine sont transmises ; les ports alternatifs, identifiants, queries,
fragments et chemins non reconnus sont refusés. Le port HTTPS par défaut
443 est normalisé par `URL` comme la même origine. Les redirections de
liste avec query/hash sur l'URL source ne sont plus réécrites. Les tests
finaux passent : six tests Deno et 30 tests Python avec sept cas ignorés.
La relecture indépendante ne relève plus de blocage concret.

Les commits sont préparés pour un rejeu CI/CodeQL commun sur le HEAD
final. Le routage des workers et la version du relais de production ne
sont pas encore changés. Le canari doit respecter l'exécution sérialisée
existante et les mêmes limites de 90 jobs / 1 200 secondes, sans remise
à zéro d'essais ni modification de leases ou priorités. Aucun import IA,
envoi à un interlocuteur ou nettoyage de branche n'est exécuté.

Le run Licitor `36642781639`, lié à
`6a7ffddf-9d8c-4918-84d4-9ad33b19e7a5`, termine avec succès à
23 h 44 min 35 s côté SQL et 23 h 45 min 42 s côté GitHub, sur le
tag `f695a739` avec LLM désactivé. Il collecte, normalise et enrichit
588 identités distinctes, sans erreur. Les six partitions du certificat
porté par `summary.scrape_coverage.licitor` sont certifiées ; les trois
étapes dans `stage_status` sont complètes. Les 588 checkpoints sont liés
au run. Les compteurs 557 décisions publiées, 31 quarantaines et 552
upserts restent distincts ; ils ne doivent pas être présentés comme 588
biens publics. Le certificat Nord-Est annonce et voit 87 lignes, dont une
répétition identique, puis conserve 86 annonces adressables et parsées,
sans omission. La justification de ce doublon est agrégée dans le
certificat ; il ne conserve pas l'identité détaillée des deux occurrences.
Cette couverture décrit le catalogue public exposé au moment du scan,
pas la complétude de chaque fiche ni un inventaire privé.

La relecture finale du PDF a clos les derniers cas de file et de
matérialisation. Un résultat vide, robots ou skipped annule désormais les
jobs facts avec `review_required`, même quand `documents_listed=0` et dans
un lot PDF+facts. Un PDF restant seul ne déclenche aucun display implicite ;
un job display distinct reste traité. Un profil courant vide, inconnu ou
absent ne peut plus exposer les anciennes métriques comme preuve : les
compteurs texte, empreintes, chemin, pages, confiance et méthode hérités
sont effacés lorsque le cache n'est pas prouvé. Les quatre fichiers
queue/fraîcheur/cache/stockage passent 144 tests ; avec les 94 tests PDF,
le total ciblé est de 238 cas. Ruff et contrôle de whitespace passent.
La relecture indépendante donne son accord final ; les correctifs sont
préparés pour le push et la CI du HEAD commun.

## Premier rejeu du HEAD commun et corrections de fixtures

Sur `9cfcf412`, CodeQL `36650343202` réussit. La CI `36650343247`
réussit les migrations et pgTAP, les invariants du planificateur, la revue
des dépendances et les parcours navigateur. Elle échoue sur le formatage
Prettier de deux fichiers du relais et trois anciennes fixtures PDF de
`test_main.py` ; chaque version Python compte 1 925 cas réussis et 18 ignorés.
Les fixtures ne fournissaient que la date et l'empreinte d'entrée, désormais
insuffisantes pour certifier un cache PDF. Elles produisent maintenant un
cache JSON réel et sa preuve avec le helper de production, sans assouplir
la garde de fraîcheur. Les 41 tests de `test_main.py` et les 144 cas ciblés
queue/fraîcheur/cache/stockage passent ; Ruff et compilation passent aussi.
Les deux fichiers du relais sont formatés et leur contrôle ESLint passe.
Un nouveau rejeu complet est requis sur le commit de ces corrections.

Le job PDF de Ris-Orangis est désormais `failed` à quatre essais sur quatre,
sans lease active. Il ne sera pas réinitialisé pour le canari. Le worker
automatique démarré à 00 h 31 UTC doit terminer avant tout nouvel essai
manuel, conformément à la sérialisation des écritures.

## Qualification verte et déploiement interne du relais

Le HEAD `ad98089839aee2d1d9411dd569b5b3d597a7f582` passe la CI
`36651386737` et CodeQL `36651386735`. Python 3.11 et 3.12 comptent
1 928 tests réussis et 18 ignorés. Le rejeu SQL vérifie 200 migrations et
1 481 assertions dans 79 fichiers pgTAP, sans dérive ; quotas concurrents,
catalogue HTTP, intégration locale inbound et parcours navigateur passent.
La preview Vercel `dpl_4Zs4dj5HVZZ2xMAwPPU6s9XdHtjB` est READY au
même SHA. Avec l'accès officiel de la session CLI Vercel, le catalogue
répond 200, le cron inbound refuse une requête sans Authorization avec
401, et le webhook refuse GET avec 405. Aucun traitement entrant, import,
upload ou message à un contact réel n'est déclenché par ces lectures.

Le tag `immojudis-workers-ad980898` pointe exactement vers ce SHA. La
règle GitHub `24219887` interdit sa mise à jour et sa suppression, sans
acteur de bypass. Le routage automatique reste sur le tag précédent
jusqu'à qualification du canari `36653152710`, lancé à 01 h 01 min 56 s
après vérification d'une file de runs SQL vide et de la fin du workflow
Vench. Les limites restent de 90 jobs et 1 200 secondes ; aucun essai,
bail ou ordre de priorité n'est réinitialisé.

Le worker précédent `36650632243` termine à 00 h 42 min 56 s. Ses logs
prouvent 90 claims uniques, 45 détails et 45 généraux, en 706,3 secondes :
61 completed, cinq failed, cinq cancelled, 19 queued, zéro running et
zéro missing. Les 160 statuts du résumé SQL incluent des jobs voisins et
ne sont pas attribués à ces 90 claims. Trois échecs de détail sont les
HTTP 400 du relais après redirection, un échec facts manque de cache PDF
complet et un PDF reste incomplet. Les reports suivent l'épuisement du
budget LLM ; aucun essai n'est remis à zéro.

La collecte Vench suivante utilise le transport direct. Le relais peut
donc être corrigé indépendamment de ce run actif, après fin du worker
d'enrichissement. La version distante 4 a été sauvegardée exactement ;
elle ne contient ni le chemin `/n/` ni la garde `safeRedirectLocation`.
Un bundle local initialement présenté comme backup distant a été rejeté
comme preuve et correctement identifié comme candidat local. La version
5 est déployée à 00 h 54 UTC, ACTIVE, avec authentification custom
inchangée. La relecture distante confirme une égalité exacte des quatre
fichiers avec le HEAD validé ; digest bundle
`0362b895889089192cbb0efbd4ab5960b2aebd9e200936e58af690197458201e`.
Les requêtes sans token et avec un faux token répondent 401 sans fetch
source. Le contrôle authentifié des chemins publics reste à effectuer.

## Canari du nouveau worker et deux blocages concrets

Le run `36653152710` réussit côté GitHub, mais ne qualifie pas encore une
bascule automatique. Ses 38 claims uniques, 19 détails et 19 généraux,
donnent 25 completed, un failed, sept cancelled, cinq queued, zéro running
et zéro missing. Six reports ont été demandés. Il dure 1 325,3 secondes,
soit 125,3 secondes au-delà du budget nominal de 1 200 secondes, parce que
la deadline est vérifiée avant le claim sans interrompre une passe OCR
déjà lancée. Cinq passes checkpointent environ 75 pages ; le PDF failed
reste incomplet. Neuf appels LLM réels et leurs caches sont observés,
sans épuisement quota : ce run ne constitue pas une preuve cloud du
circuit quota, couvert par ses tests locaux. Aucun HTTP 4xx du relais
n'apparaît sur cet échantillon plus petit de détails.

Une borne de temps propagée au PDF, avec OCR réellement interrompable,
marge de clôture et restitution des claims est en correction. Elle doit
conserver les checkpoints et distinguer un arrêt par deadline d'un PDF
illisible sans progrès ; aucun de ces états ne peut être déclaré complete.

La vérification après renouvellement de l'accès Supabase est datée de
05 h 49 UTC, quatre heures après le canari ; ses statuts courants ne sont
pas attribués rétroactivement au run. Le job PDF `80de5924` porte deux
documents bloqués par robots et aucun texte : les lignes canoniques pending
sont cohérentes. Le job `b5ae1461` a au contraire quatre profils et preuves
complets à 01 h 24 min 38 s, avec extraction persistée. Un worker ultérieur
réécrit pourtant ses quatre lignes en unknown/pending à 05 h 47 min 25 s
lorsque le cache local manque. C'est un défaut de matérialisation : une
preuve persistée valide doit survivre au cache éphémère, tandis qu'une
nouvelle génération factuelle exige toujours un cache complet. Le correctif
est en cours, avec validation exacte des profils, empreintes et documents.

L'ancien job Ris-Orangis `e5d6e2a2` est annulé à 01 h 02 min 40 s avec le
motif `Superseded by a newer input revision`, tentative toujours quatre
sur quatre. La révision source a créé un nouveau PDF à 00 h 47 min 28 s.
Ce dernier épuise ses essais naturellement à 04 h 02 min 37 s, document
toujours incomplet ; aucun reset, claim ciblé ou clôture artificielle.

À 05 h 56 UTC, la file due compte 2 911 display, 76 facts, 406 PDF et
2 634 détails. Les tâches ouvertes de plus de 48 heures restent respectivement
596, 35, 24 et 2 067. Les variations depuis la baseline mêlent traitements,
nouveaux inventaires et supersessions ; elles ne prouvent pas une résorption
durable. La production reste sur `f695a739`. Le plan de nettoyage est prêt
en lecture seule et préserve PR ouvertes, worktrees actifs et tags de rollback.
Aucune publication applicative finale, import IA ou suppression de branche.

## Reprise du 30 septembre à 06 h 30 UTC

Le relevé compte 6 012 tâches dues : 2 889 descriptions, 73 faits,
392 PDF et 2 658 détails. Les tâches ouvertes de plus de 48 heures sont
respectivement 597, 28, 26 et 2 081, soit 2 732. Aucun job d'enrichissement
n'est running dans cet instantané. Le workflow automatique `36678538535`
vient toutefois de démarrer ; cette absence de bail ne permet pas de lancer
un autre traitement en parallèle. Le worker précédent `36676018028` dure
1 200,6 secondes sur `f695a739` : 34 claims uniques, 25 completed, cinq
failed, deux cancelled et deux queued. Ses 37 passages ne sont pas 37
réussites distinctes. Ces nouveaux compteurs ne qualifient pas une résorption.

Le correctif de deadline reçoit un accord de relecture IA indépendante.
Le temps résiduel est recalculé après DNS, préparation Docling et rendu
plus sauvegarde PNG, avant HTTP ou subprocess. L'expiration restitue
l'essai, conserve les checkpoints et coupe les nouveaux claims pendant
la marge finale. Les opérations natives synchrones de rendu et certains
SDK restent sans interruption absolue ; le correctif ne promet pas une
borne sur chacun de ces appels. La qualification CI et cloud de ce nouveau
diff reste à effectuer.

La revue automatique refuse une variante de récupération d'un sous-ensemble
de textes PDF : elle considère que cela pourrait affaiblir la validation
globale du manifeste. Elle refuse ensuite une alternative de statut fondée
sur des métadonnées seules, même sans transmettre de texte, car le statut
extracted pourrait constituer un faux succès en l'absence du résultat réel.
Les deux variantes sont annulées. Une récupération des textes complets
réellement persistés est en préparation, avec validation du manifeste entier,
de la provenance et de chaque SHA texte recalculé. Elle est limitée à la
matérialisation documentaire ; les manifestes mixtes restent inéligibles,
et la garde de génération conserve son exigence du cache local complet.

Les 166 tests des suites PDF, reprise et worker passent dans un cache
temporaire. Le diagnostic des huit jobs PDF failed ne justifie aucun reset
ni quarantine ; des résultats postérieurs existent pour quatre d'entre eux,
trois portent des pages encore échouées et un possède déjà un successeur
queued. Parmi les 26 PDF ouverts de plus de 48 heures, neuf possèdent des
profils historiques sans preuve v1 : ils ne seront pas restaurés par ce
fallback et devront être réextraits. Onze n'ont pas de résultat antérieur,
cinq pas de ligne documentaire et un porte un état intermédiaire. Aucun
succès artificiel n'est produit à partir de ces compteurs.

Une troisième lecture IA aveugle de la capture AGRASC 362606 retient quatre
pièces, séjour et trois chambres, avec SHA de capture vérifié. Le résultat
privé conserve prompt exact, hash, identité réelle de l'agent et heures de
lecture. Il complète la chronologie de relecture sans modifier le manifeste
v4.2, sa garde d'import ou l'état non vérifié de l'identité source. Aucun
import n'est réalisé.

## Trois correctifs relus avant nouvelle qualification

Les trois diffs sont figés et reçoivent chacun un accord IA indépendant.
La récupération documentaire centrale lit les seuls dossiers sans cache
local et avec manifeste complet. PostgreSQL limite à cinq versions par
source ; REST travaille par lots de cinq et fait une seule tentative de
15 secondes, connexion de cinq secondes, sans toucher aux retries des
écritures. Le modèle, provider, schéma, empreinte documentaire, profils et
preuves v1 sont exacts ; les SHA fichier correspondent et le SHA texte est
recalculé sur le texte réellement lu. Un hash global de fiche différent
n'invalide pas ces identités documentaires. Les SHA exigent exactement
64 caractères hexadécimaux, sans signe ni préfixe `0x`.

La matérialisation ne réexpose aucun chemin local disparu. Elle conserve
`verified_at` historique, indique la provenance `persisted_pdf_text` et
utilise le statut de téléchargement `verified`, sans simuler un nouveau
download. Les textes ne rejoignent ni `_load_pdf_texts`, ni les risques,
ni la génération. Une corruption ou un manifeste mixte refuse entièrement
la récupération. La limite REST est globale au lot : un historique très
déséquilibré peut laisser un dossier en attente, sans accepter une preuve
partielle. Les 123 tests stockage/main/fiabilité passent ; les neuf cas
ciblés finaux couvrent reconstruction, corruption, timeout et formats SHA.

La collecte Enchères Immobilières `36678538535` échoue de nouveau à
06 h 33 UTC, zéro upsert : quatre tentatives de liste, aucune page, puis
arrêt contrôlé sans nettoyage. Une lecture publique ordinaire confirme
le timeout de l'origine ; augmenter les retries n'apporterait pas de preuve.
Le client commun corrige séparément son comportement après échec robots :
réseau/5xx interdit toute requête catalogue avec diagnostic retryable,
403 et challenges restent des refus distincts, et les corps 404/410 sont
ignorés comme absence de politique, y compris après redirection.
Ces règles suivent la [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.3.1.4).
Les tests common finaux comptent 22 succès ; 37 tests sources/retry/catalogue
et sept tests ciblés source_detail, un ignoré, ont également réussi. La
relecture finale valide le delta 404/410 après correction.

Ruff et `git diff --check` sont verts. La CI complète, le nouveau tag
candidat et les essais cloud restent requis ; le worker automatique garde
le tag qualifié précédent. Une collecte Avoventes sur un nouveau tag est
le premier essai prévu pour le cas de cache absent : GitHub isole les caches
de tags différents, selon sa [documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).
La présence réelle ou l'absence du cache devra être constatée dans le run,
sans être déduite du seul nom du tag.

## Défaut confirmé dans la sérialisation PDF — 30 septembre, 07 h 21 UTC

La lecture scalaire du résultat réellement persisté du job
`b5ae1461-7eb4-418d-b403-2726c808e480` révèle quatre textes de
13 896, 4 356, 2 867 et 34 162 caractères, tous en cache v3, mais aucun champ
`complete`, `extraction_status` ou `failed_pages`. Les profils et la preuve
v1 sont complets à 01 h 24 ; le résultat texte de 01 h 24 min 42 s a perdu
ces marqueurs dans `_write_pdf_text_cache`. Le validateur conservateur les
rejette donc correctement. Le relevé de 07 h 42 retrouve cette absence dans
les 309 résultats PDF récents observés ; une preuve de profil seule ne suffit
pas à les rendre utilisables.

Le writer conserve désormais les marqueurs explicitement produits par
l'extracteur, y compris les valeurs nulles, sans les ajouter aux payloads
legacy. Il écrit un temporaire dans le même dossier puis remplace le fichier
atomiquement. Les tests d'échec de sérialisation et de remplacement prouvent
que l'ancien fichier reste identique et que le temporaire est nettoyé.
Le fixture de stockage utilise le vrai writer, relit son JSON, génère la
preuve par le vrai générateur puis vérifie la matérialisation après
reconstruction de la fiche. Un résultat partiel ou legacy reste refusé,
même en présence d'une preuve annoncée complète. Relecture IA indépendante
favorable ; 170 tests PDF/reprise/worker et 62 tests stockage passent.

La qualification cloud commencera par un worker d'enrichissement ordinaire
du nouveau SHA vert pour produire un résultat avec les vrais marqueurs.
Une collecte avec cache local effectivement absent pourra ensuite vérifier
la récupération persistée. Cette séquence remplace le premier essai
Avoventes annoncé ci-dessus. Aucun ancien résultat n'est corrigé par
inférence, aucun job n'est remis à zéro pour forcer l'essai.

## Diagnostic de la CI `df0904a6` — 30 septembre, 07 h 44 UTC

La [CI 36682996423](https://github.com/Aprivi-dev/immojudis/actions/runs/36682996423)
échoue ; [CodeQL 36682996459](https://github.com/Aprivi-dev/immojudis/actions/runs/36682996459)
réussit. Python 3.11 et 3.12 comptent chacun 1 959 succès, 18 ignorés et un
test obsolète : il attendait une requête catalogue après redirection de
`robots.txt` hors origine. Le contrat corrigé exige un seul appel au relais,
pour les robots, et aucune collecte après le refus. Les 31 tests transport
cloud et client commun passent sans modification de la garde.

Le Web s'arrête sur l'audit npm, avant typecheck. Le lockfile identique à la
CI antérieure est désormais signalé pour `brace-expansion`, `engine.io` et
`fast-uri`. Une mise à jour ciblée, sans changement majeur ni script
d'installation, sélectionne respectivement 5.0.12, 6.6.11 et 3.1.8.
L'audit de production repasse à zéro alerte. Les avis primaires documentent
les correctifs : [brace-expansion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr),
[Engine.IO](https://github.com/advisories/GHSA-2gc4-cqfq-p2gv),
[fast-uri](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj).
La CI complète doit confirmer le build et les budgets sur le prochain SHA.

L'audit incluant le développement signalait également `undici` 7.29.0,
utilisé par jsdom. Sa mise à jour compatible vers 7.30.0 ramène aussi l'audit
complet à zéro alerte. L'[avis de l'éditeur](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3)
confirme le correctif de vérification TLS à partir de 7.29.1. Le manifeste
des dépendances directes est inchangé ; le lockfile conserve les versions
majeures et les bornes imposées par leurs parents. npm 11.18 régénère en
outre les marqueurs optional de sharp et de sa dépendance couleur, tous
deux déjà nécessaires au projet ; aucun script d'installation n'est lancé.

Le relevé de production de 07 h 42 compte 6 581 jobs dus et 2 731 ouverts
de plus de 48 heures, dont 2 071 détails, 598 descriptions, 35 faits et
27 PDF. Aucun job ne tourne. Le dernier worker automatique termine à
07 h 06 en 1 203,9 secondes. Vench termine à 07 h 37 avec couverture
d'inventaire complète ; Enchères Immobilières reste en échec fournisseur.
Ces observations ne satisfont pas le critère de résorption durable.

## Garde de taille de module — 30 septembre, 07 h 57 UTC

La [CI 36686057381](https://github.com/Aprivi-dev/immojudis/actions/runs/36686057381)
termine sur `dc69bb98` avec un seul contrôle en échec :
`pdf_enrichment.py` compte 1 720 lignes pour un plafond métier de 1 500.
Python 3.11/3.12, audit des dépendances, SQL, invariant du planificateur,
Playwright et [CodeQL](https://github.com/Aprivi-dev/immojudis/actions/runs/36686057418)
réussissent. Le job Web passe audit npm, typecheck, lint, tests, invariants
et build avant le refus du budget de module.

Les compteurs finalisés sont 1 966 tests Python réussis et 18 ignorés par
version, audits pip sans vulnérabilité connue, 200 migrations distinctes,
79 fichiers pgTAP et 1 481 assertions, aucune dérive. Le Web compte
1 336 tests réussis, cinq ignorés ; le catalogue HTTP et l'intégration inbound
locale réussissent aussi. Ces succès ne remplacent pas la CI du refactor.

La classification documentaire et les mesures de pages sont séparées en
modules dédiés, avec conservation des imports existants et sans modification
du comportement de deadline, OCR ou preuve PDF. Le nouveau module reste
soumis au même budget de taille. Le plafond de 1 500 n'est pas relevé.

Le comptage identique au script CI donne maintenant 1 494 lignes pour
`pdf_enrichment.py`, 148 pour `pdf_document_types.py` et 159 pour
`pdf_page_analysis.py`. Les suites PDF, reprise, worker, stockage et fiabilité
comptent 232 succès et deux tests ignorés ; Ruff et le diff sont propres.
Le build complet précédent est vert ; le contrôle des budgets Web et la CI
complète doivent repasser sur le SHA de ce refactor.

La relecture IA indépendante confirme l'identité des fonctions déplacées
et des constantes, l'absence de cycle et les noms réexportés depuis le
module initial. Les callbacks OCR patchés par les tests restent dans ce
module. Les nouveaux tests de helpers doivent viser leur module propriétaire ;
aucun appelant actuel ne remplace leur binding réexporté à l'exécution.

La santé opérationnelle existante réussit à 07 h 45 en 4,4 secondes.
L'alerte `cron.stale` concerne uniquement `information-agent-inbound`,
volontairement non activé avant publication de sa route. L'alerte d'import
est résolue ; l'inventaire Enchères Immobilières et le backlog demeurent
les incidents opérationnels actifs. Les 2 067 anciens détails de source
ne sont pas des tâches terminales oubliées : 2 046 sont réclamables et
21 sont bloqués par la suspension d'Enchères Publiques. Aucun de ces jobs
ne justifie une clôture artificielle au titre de la rétention.

## Qualification de `81022c19` — 30 septembre, 08 h 45 UTC

La [CI 36687905674](https://github.com/Aprivi-dev/immojudis/actions/runs/36687905674)
et [CodeQL 36687905650](https://github.com/Aprivi-dev/immojudis/actions/runs/36687905650)
réussissent sur le SHA exact
`81022c1910154c64605dd7fc595352499623a5c6`. Python 3.11 et 3.12 comptent
chacun 1 966 succès et 18 tests ignorés ; pip-audit est vert. Le Web compte
1 336 succès et cinq tests ignorés ; audit npm, types, lint, invariants,
build et budgets réussissent. Les 200 migrations, 79 fichiers pgTAP et
1 481 assertions passent sans dérive ; intégration inbound locale,
catalogue HTTP, Playwright et planificateur sont également verts.

La preview Vercel `dpl_HkgHuLqZdwoohUbUqntccGMAnnSo` est prête sur ce SHA.
Les GET de l'accueil et de `/sales` répondent 200 ; l'en-tête
`x-robots-tag: noindex` est présent. Sans authentification, le GET inbound
répond 401 et le GET webhook Resend 405. Ces contrôles ne déclenchent
aucun envoi, import, upload ou écriture de production.

Le tag `immojudis-workers-81022c19` pointe exactement vers ce commit,
protégé contre mise à jour et suppression par la règle 24234724 sans
bypass. Le [canari 36688865110](https://github.com/Aprivi-dev/immojudis/actions/runs/36688865110)
attend la fin de la collecte automatique puis démarre à 08 h 41 min 36 s.
Il réussit, avec les résultats détaillés plus bas. Il confirme le writer
sur un dossier partiellement couvert ; la récupération du manifeste entier
reste à qualifier. Il ne qualifie pas le correctif source suivant.
La route automatique reste sur `f695a739`.

## Inventaires publics et pagination AGRASC — 30 septembre, 08 h 43 UTC

L'[audit 36689110240](https://github.com/Aprivi-dev/immojudis/actions/runs/36689110240)
utilise le même tag et neutralise Supabase et LLM. Notaires émet 831 URL
uniques en 37 requêtes réussies, sans erreur, et atteint la fin de la
source. Le certificat couvre l'inventaire du connecteur ; il ne certifie
ni une énumération indépendante du site ni la complétude de la base.

AGRASC compte 37 cartes sur sept pages et huit requêtes réussies : neuf
URL adressables, dont huit émises et un catalogue vendeur exclu faute
d'identité d'annonce. Les 25 cartes sans lien portent à la fois la classe
et le statut visible de vente terminée. Aucun total public exploitable
n'est présent ; les certificats global, adressable, émission complète et
base restent tous faux.

Une sonde limitée à la page initiale et `page=1`, avec le client existant,
ses robots et sa cadence, confirme le HTML primaire. Chaque réponse
contient un seul widget dans `.view-liste-ventes-immobilieres` : le lien
explicite `fr-pagination__link--last` mène à `page=5` sur la page initiale
et à `page=6` sur la seconde. Trois URL de détail se répètent entre leurs
six cartes respectives. Les liens sont sur le même chemin avec le seul
paramètre `page`. Il s'agit d'une ambiguïté des réponses du fournisseur,
sans preuve pour départager pagination dynamique et autre défaut côté site.
Le parseur ne confond pas deux widgets. Aucune fin n'est choisie par
inférence ; aucun nettoyage ni création des archives sans identité.

## Deadline coopérative des détails — 30 septembre, 09 h 02 UTC

La vérification des durées montre qu'un lot source de deux détails peut
prendre 162,6 secondes. Commencer juste avant la limite d'admission à
1 140 secondes peut donc dépasser le budget worker de 1 200 secondes.
Le cutoff PDF existant ne protégeait pas ces requêtes.

Le commit `285190e49f9956bc38fb0a3ea35f1ef7f5d1980a` transmet désormais le même cutoff aux détails,
avec la marge de finalisation dynamique existante. Un contexte task-local
est restauré dans `finally`. Les contrôles couvrent admission de job,
robots, cadence, retries, réponse, préparation et début de publication.
Les timeouts HTTP sont recalculés au moment de la requête. Une expiration
est distinguée d'un refus fournisseur ou d'une indisponibilité robots.
La tâche possédée et les claims restants sont restitués sans perte de
tentative, avec les gardes de lease existantes et une restitution
idempotente. Le transport relais borne aussi son client interne,
qui ignorait le timeout externe. Le body est lu et décodé avant le dernier
calcul du timeout ; hors contexte, les 40 secondes historiques sont
conservées. La relecture indépendante valide ce delta et ses 12 tests.

Les appels SQL et les opérations natives déjà engagés restent
non interruptibles par ces contrôles coopératifs. Le patch ne garantit
donc pas une limite absolue de 1 200 secondes pour toute opération.
Il ne modifie ni les quotas, ni les retries autorisés, ni les règles SQL.
Les auteurs ont vérifié 138 tests source/queue, dont 14 ignorés, et
49 tests client/retry/relais réussis. La suite intégrée finale compte
159 succès et 14 tests PostgreSQL ignorés localement ; Ruff et le diff
sont propres. La relecture indépendante du worker confirme les leases,
le reset du contexte et l'absence de capture large dans les parseurs du
chemin `fetch_public_detail` ; ses 111 tests ciblés réussissent, un est
ignoré. Nouvelle CI et canari du prochain SHA restent requis.

La [CI 36693472747](https://github.com/Aprivi-dev/immojudis/actions/runs/36693472747)
et [CodeQL 36693472822](https://github.com/Aprivi-dev/immojudis/actions/runs/36693472822)
réussissent sur ce commit poussé. Les deux versions Python comptent chacune
1 985 succès et 18 tests ignorés ; les audits pip sont verts. Le Web
compte 1 336 succès et cinq ignorés, audit npm sans vulnérabilité connue,
build et budgets verts. Les 79 fichiers pgTAP et 1 481 assertions passent,
sans dérive SQL ; catalogue HTTP, inbound local, Playwright, dépendances
et invariant du planificateur sont verts. Ces contrôles ne qualifient pas
les changements AGRASC et deadline LLM suivants.

## Première page AGRASC reproductible — 30 septembre, 09 h 06 UTC

Une requête à l'URL publiée `?page=0` affiche le terminal 6, six cartes
et six liens parsés. Ses cartes se recouvrent avec seulement deux des six
cartes de l'URL sans query, et aucune de `?page=1`. Le contenu de l'URL
sans query n'est donc pas un alias fiable de la première page publiée.
La cause de cette différence côté fournisseur n'est pas démontrée.

Deux passages avec le même client existant et sa politique robots suivent
les sept pages publiées `?page=0` à `?page=6`. Les 14 requêtes de liste
réussissent, sans retry ni refus. Les pages 0 à 5 annoncent toutes le
terminal 6, puis la page 6 termine la chaîne. Les deux inventaires parsés
contiennent exactement les mêmes 12 URL. Ce compteur ne mesure pas
les nouvelles fiches publiées dans la base.

Les pages 2 à 5 contiennent chacune six archives sans lien ; la page 6
en contient une. Les 25 cartes uniques portent toutes `sold=True` avec
preuve `sold_class_and_visible_status`. Aucun cas sans lien non vendu
n'est observé. La lecture de ces captures ne crée aucune identité manquante.

Le collecteur commence maintenant sur la première page explicitement
publiée `?page=0`. Le périmètre du widget, les exclusions et tous les
certificats restent inchangés ; aucune complétude globale n'est forcée.
Les tests couvrent une URL sans query incohérente et le refus de certifier
un mélange d'archives vendues et de carte sans statut. Les 28 tests
certificat/catalogue et 76 tests parseurs/matrice source passent ; Ruff
et le diff sont propres. La relecture indépendante valide le changement,
avec 110 tests verts ; la CI du futur SHA reste requise.

## Canari `81022c19` et vrais marqueurs PDF — 30 septembre, 09 h 14 UTC

Le [run 36688865110](https://github.com/Aprivi-dev/immojudis/actions/runs/36688865110)
réussit : job de 08 h 41 min 36 s à 09 h 01 min 39 s, worker en
1 141,1 secondes avec arrêt `finalization_margin` et environ 58,9 secondes
restantes sur le budget de 1 200. Les 60 claims sont uniques, répartis
30/30 entre source et enrichissement ; le lot source maximal prend
35,1 secondes. Les résultats sont 38 terminés, sept échoués, sept annulés
et huit restitués, sans claim running, manquant ou autre. Le débit de
189,3 claims par heure inclut les échecs et reports ; il ne mesure pas
un débit de fiches complètes ni une résorption durable.

Cinq erreurs PDF restent agrégées sans sous-cause exploitable dans le log,
sur quatre documents Avoventes et un Info-Enchères. Deux longs PDF atteignent
75/80 et 75/87 pages avec 35 et 74 pages nouvelles checkpointées. Un autre
est arrêté à la deadline après 6/38 pages. Cinq faits attendent encore leur
prérequis PDF. Les huit restitutions correspondent aux reports demandés.
Aucun HTTP 4xx/5xx ou épuisement de quota Replicate n'est observé ; ce run
ne qualifie donc pas à lui seul le déclenchement du circuit quota.

La lecture SQL finale identifie l'extraction
`ed25ca66-5b7b-4410-88b0-3e0cdc496220`, persistée à 09 h 00 min 08 s
pour la vente `1491d595-75a0-47fe-90a1-2fddf96eb89d`. Les six textes ont
les marqueurs explicites `complete=true`, `extraction_status=extracted`
et aucun échec de page. Leurs six SHA fichier concordent avec la preuve v1
de 09 h 00 min 03 s ; les six SHA des textes normalisés, recalculés sans
exposer les textes, et les six longueurs concordent également. Cela
confirme le vrai writer corrigé sur un résultat de production.

Le manifeste courant comprend toutefois 16 PDF distincts, avec seulement
six profils. Il ne satisfait pas la récupération persistée du manifeste
entier ; aucun résultat partiel n'est promu. Le plafond sélectionne six
documents par vente. L'essai cold doit donc utiliser un dossier réellement
traité et entièrement couvert de six documents ou moins, avec cache local
absent et provenance `persisted_pdf_text` visible après l'upsert central.
Les écritures legacy postérieures du worker automatique ne sont pas une
preuve du writer candidat et restent distinguées par leurs timestamps.

## Deadline des requêtes IA — correction suivante, 30 septembre

La relecture du chemin Replicate trouve des timeouts POST et polling
configurés à 180 secondes et une cadence/retry indépendante du worker.
Ces opérations peuvent commencer juste avant le cutoff et dépasser la
marge de 60 secondes, malgré le succès du canari précédent. La correction
propage une deadline LLM task-local à la création, aux attentes
et au suivi des prédictions, avec restitution des claims sans tentative.

Les frontières avant POST et après POST sont distinctes : une réservation
connue non envoyée peut être libérée ; une issue réseau inconnue conserve
sa réservation, et une prédiction acceptée conserve son ID. Aucun faux
succès ou échec terminal n'est enregistré pour rendre le délai vert.
Les checkpoints factuels déjà réussis restent réutilisables dans les tests.
Les gardes SQL de réservation ambiguë empêchent un nouveau POST aveugle ;
une réconciliation fournisseur peut rester nécessaire. Les quotas,
retries et limites de sélection ne sont pas augmentés.

Les attentes cadence, retry 429 et polling dorment jusqu'au plus petit
des délais restant et configuré, puis contrôlent de nouveau la deadline.
L'arrêt atteint donc le cutoff réel avant que le worker puisse admettre
une autre vente. Le timeout POST est recalculé après préparation et
réservation ; le timeout GET respecte le même cutoff. Un TransportError
après POST conserve l'issue `ambiguous`, puis vérifie la deadline.
Le chemin public de génération enregistre cette issue une seule fois,
en conservant l'identifiant fournisseur. La télémétrie privée conserve
également cet état lorsqu'elle est appelée directement.

La réservation du quota autonome n'a pas de primitive de libération : si
la deadline survient après celle-ci mais avant le POST, ce ledger reste
conservateur ; seule la réservation de requête non envoyée est libérée.
Les gardes empêchent une duplication aveugle, mais ne constituent pas une
réconciliation automatique d'une prédiction fournisseur encore inconnue.
La relecture indépendante finale approuve le delta : dix tests deadline,
50 tests queue et 98 tests enrichissement/cache/budget/coûts réussissent.
Ruff, compilation et diff sont propres. La CI du futur commit et son
canari cloud restent requis.

## Diagnostics PDF — 30 septembre, 10 h 00 UTC

Le log du canari précédent montre cinq documents téléchargés avec HTTP 200,
puis des erreurs d'extraction sans leurs sous-causes. Il ne démontre ni un
refus d'accès ni une expiration de deadline pour ces cinq documents.
Les payloads de pages comportent pourtant des motifs tels que `ocr_failed`
ou `empty_page_not_proven_blank`, perdus dans le diagnostic agrégé de la file.

Le nouveau helper extrait les seuls statuts, pages et causes reconnus.
Les exceptions conservent leur classe, sans leur message. Les pages
explicitement exclues comme vides restent exclues des échecs. Le format des
logs filtre les statuts et raisons, borne l'affichage à 20 pages, indique
le total au-delà et ignore textes, URL et tokens. Le profil conserve les
causes et l'analyse contient `failed_document_diagnostics`. La queue joint
au diagnostic trois fragments au maximum, avec les chemins déjà nettoyés
de leur query. L'échec continue à empêcher l'upsert des faits partiels.
Les checkpoints et règles de complétude ne sont pas assouplis.

La suite intégrée isolée finale compte 199 succès sur deadline IA, queue,
PDF, reprise documentaire et certificats AGRASC ; Ruff est vert. La relecture
indépendante approuve les 57 tests diagnostic/queue, y compris le statut
réel `blank_page_excluded`, le fallback `extraction_status` et le maintien
du blocage lorsque les marqueurs de page se contredisent. Le module PDF
reste à 1 497 lignes sous le budget de 1 500. La CI du nouveau SHA et son
canari restent requis ; les causes des cinq anciens documents devront
être constatées lors d'une nouvelle extraction normale.

## Baseline et dossier warm — 30 septembre, 09 h 50 UTC

La lecture SQL compte 6 021 queued, 31 failed et un running, soit 6 053
tâches ouvertes. Les 6 027 dues réessayables sont uniquement queued/failed,
avec `attempt_count < max_attempts` et `next_attempt_at` arrivé à échéance.
Les 2 679 tâches de plus de 48 heures sont queued/failed/running encore sous
le plafond de tentatives ; elles n'incluent pas les 19 épuisées, comptées
séparément. Ce relevé ne démontre pas une résorption sur un cycle complet.

Le dossier Avoventes `3a486846-45f4-49d8-8731-e6d0c06a7dbf` comporte quatre
PDF, quatre profils et quatre preuves aux empreintes concordantes. Les
quatre textes persistés à 01 h 24 min 42 s ont les bons SHA fichier, SHA
des textes recalculés et longueurs, mais aucun marqueur `complete`,
`extraction_status` ou `failed_pages`. Il reste un candidat warm legacy
à extraire normalement, pas une preuve cold éligible. L'absence du champ
`text_sha256` directement dans le résultat n'est pas un défaut : le writer
et le validateur utilisent le hash recalculé comparé à la preuve.
Aucun job n'est réclamé, réinitialisé ou forcé pour cet essai.

## Qualification cloud du commit 74dd49f6 — 30 septembre, 10 h 52 UTC

Le commit `74dd49f6c6649cecfe2c3b765c3811ef33536ebd`, poussé à
10 h 11 UTC, passe la [CI complète](https://github.com/Aprivi-dev/immojudis/actions/runs/36700888184)
et [CodeQL](https://github.com/Aprivi-dev/immojudis/actions/runs/36700888139).
Python 3.11 et 3.12 comptent chacune 2 005 succès et 18 tests ignorés ; le
Web compte 1 336 succès et cinq tests ignorés, avec 87 parcours Playwright.
Les 200 migrations et les 1 481 assertions de 79 fichiers pgTAP passent,
sans dérive. Audits, build, budgets, catalogue HTTP et intégration inbound
sont verts. Le budget compte 1 498 lignes pour le plus grand module surveillé,
sous le plafond inchangé de 1 500.

La preview `dpl_GKMw4np3KSLTY5Qb5CC4tdF4kdPP` est READY sur ce SHA
exact. L'accueil et le catalogue répondent 200 avec `x-robots-tag: noindex` ;
le cron inbound sans authentification répond 401 et le webhook en GET 405.
Aucun POST, envoi, import ou upload n'a été effectué.

Le tag `immojudis-workers-74dd49f6` pointe sur ce SHA. Le ruleset actif
`24240212`, sans bypass, interdit sa modification et sa suppression ainsi
que celles de la future référence cold. Le [canari](https://github.com/Aprivi-dev/immojudis/actions/runs/36702119440)
est déclenché à 10 h 23 UTC et reste en attente à 10 h 51 derrière le
worker automatique Licitor. La référence cold n'est pas encore créée.
Aucun worker n'est annulé ; le routage automatique reste sur `f695a739`.

L'[audit public AGRASC/Notaires](https://github.com/Aprivi-dev/immojudis/actions/runs/36702398918)
réussit sur le même tag, sans Supabase ni IA. Notaires parcourt une page VAE
et 35 pages VNI : 832 lignes parsées et validées, toutes émises, aucune
exclusion ou erreur. Le certificat opérationnel API du connecteur est vrai ;
le certificat HTML générique n'est pas applicable à cet inventaire API.
AGRASC visite toutes les pages 0 à 6, émet 12 URL valides, sans exclusion
ni échec. Parmi 38 cartes, 25 archives vendues sans identifiant représentent
26 occurrences. Le périmètre adressable est certifié ; les certificats
global et toutes-annonces restent faux avec `public_cards_without_identifiers`.
Les deux certificats DB restent faux : cet audit ne persiste pas les annonces.

La relecture du delta suivant confirme qu'une génération PDF déterministe
peut créer une seule tâche de reprise, en conservant les anciennes tentatives.
Elle découvre aussi que les anciennes tâches facts/display épuisées peuvent
conserver leur hash après un vrai succès PDF lorsque le SHA fichier reste
identique. Cette reprise est en correction ; elle doit dépendre d'une preuve
documentaire complète et rester stable entre les scans. Le scénario PostgreSQL
doit être exécuté dans la base jetable de CI avant qualification.

Une lecture des seuls noms des variables Vercel Production à 10 h 50 confirme
que `INFORMATION_AGENT_PORTAL_SECRET` est toujours absent. Aucun ajout ni
contournement du refus automatique d'autorisation n'a été tenté.

## File pendant la collecte Licitor — 30 septembre, 10 h 54 UTC

Avec les mêmes prédicats que le relevé de 09 h 50, la file compte 6 630
tâches ouvertes, dont 6 607 dues réessayables, aucune running, 2 676 de plus
de 48 heures encore réessayables et 19 épuisées. Les tâches dues se répartissent
en 3 434 descriptions, 86 faits, 465 PDF et 2 622 détails source ; les anciennes
réessayables en 600, 25, 29 et 2 022. La collecte en cours crée de nouvelles
révisions : ce relevé ne prouve pas une résorption durable.

À 10 h 55, le run automatique Licitor indique `phase=publishing` ; 527
ventes Licitor ont été mises à jour sur les 45 dernières minutes, la dernière
à 10 h 55 min 17 s. La collecte progresse réellement. Le canari candidat
encore en attente n'est pas l'auteur de ces écritures.

Le smoke public sur `https://immojudis.com` réussit sur les cinq endpoints,
avec HTTP 200 et corrélation `x-request-id`. La route canonique
`/api/cron/information-agent-inbound` répond toujours 404 et le webhook Resend
refuse GET avec 405. Ces lectures ne déclenchent aucun traitement entrant.
La commande locale de vérification des variables Production ne dispose pas
des identifiants nécessaires ; son échec ne démontre pas une absence de ces
variables dans Vercel.

## Verrou Enchères Publiques — 30 septembre, 11 h 16 UTC

La relecture trouve des chemins manuels encore activés par défaut malgré
la suspension du planificateur. La configuration passe à deux paramètres
désactivés par défaut : `ENABLE_ENCHERES_PUBLIQUES_BENCHMARK` et
`ENCHERES_PUBLIQUES_ACCESS_AUTHORIZED`. Collecte, détails source, audits
qualité/couverture, refresh de procédures et probe navigateur refusent avant
accès réseau tant que les deux ne sont pas explicitement configurés.
L'audit global couvre neuf sources actives ; Enchères Publiques exige un
groupe explicitement sélectionné. Les 107 tests ciblés passent, sept sont
ignorés ; Ruff, syntaxe YAML et refus du probe avant lancement de navigateur
sont vérifiés. Ce delta doit encore passer sa propre CI.

La lecture de production à 11 h 15 montre `enabled=true`,
`availability=access_denied`, avec une suspension expirant le 1er octobre
à 01 h 02 UTC. Dans la maintenance interne autorisée, une mise à jour
conditionnelle de cette seule source met `enabled=false` et conserve son
availability ainsi que sa suspension. Elle ne supprime ni annonces ni tâches
et ne remet aucune tentative à zéro. Les 21 détails source en attente ne
seront plus relancés automatiquement à l'expiration de la suspension.

## Complément de relecture PDF — 30 septembre, 11 h 20 UTC

Une preuve complète mixte (un texte exploitable et un PDF vide terminal)
était courante selon la freshness, mais ne faisait pas tourner le hash des
dépendances épuisées. Le helper est corrigé pour retenir uniquement les
pièces extractables après exclusions validées ; le manifeste entier reste
dans la révision. Deux régressions locales passent, deux scénarios PostgreSQL
attendent la CI ; les suites Supabase et reliability comptent 62 et 28 succès.

La relecture confirme deux autres limites à corriger avant qualification :
le fallback persisté ne restaure pas le cache local et perd ses marqueurs de
provenance lors d'une réouverture du cache ; la sélection de six documents
reprend les mêmes pièces sans progression sur un manifeste de 16 PDF.
Le job PDF peut alors être completed sur ces six pièces alors que la fraîcheur
du manifeste entier reste fausse. La restauration cold strictement complète
et la progression bornée sont en préparation, sans augmentation des plafonds.

## Canari 74dd49f6 — 30 septembre, 11 h 17 UTC

Le [run 36702119440](https://github.com/Aprivi-dev/immojudis/actions/runs/36702119440)
réussit : job GitHub de 10 h 57 min 29 s à 11 h 17 min 36 s, boucle worker
de 1 141,8 secondes sur un budget de 1 200. L'arrêt `finalization_margin`
respecte la marge de 60 secondes. Le plafond reste à 90 tâches ; 31 claims
uniques sont observés, dont 16 détails source et 15 enrichissements généraux.
Le relevé des claims compte 26 completed, quatre failed et un queued, aucun
cancelled, running ou manquant. Aucun lease perdu ou stale n'est observé.
Le plus long lot de deux détails source prend 40,1 secondes ; leur moyenne
est de 11,2 secondes par tâche.

Le diagnostic conserve deux échecs PDF explicites : 21 pages OCR en échec
sur une pièce `pv_huissier`, et la page 22 sur un autre PDF, tous deux avec
`status=incomplete` et `reason=ocr_failed`. Un timeout de `robots.txt` est
observé pour un détail source. La quatrième tâche failed n'a pas encore une
cause distincte établie par le log filtré ; une lecture de son vrai état reste
requise. Aucun signal invalid JSON, quota, cooldown ou deadline LLM n'apparaît.
Onze appels fournisseur et onze écritures de cache LLM répondent HTTP 201.
Les checkpoints documents, textes PDF/Docling et LLM sont sauvegardés,
pour 73 804 035 octets de cache.

Le log ne fournit aucun dossier au manifeste entier de six PDF ou moins
avec textes modernes explicitement complets. Il ne qualifie donc pas encore
l'essai cold complet. Ce canari concerne uniquement `74dd49f6`, sans les
deltas de génération, réchauffement cold, progression et verrou EP en cours.

## Restauration du cache complet — 30 septembre, 11 h 30 UTC

Le mapping de textes persistés strictement validés est récupéré une seule
fois et transmis à l'upsert des documents. Les extractions sont écrites avant
la restauration atomique du cache local, elle-même avant la décision de queue.
Le JSON conserve `_persisted_pdf_proof` et `_persisted_verified_at` lorsqu'ils
existent ; `file_path` reste nul. Le manifeste legacy ou partiel n'est pas
accepté par ce fallback complet. Une erreur d'écriture laisse le cache précédent
intact et ne prétend pas avoir restauré le nouveau cache.

Les trois régressions cold et la suite PDF/Supabase isolée de 164 tests
passent. La reprise de génération compte deux succès locaux et deux scénarios
PostgreSQL en attente de CI. La relecture indépendante de ce delta cold est
en cours ; la progression par lots reste en implémentation.

## CI du verrou de source et précision des diagnostics — 30 septembre, 11 h 39 UTC

Le commit `a73b58e76b9c035f1869a10bb5cd9b987249d974`, poussé à
11 h 31 UTC, passe la [CI](https://github.com/Aprivi-dev/immojudis/actions/runs/36709094637)
et [CodeQL](https://github.com/Aprivi-dev/immojudis/actions/runs/36709094620),
sans relance. Python 3.11 et 3.12 comptent chacune 2 013 succès et 18 tests
ignorés. Le Web conserve 1 336 succès et cinq ignorés ; Playwright compte
87 succès et huit ignorés, aucun échec. Les 200 migrations et 1 481 assertions
de 79 fichiers pgTAP passent sans dérive. Audits, build, catalogue HTTP,
inbound local, budgets et invariants sont verts. La preview
`dpl_AghBZPy5WZjGq2te159aaw7nbF7b` est READY sur ce SHA exact.

Le log historique du canari établit les quatre causes failed : deux erreurs
OCR et deux expirations de vérification robots. Le premier PDF a 21 pages en
échec (`total=21`) à 11 h 00 min 38 s ; le second a une seule page en échec,
la page 22, à 11 h 13 min 05 s. Le premier job est ensuite réécrit par un
worker ultérieur à 11 h 30 min 43 s : son erreur SQL courante ne décrit plus
le canari. La tâche queued finale correspond à une deadline source-detail
avec restitution de la claim et de sa tentative ; le compteur
`deferred_requested=0` ne suit pas ce chemin source-detail.

Le run Licitor précédent réussit en 2 417,8 secondes : 588 annonces collectées,
713 requêtes réussies sur 713, aucune erreur ; discovery, inventaire adressable
et émissions certifiés. La publication compte 553 annonces, aucune en attente
ou en échec. Ce sont des compteurs de périmètres différents, pas 35 pertes
de publication inférées. La dégradation globale reste celle de l'enrichissement.

Le relevé de 11 h 34, avec les mêmes prédicats de file, compte 5 978 tâches
ouvertes, 5 952 dues réessayables, 2 659 anciennes réessayables et 16 épuisées.
Un job est running, aucun stale. La baisse par rapport à 10 h 54 inclut les
effets de la collecte et de workers successifs ; elle ne doit pas être attribuée
au seul canari et ne suffit pas au critère de résorption durable. Petites
Affiches compte 418 des 1 021 annonces futures non vues depuis plus de sept
jours ; cette dette de fraîcheur reste à traiter.

La relecture indépendante du cache complet approuve 65 tests cold/Supabase,
ainsi que le cas mixte texte exploitable + pièce terminale. Les tests PostgreSQL
de génération ne peuvent pas tourner localement : Docker est installé mais
arrêté, aucun PostgreSQL de test n'est actif. Aucun runtime n'est démarré ;
ces scénarios restent requis dans la base jetable de CI du futur commit.

## Relecture de la progression et suivi des délais — 30 septembre, 12 h 24 UTC

Le callback de deadline source-detail est raccordé au suivi du worker. Un test
isolé traverse le vrai worker et le vrai batch source avec une deadline
simulée : la tâche libérée apparaît dans `deferred_requested=1`, reste
`observed_queued=1`, ne compte pas comme terminée et les contextes de suivi
sont réinitialisés. Les suites source-detail passent aussi localement. Aucun
appel HTTP, LLM ou production n'est nécessaire à cette vérification.

La première relecture intégrée de la reprise PDF compte 93 succès et deux
scénarios PostgreSQL ignorés localement. Elle confirme la corrélation de la
génération PDF, le fallback complet strict et la protection des tâches
dépendantes après une erreur générique. Elle conserve deux blocages : la
revalidation HTTP après expiration du TTL doit vérifier réellement les octets,
et une extraction différée sans progrès doit consommer uniquement la tentative
PDF. La progression par le vrai traitement de 16 pièces et ces corrections
restent en cours de validation ; ce delta n'est pas encore publié ni qualifié
par sa propre CI.

## Révisions de queue et fingerprint PDF — 30 septembre, 12 h 42 UTC

La relecture du RPC confirme que les anciennes révisions sont annulées dans
la transaction de claim avant de retourner les tâches au worker. Elles ne
consomment donc pas un slot de traitement ou un appel LLM. Au relevé de
12 h 23 min 50 s, aucune ligne non terminale n'est un doublon selon la vraie
clé de claim `(source_url, job_type, detail_source_name, detail_source_url)`.
Un regroupement limité à `(source_url, job_type)` fusionnerait à tort 55
détails de source distincts. Aucune migration de coalescence n'est ajoutée.

Le hash PDF précédent utilisait la révision commune de facts/display, qui
inclut les empreintes source et les paramètres LLM. Le constructeur PDF
partagé utilise maintenant le manifeste URL/label, les SHA explicites des
documents et profils, `last_successful_check_at`, la version du cache et la
génération du writer. Une variation de `source_checks` ou de prompt LLM ne
renouvelle plus le budget PDF ; un document ou un SHA différent le renouvelle.
Les quatre tests spécifiques passent, ainsi que les tests ciblés de
fiabilité. La relecture et la CI du commit exact restent nécessaires.

Le snapshot distinct de 12 h 27 min 07 s compte 5 934 tâches ouvertes,
5 913 dues réessayables et 5 891 claimables selon les conditions de vente,
rétention, lease et activation de source. Les 2 657 ouvertes de plus de
48 heures incluent les tâches au plafond et les échéances de reprise futures ;
2 652 sont dues réessayables de plus de 48 heures. Ces définitions diffèrent
du compteur ancien sous plafond sans condition d'échéance : elles sont
conservées séparément. Un worker est actif pendant ces observations ; aucune
baisse n'est attribuée à cette correction encore locale.

## Qualification locale intégrée des documents — 30 septembre, 13 h 39 UTC

La suite intégrée des PDF, de la queue, du stockage, des délais source-detail
et de la fiabilité passe avec 315 succès. Les 15 scénarios ignorés nécessitent
la base PostgreSQL jetable : six pour le checkpoint, deux pour la génération,
un pour le worker source-detail et six pour sa réutilisation. Ils restent
obligatoires dans la CI du prochain commit ; aucun test n'utilise ici la base
ou les services de production. Ruff et le contrôle des espaces sont verts.

Le vrai traitement local de 16 fichiers conserve les six premiers textes,
puis six autres, puis les quatre derniers. Le dossier ne devient complet
qu'après le dernier lot. Après expiration HTTP, les URLs effectivement
revérifiées sont suivies séparément : un lot de six ne peut pas rafraîchir
artificiellement les 16 preuves. Un 403, 404 ou refus robots retire le texte
actif et l'extrait périmé ; seule une récupération ultérieure réussie les
réintroduit. Les exclusions temporaires sont revérifiées après leur TTL,
tandis que les liens sociaux restent exclus.

Le checkpoint écrit uniquement l'analyse documentaire et une extraction PDF
moderne, sous garde de révision de la vente et dans une même transaction.
Une connexion dédiée possède des délais bornés et n'active pas le fallback
SQL de création de tâches. Un appel avec le job PDF actuellement claimé
raccorde sa clé au hash sauvegardé, sans remettre son compteur à zéro.
Lorsqu'une génération existe déjà, l'ancien job est annulé sous garde du
lease. La contrainte unique est protégée par lecture verrouillée et savepoint
en cas de course. Aucun job de faits ou de description n'est créé par ce
checkpoint.

La relecture a retiré un marqueur de génération de secours : il pouvait
reconnaître à tort un ancien plafond de quatre essais après un changement
de contenu ou de writer. Le contrôle final exige exclusivement le hash PDF
courant. Une erreur PDF ou un passage sans progrès consomme uniquement le
budget PDF ; les tâches dépendantes restent différées avant tout appel LLM.
Les générations historiques épuisées sont conservées, sans réinitialisation.

Le nouveau module de progression est inclus dans le budget des modules métier
surveillés. `pdf_enrichment.py` respecte les 1 500 lignes selon le comptage du
script de CI ; le seuil n'est pas augmenté. Ces résultats locaux ne qualifient
pas encore un canari de production ni la restauration d'un dossier entier
après une absence de cache GitHub réellement observée.

## Verdict CI et relevé de capacité — 30 septembre, 13 h 55 UTC

Le commit `aca5b06927a926faa99f3240395a5bae3b6a2798` est poussé à
13 h 40 UTC. Sa [CI](https://github.com/Aprivi-dev/immojudis/actions/runs/36723421664)
échoue uniquement dans les deux étapes Python : chacune compte 2 045 succès,
18 ignorés et neuf échecs. Cinq scénarios checkpoint échouent sur l'adaptation
de dictionnaires/listes bruts vers les colonnes JSONB `confidence` et `result`.
Quatre tests de freshness/main utilisent des fixtures PDF legacy désormais
rejetées par le contrat moderne. Les corrections ciblées enveloppent uniquement
ces deux paramètres avec `Jsonb` et modernisent les fixtures avec le vrai
writer ; elles n'assouplissent pas la validation du produit ni les autres
colonnes `confidence` numériques. La vérification du prochain commit reste
requise.

CodeQL, le Web, ses budgets, Playwright, les migrations/pgTAP, les dépendances
et l'invariant de planification passent. La preview
`dpl_FQeZQyfJjVsNCbbcFPSinZM417wZ` est READY sur le SHA exact. Aucun nouveau
canari ni promotion du worker n'est lancé sur la CI en échec.

Le relevé en lecture seule de 13 h 47 reprend les prédicats de 11 h 34 :

| Famille        | Ouvertes | Dues réessayables | Anciennes réessayables >48 h | Épuisées |
| -------------- | -------: | ----------------: | ---------------------------: | -------: |
| Descriptions   |    2 879 |             2 879 |                          598 |        0 |
| Faits          |       98 |                88 |                           23 |        6 |
| PDF            |      374 |               363 |                           30 |        4 |
| Détails source |    2 601 |             2 595 |                        1 998 |        0 |
| Total          |    5 952 |             5 925 |                        2 649 |       10 |

« Ouvertes » comprend queued/failed/running. « Dues réessayables » comprend
queued/failed sous plafond, avec échéance inférieure ou égale au relevé ;
une échéance nulle ou future est exclue. « Anciennes réessayables » comprend
les trois états ouverts sous plafond créés depuis plus de 48 heures,
sans filtre d'échéance. Aucun running ni lease périmé n'est observé. Ce
snapshot ne mesure pas l'effet du candidat, encore non exécuté.

Le run automatique d'enrichissement de 13 h 16 à 13 h 37 réussit techniquement
avec `partial_success` : 41 completed, 13 failed et 21 queued. Cessions État
termine un inventaire complet entre 12 h 46 et 13 h 02. Ces résultats ne
démontrent pas la résorption durable des tâches anciennes.

L'alerte `cron.stale` est justifiée, et non simplement non réconciliée : son
détail courant nomme uniquement `information-agent-inbound`, attendu dans
les dix dernières minutes. Aucun cron ni run opérationnel inbound n'est
installé. Les crons santé et rétention exécutent régulièrement leurs cadences
de 15 et cinq minutes. Il faut publier la route, vérifier le canari canonique,
puis activer le cron et observer sa réussite ; l'alerte ne sera pas fermée
manuellement.

## Garde de source dans les enrichissements — 30 septembre, 14 h 23 UTC

La relecture du RPC courant corrige une hypothèse précédente : l'activation
de source est vérifiée pour les détails source, mais pas pour les tâches
générales PDF/faits/descriptions. Le compteur théorique « claimables » du
relevé de 12 h 27 ne doit donc pas être pris pour une exécution du RPC réel.
Le code Python ajoute une garde Enchères Publiques avant cache, appel IA,
rejeu factuel ou publication d'une tâche générale. Les tâches concernées
restent différées avec un motif explicite et leur tentative est restituée.

La garde partagée examine le nom de source, l'URL principale, les alias et
les URLs de pièces jointes. Elle couvre aussi les PDF liés depuis une autre
source et chaque cible des redirections manuelles, avant résolution réseau.
Les reprises et revalidations de descriptions ignorent explicitement les
ventes non autorisées ; l'entrée centrale d'extraction IA vérifie la même
garde avant de relire un cache. Aucun accès EP n'est lancé pour ces tests.

La qualification cold conserve le parcours de collecte ordinaire sur une
source autorisée : dossier redécouvert, upsert central réellement exécuté,
cache GitHub absent dans le journal et toutes les preuves documentaires
rematérialisées depuis `persisted_pdf_text`. Un simple passage
`enrichment_only`, un hash d'enrichissement déjà connu ou `pdf_targets=0`
ne suffisent pas à certifier ce parcours.

## Vérification complète du correctif — 30 septembre, 14 h 27 UTC

Après correction de l'encodage JSONB et des quatre fixtures, la suite Python
complète isolée passe avec 1 985 succès et 100 ignorés. Les scénarios ignorés
requièrent des bases PostgreSQL jetables ou des caches locaux absents ;
les scénarios pipeline PostgreSQL seront exécutés dans la CI du nouveau
commit. Les gardes de source couvrent aussi l'entrée centrale IA et les
reprises de descriptions. Une redirection découverte pendant le PDF provoque
une restitution de la claim avec son compteur conservé, sans checkpoint
partiel ni appel IA.

Ruff est vert et aucun module métier surveillé ne dépasse 1 500 lignes :
`pdf_enrichment.py` compte 1 499 lignes selon le script. Le helper de garde
est inclus dans ce budget. Aucun service de production, fournisseur IA ou
accès Enchères Publiques n'est utilisé par cette vérification locale.

La dernière relecture a fermé le parcours de collecte principale : seules
les ventes autorisées passent dans les cibles cache/PDF/LLM ; la création du
client IA vient après ce filtre. L'application directe d'un cache IA possède
aussi sa garde booléenne et retourne `False` sans lire ni appliquer le cache
non autorisé. La réserve de relecture est levée. La suite complète finale
compte 1 988 succès et 100 ignorés à 14 h 43 UTC, sans effet de production.

## Connexion dédiée du checkpoint — 30 septembre, 15 h 02 UTC

La [CI `7eb76202`](https://github.com/Aprivi-dev/immojudis/actions/runs/36731520565)
est terminée : Web, Playwright, migrations, invariant de planification et
dependency review réussissent ; CodeQL réussit aussi. Les deux versions
Python comptent chacune 2 069 succès, 18 cas ignorés et un échec dans
`test_dedicated_checkpoint_owns_queue_and_bounds_session`.

La relecture indépendante confirme que ce test remplace une nouvelle
connexion PostgreSQL par une connexion déjà en transaction : le contexte
devient un savepoint, où les réglages `SET LOCAL` restent visibles jusqu'à
la fin de la transaction externe. Le chemin dédié réel ouvre une nouvelle
connexion et configure les limites à l'intérieur de sa transaction. Une
vraie séparation de connexion et une transaction terminée doivent donc être
vérifiées dans une base jetable ; aucune restauration supplémentaire des
réglages de production n'est justifiée par ce seul double de test.

Le test corrigé prépare une base PostgreSQL locale jetable, committe ses
données, puis ouvre le checkpoint sur une connexion distincte. Il exige un
PID différent, un état `IDLE` avant et après l'écriture, la fermeture de la
connexion, les limites vues par le trigger et zéro tâche indirecte. La base
est supprimée à la fin du test. Le code de production reste identique.
Ruff et le scénario local passent ; six cas PostgreSQL sont ignorés
localement et doivent être exécutés par la prochaine CI.

La [preview exacte](https://immojudis-dezt-7cwpv6ty9-antoine-s-projects7.vercel.app)
est READY (`dpl_H5ohfus8cAHiU9Q5dZ6Uv5JieTY7`). Aucun canari, routage
automatique, import IA, envoi à un interlocuteur ou nettoyage de branche n'a
été lancé sur cette CI en échec. Les deux entrées externes restent en attente.

## Qualification et interruption OCR — 30 septembre, 16 h 04 UTC

Le commit `0bff122a6d5de68cf85efbc2dea54360e0be4bd1` passe la
[CI complète](https://github.com/Aprivi-dev/immojudis/actions/runs/36734501508)
et [CodeQL](https://github.com/Aprivi-dev/immojudis/actions/runs/36734501114).
Python 3.11 et 3.12 comptent chacun 2 070 succès et 18 cas ignorés ; le
test de connexion PostgreSQL dédiée s'exécute réellement. Web : 1 336
succès, cinq ignorés et 20 invariants sécurité. Playwright : 87 succès,
huit ignorés. 200 migrations uniques, 79 fichiers pgTAP et 1 481 assertions
passent sans dérive ; budget maximal surveillé à 1 499 lignes sur 1 500.
La preview exacte est READY (`dpl_9T4aveZfC34gcNKzTTPV1i3pVnza`) et ses
GET accueil/catalogue, inbound sans auth et webhook donnent 200/200/401/405.

Le tag `immojudis-workers-0bff122a` et sa future référence cold sont protégés
par le ruleset actif `24255565`, sans bypass, modification ni suppression.
Le [canari](https://github.com/Aprivi-dev/immojudis/actions/runs/36735589361)
tourne de 15 h 23 min 05 s à 15 h 43 min 18 s, SHA exact. Son traitement
dure 1 141,3 secondes sur 1 200 et s'arrête à la marge de finalisation.
Le set des claims et le snapshot SQL final comptent 82 identifiants uniques :
47 completed, zéro failed, deux cancelled et 33 deferred/queued, zéro running
ou missing. Le plus long lot de détail dure 10,6 secondes. Six prédictions
Replicate sont créées en HTTP 201, sans quota/429 ni erreur fournisseur.
Le cache extraction est réellement absent au départ puis sauvegardé.

Cette réussite technique ne qualifie pas la durabilité des OCR interrompus.
Les deux ventes Avoventes `une-maison-2` et `un-studio-mansarde` sont différées
après 75/93 et 30/50 pages. La relecture du code montre une propagation de
l'exception avant consolidation de l'analyse de vente ; la queue diffère
ensuite sans checkpoint SQL. Une revue indépendante des deux URLs, tous
statuts et toutes tailles de manifeste, confirme zéro écriture dans
auction_sales, auction_documents et auction_extractions durant le canari.
Leurs dernières extractions, à 11 h 58, restent legacy. Les pages dans le
cache GitHub ne sont donc pas une preuve de reprise après perte du worker.

Le correctif doit conserver les documents complets déjà traités et les
pages partielles vérifiées avant déférence, puis restaurer le vrai cache de
pages sous garde SHA, sans déclarer le dossier complet. Dans le périmètre
post-canari de 311 ventes upcoming hors EP à un à six documents, aucune
preuve moderne entière n'est encore éligible. Aucun essai warm ou cold
n'est lancé avant correction et nouvelle qualification exacte.

Le run EImmo historique `36723925938` est un échec de transport : timeout
robots puis catalogue, quatre tentatives et zéro réponse réussie, sans refus
d'accès ni indice de défaut du parseur. Couverture incomplète, publication
et nettoyage correctement bloqués. Le rétablissement doit être constaté
lors d'une prochaine collecte normale.
Ces corrections seront vérifiées dans la CI du nouveau commit exact avant
tout essai de worker.

## File et couverture — 30 septembre, 16 h 31 min 54 s UTC

Le contrôle en lecture seule compte 5 975 jobs ouverts, 5 957 dus
réessayables, 2 654 de plus de 48 heures encore sous le plafond et 12
épuisés. Aucun job running ni lease stale. Les familles ouvertes sont
2 901 descriptions, 97 faits, 374 PDF et 2 603 détails de source.
Le critère d'ancienneté porte sur les jobs ouverts sous le plafond, sans
filtre d'échéance ; le critère « dû » exige queued/failed et une échéance
atteinte. La résorption durable n'est toujours pas démontrée.

La valorisation compte 2 844 lignes : aucun job ouvert, 2 452 ready et
392 insufficient_data terminaux. Quatre alertes restent ouvertes :
cron.stale (critical), pipeline.enrichment.stalled (warning),
pipeline.import.unhealthy (warning) et
pipeline.source.encheres_immobilieres.missed (critical).

Sur le dernier run propre à chacune des neuf sources autorisées, hors
maintenance et run all : six couvertures complètes (Avoventes, Cessions
État, Info Enchères, Licitor, Petites Affiches, Vench), deux non complètes
(AGRASC, Enchères Immobilières), une couverture Notaires inconnue ou en
échec à diagnostiquer. L'audit API Notaires précédent de 832 URL ne
prouve pas l'état de ce run ni sa persistance en base.

L'observation antérieure de deux UUID individuels prétendument issus du
canari est retirée : ils ne figurent pas dans son log exact. Le snapshot
SQL final du worker conserve 82 claims, zéro missing ; aucune anomalie
de rétention n'est déduite de cette attribution erronée.

### Diagnostic Notaires — 30 septembre, 16 h 48 UTC

Le run `3e39d3c1-5b99-479e-b948-0f51513756c7`, de 15 h 44 min 24 s à
16 h 19 min 24 s, est failed/interrupted après le budget de 2 100 secondes.
Le [workflow exact](https://github.com/Aprivi-dev/immojudis/actions/runs/36737207143)
utilise `f695a739ab6e60079cf5c95fb432cb7ef6900ba1`, le worker automatique
actuel. La stack s'arrête dans la persistance source_checkpoint ; les logs
PostgreSQL montrent dix indisponibilités de connexion 57P03, deux timeouts
SELECT 57014 et un reset 08006 entre 16 h 05 et 16 h 07.
Aucun défaut de parseur ni de transport public Notaires n'est démontré.
Les timeouts SELECT et le reset sont attribués à PostgREST, pas au worker.
La stack seule ne distingue pas l'attente SQL de l'attente socket pendant
l'indisponibilité. La session serveur actuelle limite les statements à
deux minutes, mais les checkpoints source n'imposent pas leur propre limite
de verrou ni de statement ; ce bornage local reste à corriger et vérifier.

680 checkpoints ont un détail complet. Le suivi des items compte 203
published, 470 expired, deux quarantined et cinq discovered/pending.
Les quarantaines possèdent des motifs d'identité ambigüe et de conflit
entre prix fixe et périmètre des enchères. Le certificat final de couverture
et les compteurs de requêtes manquent ; ce run reste incomplet.

L'alerte pipeline.import.unhealthy est réouverte/actualisée, pas créée ce
jour : première occurrence le 19 août, dernier constat à 16 h 30 avec un
échec dans l'heure, zéro stuck_running et zéro queued. Le health check
réussit et signale correctement l'échec. Une collecte Notaires normale,
épinglée à la version qualifiée après stabilité DB, reste requise.

## Correctif de durabilité OCR — 30 septembre, 16 h 49 UTC

La consolidation d'une interruption conserve maintenant le préfixe de
documents complets et les pages déjà réussies, sous manifeste explicitement
incomplet. Les preuves en mémoire sont transmises directement au writer SQL
avant déférence ; l'écriture du cache local n'est pas une précondition.
Une erreur de statut ne permet pas de repli vers un ancien cache local.
Un checkpoint non durable consomme seulement l'essai PDF, tandis que ses
dépendances facts/display sont différées.

La relecture impose les bornes et l'unicité des pages, leur statut, leurs
longueurs, le complément exact des pages échouées, et le lien entre le texte
agrégé et les pages pour l'extraction pymupdf_pages. Le texte Docling peut
être plus riche que les pages, avec sa propre preuve de texte et la même
garde de couverture. Les diagnostics retryable restent stockés ; seules
les pages réussies sont réutilisées sous SHA exact du PDF téléchargé.
Un cache local legacy ou malformé ne bloque plus la récupération SQL.
Aucune preuve legacy n'est transformée en preuve moderne.

La suite Python isolée complète passe : 1 993 succès, 101 cas ignorés
localement, dont les scénarios PostgreSQL, sept warnings. Ruff et git diff --check
passent. Les modules surveillés pdf_enrichment et queued_runner restent
à 1 499 lignes ; pdf_progress compte 810 lignes. La fixture de diagnostic
PDF fournit désormais les paramètres OCR requis. Le test PostgreSQL de
perte de cache écrit et supprime explicitement le cache avant restauration.
Ces tests PostgreSQL et la qualification du worker sur le nouveau commit
restent requis ; aucune écriture en production ni publication finale n'est
effectuée avec ce correctif non encore qualifié en CI.

### Bornage des checkpoints source — 30 septembre, 17 h 01 UTC

Les trois chemins de source_checkpoint (lecture, curseur, détail) imposent
désormais connect_timeout=5 sans retries de connexion, puis lock_timeout=5s
et statement_timeout=15s dans leur transaction. Les exceptions de persistance
restent visibles et empêchent la réussite du checkpoint. Le helper global
de connexion et ses politiques existantes ne sont pas modifiés.
Le réseau après établissement de la connexion reste soumis aux réglages
libpq/serveur existants : ce correctif ne prouve pas le rétablissement DB.

Un test PostgreSQL sur base locale jetable verrouille un vrai curseur depuis
une seconde connexion. Il exige les limites 5s/15s via trigger,
LockNotAvailable sur l'UPSERT et la conservation des checkpoints antérieurs,
sans curseur complet déclaré. Son exécution réelle est requise en CI.
La suite locale complète de l'ensemble du correctif passe avec 1 996
succès, 102 cas ignorés, dont les scénarios PostgreSQL, et sept warnings.

## Qualification a7b9d2cc et correctifs de fixtures — 30 septembre, 17 h 24 UTC

La [CI exacte](https://github.com/Aprivi-dev/immojudis/actions/runs/36748708765)
de `a7b9d2cc3c666f195c5f3cd1b1bd05af350b8dee` échoue. Chaque version Python
compte 2 077 succès, 18 ignorés et trois échecs. Les deux doubles de connexion
des tests de reprise source n'acceptent pas connect_timeout/retry_delays ;
ils sont corrigés pour accepter ces paramètres. Le test de restauration PDF
patchait PDF_DOCUMENT_TEXTS_DIR dans pdf_fact_extraction, qui ne possède pas
ce symbole : le patch cible désormais pdf_enrichment, propriétaire du cache.
Aucune modification du code de production n'est nécessaire pour ces échecs.
Le test PostgreSQL du vrai verrouillage de curseur a été exécuté et réussi
en 3.11/3.12, avec le timeout de verrou attendu.

Le [CodeQL exact](https://github.com/Aprivi-dev/immojudis/actions/runs/36748708759)
passe. Playwright compte 87 succès et huit ignorés. Les 79 fichiers pgTAP et
1 481 assertions passent sans dérive, ainsi que l'invariant de planification
et la revue des dépendances. Le job Web s'arrête à l'audit npm, avant typecheck,
lint, unités et build : Next.js 16.3.4 est concerné par
[GHSA-vcvr-r3jv-pc5j](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j).
L'avis primaire annonce une correction à partir de 16.3.6. Le verrou est
mis à jour vers la version stable signée
[16.3.8](https://github.com/vercel/next.js/releases/tag/v16.3.8), compatible
avec Node 24 et React 19.2.8. La seule route ImageResponse du dépôt utilise
du contenu statique ; aucune entrée contrôlée par un attaquant n'y est
observée. Cela ne remplace pas la correction de dépendance ni la CI.

Avec npm 11.18, l'audit du nouveau verrou, production seulement, retourne
zéro vulnérabilité à tous les niveaux. Les dépendances locales partagées
ne sont pas modifiées. Les scénarios ciblés passent localement : huit
succès et 17 ignorés faute de PostgreSQL ; Ruff et diff passent.
Une nouvelle CI exacte doit exécuter les trois fixtures corrigées et le
build avec les nouvelles dépendances. Aucun nouveau canari n'est lancé.

La preview exacte a7b9d2cc est READY (`dpl_6cygAsVQnurmWogsTV9TLCuVr2ZG`).
Les vrais GET authentifiés accueil/catalogue et les GET sans auth inbound
et webhook donnent 200/200/401/405 avec noindex. L'origine canonique inbound
reste 404 ; aucun POST, upload, import IA ou envoi à un contact réel.

### État production au 30 septembre, 17 h 14 UTC

5 993 jobs ouverts, 5 967 dus réessayables, 2 649 anciens sous le plafond,
19 épuisés, aucun running/stale. Depuis 16 h 31 : ouverts +18, dus +10,
anciens -5, épuisés +7 ; détails source +27. La valorisation reste sans job
ouvert. Les mêmes quatre alertes restent ouvertes à 17 h 15. Six sources
ont une dernière couverture complète ; AGRASC, EImmo et Notaires restent
incomplètes. Notaires possède désormais une couverture explicitement fausse.

111 statuts quarantined et 99 marqueurs publication_quarantine. Aucun job
review_required ouvert : 70 détails source et 11 faits sont terminaux.
Les vues app/discovery/preview exposent zéro vente quarantainée ou
conflictuelle ; les statuts de vérification pending restent explicitement
transmis. Les RPC publics délèguent aux filtres privés de quarantaine.
Les tables de revue IA et information_agent restent vides et privées.
Les claims de faits conservés sont candidate, non publiables. Aucun import
ni contournement public de quarantaine n'est constaté. Les deux entrées
externes et les critères de capacité/couverture restent en attente.

## Qualification b95ea5a9 — 30 septembre, 17 h 47 UTC

La [CI exacte](https://github.com/Aprivi-dev/immojudis/actions/runs/36751602755)
et le [CodeQL exact](https://github.com/Aprivi-dev/immojudis/actions/runs/36751602506)
sont verts sur `b95ea5a98afbffc0c83437c2d9d4f49f686e5382`.
Python 3.11 et 3.12 comptent chacune 2 080 succès, 18 ignorés et un warning.
Les scénarios PostgreSQL de reprise source, restauration documentaire et
verrou réel sont effectivement exécutés, sans skip. Le timeout de verrou
attendu et le checkpoint OCR sont observés dans les logs des deux versions.
Ruff et pip-audit passent, sans vulnérabilité connue.

Le Web passe audit production (zéro vulnérabilité), typecheck, lint,
224 fichiers Vitest et 1 336 tests réussis (cinq ignorés), invariants et
build Next.js 16.3.8 : 103/103 pages et budgets verts. PostgreSQL : 79 fichiers
pgTAP, 1 481 assertions, deux tests d'intégration et aucune dérive.
Playwright compte 87 succès et huit ignorés. Les journaux privés de ce SHA
sont conservés sous immojudis-ci-36751602755 et immojudis-codeql-36751602506.
Les dépendances locales partagées restent inchangées ; la qualification
Next.js provient du build CI installé depuis le nouveau verrou.

La [preview exacte b95ea5a9](https://immojudis-dezt-hsxl25k3n-antoine-s-projects7.vercel.app)
est READY (`dpl_B1dKucfSL7sWy8etRGtZykpKsCuS`). Les GET sur les routes
vérifiées `/`, `/sales`, `/api/cron/information-agent-inbound` et
`/api/webhooks/resend/information-agent` donnent 200/200/401/405, avec noindex.
Aucun POST, import, upload ou envoi à un interlocuteur n'est effectué.

### Checkpoint après page blanche — 30 septembre, 17 h 47 UTC

La relecture suivante identifie un cas distinct : un checkpoint moderne
interrompu après une page objectivement blanche possède un texte et un hash
vides, avec zéro caractère. clean_text transformait son hash vide en None,
ce qui rejetait sa persistance et sa restauration malgré ses preuves de pages.
Le hash vide est désormais conservé seulement après validation du payload
moderne et de ses pages, et rapproché du manifeste text_present=false,
text_chars=0. Les preuves legacy, les incohérences de texte et de couverture
et les marqueurs contradictoires restent rejetés.

Le cache agrégé conserve désormais text_sha256 seulement lorsqu'il existe
explicitement dans le payload du writer. La garde de checkpoint ne dérive
plus un hash de remplacement : texte non vide avec hash absent/vide et
texte vide avec hash absent/erroné sont rejetés. Le manifeste vide exige
aussi un marqueur text_sha256="" explicite. Les tests négatifs exercent
writer et reader, y compris un manifeste et sa preuve altérés ensemble.
Le prédicat général de progression et les payloads legacy restent inchangés.

Un PDF PyMuPDF réel de deux pages déclenche la deadline après sa première
page blanche et avant l'OCR de la seconde. Il exige le SHA réel du fichier,
blank_excluded/0 caractères, failed_pages=[2], manifeste incomplet et aucun
last_successful_check_at. Après perte du cache de pages et restauration
de la preuve moderne, aucun OCR ne vise la page blanche et le dossier reste
incomplet. Un roundtrip de validation du writer/reader et une variante du
test PostgreSQL vérifient également texte/hash vides et zéro conservés dans
JSONB après suppression des caches ; cette nouvelle variante PG reste à
exécuter sur le prochain commit exact en CI.

Suite Python locale isolée complète : 1 998 succès, 103 ignorés, sept warnings.
Ruff et diff passent. Budgets inchangés : pdf_enrichment/queued_runner
1 499 lignes, pdf_progress 810. Le worker automatique et l'application
de production restent inchangés. Canari puis récupération du manifeste
entier après perte réelle du cache restent requis après CI/CodeQL du delta.

## Canari ca57cf18 et traçabilité — 30 septembre, 18 h 58 UTC

ca57cf188250fed1ffaf6ca6fff12fa0f81d6971 passe la
[CI exacte](https://github.com/Aprivi-dev/immojudis/actions/runs/36755186510)
et le [CodeQL exact](https://github.com/Aprivi-dev/immojudis/actions/runs/36755186662).
Python 3.11/3.12 : 2 083 succès, 18 ignorés chacune ; les deux variantes
PostgreSQL text-prefix/blank-page-prefix sont exécutées. Web : audit
production zéro vulnérabilité, typecheck/lint/invariants, 1 336 tests,
build Next.js 16.3.8 et 103/103 pages. 79 fichiers pgTAP, 1 481 assertions,
aucune dérive ; Playwright 87 succès, huit ignorés. CodeQL passe sans alerte.

Le tag immojudis-workers-ca57cf18 pointe sur ce SHA. Son ruleset actif
24264606 protège cette référence et la future référence cold, sans bypass,
update ni deletion. Le [canari queue](https://github.com/Aprivi-dev/immojudis/actions/runs/36757794906)
est créé à 18 h 19 min 50 s ; job de 18 h 23 min 32 s à 18 h 37 min 52 s.
Commande effective : python -m src.queued_runner --enrichment-only,
sans limite de listing, run_id, publication_check, backfill ou benchmark.
Le cache d'extraction est réellement absent, puis sauvegardé. Le worker
traite 90 jobs en 808,6 s sur 1 200, arrêt max_jobs : 45 source_detail et
45 enrichment. Compteurs de sa finalisation SQL : 68 completed, zéro failed,
trois cancelled, 19 queued/deferred, zéro running/missing. Les 19 reports
signalent un manifeste PDF encore partiel. Aucun OCR ou checkpoint SQL
moderne n'est prouvé par ce log ; le sous-type des 45 jobs enrichment
n'est pas visible et ne peut pas être déduit. La santé globale reste dégradée.

Le log n'identifie que 13 UUID source_detail et ne dispose d'aucun artefact
GitHub contenant les 90 IDs. Les 13 sont retrouvés SQL à 18 h 55–18 h 57 :
completed, attempt_count=0/max_attempts=4, déverrouillés, hash source_detail_v1.
Cette relecture ne prouve pas les 77 UUID absents. Les 19 URLs différées
existent et sont upcoming : zéro progress_schema_version=1 et zéro
manifest_complete=true. Leurs analyses legacy listent 85 documents et
annoncent 72 extraits ; les 85 lignes documentaires durables n'en comptent
que 47 téléchargées/extraites/hashées. Ces états ne sont pas des checkpoints
modernes. Aucun texte documentaire ni contact n'est lu ou émis.

La liste des IDs de claims est donc ajoutée au bilan du worker, une seule
fois avant son snapshot agrégé. Elle contient au plus 90 UUID opaques,
sans URL, texte, contact, token ou payload ; aucun appel SQL/fournisseur ni
comportement de retry/lease n'est ajouté. Relecture indépendante claire,
60 tests worker existants réussis, Ruff et diff verts. queued_runner compte
maintenant exactement 1 500 lignes ; seuil conservé. La CI du nouveau
commit exact reste requise avant son utilisation.

À 18 h 12, la file comparable compte 5 978 ouverts, 5 947 dus réessayables,
2 643 anciens sous plafond, 20 épuisés, un running et zéro stale. Cinq alertes
ouvertes sont relevées à 18 h 09. Aucun candidat moderne entier à un à six
documents n'est disponible sous les gardes publiques au snapshot 18 h 57.
Avoventes est enabled/available, sans suspension ni échec consécutif à
18 h 50 min 57 s ; le contrôle global et les détails source sont activés à
18 h 53 min 55 s. Une collecte warm ordinaire bornée sur version qualifiée
doit produire un candidat naturel avant l'essai cold de collecte entière.

L'audit du vieux runtime et du SQL live à 18 h 40 confirme les gardes
enabled/suspension pour source_detail, y compris le wrapper général.
Enchères Publiques reste disabled/access_denied, même après expiration de
sa suspension. Aucun run queued/running EP/all et aucun job PDF/fact EP
ou document hôte EP n'est dû. Les 21 détails EP conservés sont bloqués par
leur état de source ; un ancien display_description dû ne nécessite aucun
fetch. La famille enrichment ne filtre pas globalement l'état de source :
les gardes du nouveau runtime restent requises. Aucune nouvelle maintenance
EP n'est justifiée par cet état, et aucun fetch EP n'est exécuté.

Le worker automatique reste f695a739. Aucun import IA, activation inbound,
publication finale ou nettoyage de branches. Accord précis pour le secret
portail Production et autorisation écrite/accès au flux EP toujours absents.


## Qualification warm/cold et reprise partielle source — 30 septembre, 21 h 40 UTC

Le SHA `3400eb58287231652f11ad63eb6b528ee4dc462f` est qualifié par la
CI `36762983486` et CodeQL `36762983466`. Le ruleset actif `24267491`
interdit update/deletion sans bypass des tags `immojudis-workers-3400eb58`
et `immojudis-workers-3400eb58-cold`, sur ce même SHA.

Warm `36765217849` terminé success à 20 h 12 min 37 s ; cold
`36773533261` terminé success à 21 h 19 min 50 s. Collectes Avoventes
ordinaires sans run_id ni limite, automatic/enrichment_only/publication_check/
backfill/benchmark false. Chacun : 240 annonces, 241/241 requêtes réussies,
zéro refus/échec de transport. Les logs montrent littéralement les caches
extraction et Justice absents ; le hit Python setup est séparé. Collecte et
publication complètes ; enrichissement partiel et backlog global dégradé.
Les volumes d’upserts loggés sont des opérations, pas des lignes uniques.

Audit SQL cold à 21 h 11 min 26,856876 s : les trois documents du candidat
`979d6876-1d9a-4c93-8e11-e5d4ce504776` sont mis à jour après le start SQL
cold à 20 h 34 min 47,758 s, verified/extracted, file_path NULL,
provenance persisted_pdf_text. Pages 1/21/57, mêmes hashes et longueurs,
aucune page échouée, même linkage moderne progress/profiles/proof/manifeste,
verified_at warm exactement conservé à 19 h 53 min 32,989891 s.
L’extraction peut garder son timestamp warm ; la restauration est ensuite
matérialisée sur les documents. Le log GHA ne contient pas l’ID ou URL du
candidat : le rattachement individuel provient de SQL. Six candidats
modernes entiers existaient après warm, parmi 157 ventes upcoming Avoventes
hors quarantaine avec un à six documents.

Checkpoint moderne SQL réel de `667664a7-8900-4d15-9abf-49049044ac53` :
75/95 pages, 20 restantes, verified_at 20 h 00 min 36,046918 s. Le cold
normal atteint à nouveau 75/95 : il recharge les manifests entiers avant
publication mais n’utilise pas le lecteur partiel avant OCR. Le correctif
présent soumet un wrapper dans le pool PDF après sélection/limitation et
garde de source. Il appelle le lecteur strict existant uniquement pour une
cible avec upsert, progress_schema_version=1 et manifest_complete=false.
Documents modifiés, legacy ou hash incompatible restent non réutilisables ;
aucun manifeste partiel n’est promu complet et le fallback public entier
reste inchangé. Lecture REST 15 s, connexion 5 s, sans retry ; aucune lease
ou relecture forcée de vente n’est ajoutée. Une course avec un worker de
queue reste possible, les fingerprints/hashes empêchant l’adoption d’un
checkpoint incompatible.

65 tests locaux ciblés passent, Ruff et diff verts. Dix PG sont ignorés
localement faute de base jetable. La CI réelle doit exécuter la perte du
cache avec préfixe texte/page blanche par les deux entrées, stockage et
collecte ordinaire. Le test PG utilise une connexion SQL pour prouver le
roundtrip ; le test REST séparé vérifie timeout 15 s/connexion 5 s, une seule
lecture et poursuite OCR après ReadTimeout. Ordre publication légère →
restauration → OCR, mode hors ligne, legacy, manifeste entier et refus EP
avant cache également testés. Les preuves `3400eb58` ne qualifient pas à
elles seules ce nouveau correctif ; CI exacte et reprise réelle requises.

Les deux passes IA fraîches couvrent 76 captures/douze champs et conservent
152 hashes de prompt. v4.3 : 839 accords/912 champs, 73 désaccords,
342 citations rejetées (A 304, B 38), principalement non visibles. Ceci ne
mesure pas l’exactitude réelle. Deux corrections indépendantes relisent
leurs propres captures sans autres revues/prédictions. B v3.1.1 validée :
590/590 citations strictes, 38 cibles dont 33 visibles et cinq structurées
liées, 52 copies non ciblées exactes. Bornes de lecture sémantique
indisponibles ; l’assemblage de 0,216 s n’est pas une durée de relecture.
A corrigée complète est en validation indépendante. Les originaux restent
immuables, anciens arbitrages retirés, nouvelle troisième passe seulement
sur les désaccords actuels. Aucun import.

Relevé à 21 h 05 min 43 s : 6 237 ouverts, 6 211 dus réessayables,
2 627 anciens sous plafond, 18 épuisés, zéro running/stale. Stock +297
depuis 19 h 21, sans résorption durable. Alertes actualisées à 21 h 00 :
inbound, EImmo, Notaires et enrichissement stalled. Gardes publiques relues
à 19 h 31–19 h 32 : zéro vente quarantined/marquée ou conflictuelle sur
app/discovery/preview, statut de revue explicite, tables IA/inbound privées
et vides. Aucune clôture manuelle. Secret portail Production toujours
bloqué par l’accord précis manquant ; autorisation/flux EP non reçus ;
routage automatique inchangé ; aucune publication finale, suppression de
branches ou sollicitation réelle.

## Reprise source e3deadf6 prouvée et audit IA v4.6 figé

La [CI 36781214866](https://github.com/Aprivi-dev/immojudis/actions/runs/36781214866)
et [CodeQL 36781214874](https://github.com/Aprivi-dev/immojudis/actions/runs/36781214874)
réussissent sur `e3deadf631be43f86782a32447f3bf92ddd25759` : Python 3.11 et
3.12 chacune 2 091 succès/18 ignorés, vraie base PG disponible pour les
quatre variantes stockage/source et préfixe texte/page blanche. 200
migrations sans dérive, 79 fichiers pgTAP/1 481 assertions, deux intégrations,
Web 1 336 succès, Playwright 87 succès et Next.js 16.3.8 qualifiés. CodeQL
termine ses uploads, sans nouvelle alerte dans le code modifié.

Le [warm 36782339688](https://github.com/Aprivi-dev/immojudis/actions/runs/36782339688)
ordinaire est terminé avec succès à 22 h 21 min 51 s UTC. Le tag protégé
`immojudis-workers-e3deadf6` et sa future référence cold étaient protégés
avant création par le ruleset actif `24274881`, sans bypass, update ni
deletion. Inputs : Avoventes, sans run_id/limite, automatic/enrichment_only/
publication_check/backfill/benchmark false. Run SQL confirmé dans le log :
`7d007242-1aef-49d1-b9f2-59fe5271cba5`. 240 annonces, 241/241 requêtes,
zéro échec de transport, collecte/publication complètes, enrichissement
partiel. Les deux étapes extraction et Justice disent littéralement
« Cache not found for input keys » à 21 h 54 min 15 s ; la sauvegarde finale
ne constitue pas un hit de restauration.

Le log montre la restauration du préfixe de 75 pages à 22 h 07 min 22 s.
La preuve de terminaison individuelle vient du relevé SQL à
22 h 23 min 44,673419 s, et non d'un compteur agrégé du log. Le candidat
`667664a7-8900-4d15-9abf-49049044ac53` porte maintenant un manifeste
moderne complet : quatre documents téléchargés/extraits, zéro failed ou
pending. Le fichier de 95 pages garde son SHA, passe de 75 à 95 pages
extraites et de 17 130 à 18 955 caractères, avec nouveau SHA de texte et
failed_pages vide. Cache proof v1 complète vérifiée à
22 h 08 min 42,654021 s, linkage des quatre profils/manifeste/progress/
extractions cohérent. Les trois PDF du candidat `979d6876-1d9a-4c93-8e11-e5d4ce504776`
restent strictement réutilisables (1/21/57 pages, mêmes hashes) ; leur
verified_at historique à 19 h 53 min 32,989891 s n'est pas une nouvelle
vérification warm. Aucun texte ou contact n'est conservé dans ces relevés.

Le [cold 36785646849](https://github.com/Aprivi-dev/immojudis/actions/runs/36785646849)
est déclenché une seule fois à 22 h 27 min 11 s sur le tag protégé
`immojudis-workers-e3deadf6-cold`, même SHA exact et mêmes inputs ordinaires.
Sa baseline privée contient les deux candidats complets ci-dessus. Cache
réellement absent, restauration SQL et terminaison restent à vérifier.
Ni le pointeur automatique de source ni la santé ne sont réécrits :
scheduler_owned=false pour les runs manuels ; les timestamps durables
restent ceux du dernier run scheduler-owned, selon la garde d'ownership.
Les 240 items de chaque précédent run se répartissent en 192 published,
26 expired par rétention et 22 quarantined (17 conflits d'identité,
cinq identités persistées ambiguës). Deux ventes amiables sont hors
périmètre et sept items published sont des aliases canoniques. Aucune
complétude globale de base n'est déduite du seul certificat public.

L'artefact IA final privé v4.6 est figé, SHA-256
`2f35c35b50abc9709178ae935bad4d140724c37d94c165fd11188236dc6c1af4`.
Les deux passes corrigées indépendamment ont 1 181/1 181 citations strictes
et 152 hashes de prompt conservés. Les 76 désaccords actuels sur 47 cas
ont une nouvelle troisième lecture aveugle : 24 present, cinq unknown et
47 unresolved, zéro preuve invalide et zéro arbitrage en attente. Onze
champs de cinq captures AGRASC ont ensuite été relus avec le seul booléen
d'acceptation du modèle structuré lié ; ils restent unresolved faute de
valeur vérifiable. Les 65 autres labels d'arbitrage sont hérités exactement,
avec leurs hashes de parent et de prompt, et les onze relectures conservent
leur provenance distincte. Les originaux v4.2 à v4.5 restent immuables.
Provider/modèle et durée sémantique non exposés sont déclarés indisponibles.

Le dry-run hors ligne conserve 100 statuts de cas et 912 projections :
57 identités exactes, 19 sans vente correspondante, 24 sans capture,
346 champs passant la garde locale et 566 bloqués. Une capture dont
l'endpoint diffère de l'URL source conserve son blocage de provenance.
L'arbitre ne remplace pas le consensus de deux passes dans une projection
publiable. Aucune exactitude statistique réelle n'est estimée ; aucune
valeur incertaine n'est promue et aucun import n'a été exécuté. L'allowlist
exacte de cet artefact, ses tests puis sa migration doivent être qualifiés.

Le correctif local ajoute uniquement son SHA final aux allowlists Python et
SQL, avec compatibilité explicite v4 original/v4.2. La migration
`20261001000000_ai_review_manifest_v46_allowlist.sql` reprend exactement le
corps de la fonction existante, sauf ce digest et son commentaire. Les
artefacts intermédiaires v4.3/v4.4/v4.5, les hashes arbitraires et NULL ainsi
qu'un schéma erroné restent refusés. 77 tests Python import/projection/revue
isolés passent, Ruff et diff sont verts ; 201 versions uniques vérifiées.
Sept nouvelles assertions pgTAP nécessitent la CI réelle. Le CLI a relu le
fichier avec son SHA final et confirmé le dry-run ci-dessus ; export privé
sanitisé de 11 lots/912 projections, SHA
`4c5fedf893ddb877217a774fa6c3d8cd19b4c291451370c282cccaa74ef17a7f`.
Ni cet export ni son allowlist locale ne constituent un import en production.

Les gardes publiques sont relues individuellement à 22 h 33–22 h 34 UTC,
en lecture seule, statement timeout 5 s/lock 1 s : app/discovery 3 003 lignes
chacune, preview 3 259. Zéro statut quarantined ou marqueur de quarantaine
dans chacune, zéro vente jointe manquante. Tables IA et leurs projections
vides. RLS, ACL, wrappers et helper de visibilité live conservent les gardes
publiques ; aucune donnée documentaire/contact/URL n'est retournée. La
requête d'audit combinant auparavant les trois vues a atteint sa borne de
cinq secondes ; elle n'a pas été rejouée, les lectures séparées passent.
Ce timeout d'une agrégation d'audit n'est pas une preuve d'incident de fiche.

À 22 h 24 min 17,771406 s, la file compte 6 044 ouverts, 6 024 dus
réessayables, 2 619 anciens sous plafond, 13 épuisés, zéro running/stale.
La baisse de 193 ouverts depuis 21 h 05 inclut les activités régulières
et la rétention ; elle ne démontre pas une résorption durable. Quatre
alertes restent ouvertes à 22 h 15 : inbound, EImmo, Notaires et
enrichissement stalled. Les 26 valorisations pending observées à
22 h 24 sont traitées à 22 h 28 : 2 451 ready/378 insufficient_data,
zéro ouvert, cron de cinq minutes actif. Secret portail Production et
accord/flux EP restent manquants. Aucune publication finale, promotion
du worker automatique, suppression de branche ou sollicitation réelle.
