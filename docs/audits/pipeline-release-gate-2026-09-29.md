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
