# Registre simplifié des traitements RGPD

Propriétaire du registre : responsable de traitement indiqué dans les mentions légales. Revue
minimale : annuelle et avant toute nouvelle finalité, catégorie sensible, fournisseur ou transfert.

| Traitement                                                             | Personnes / données                                                                                                                                                 | Finalité                                                                                                              | Base                                                                                              | Destinataires                                                       | Conservation active / archive                                                               | Transfert                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Compte et authentification                                             | Utilisateurs ; email, identité de compte, rôles, sessions                                                                                                           | Créer et sécuriser le compte                                                                                          | Contrat, intérêt légitime                                                                         | Immojudis, Supabase                                                 | Vie du compte ; traces strictement nécessaires selon obligation                             | Selon région et garanties Supabase                        |
| Recherche et personnalisation                                          | Utilisateurs ; favoris, alertes, zones, préférences                                                                                                                 | Fournir les fonctions demandées                                                                                       | Contrat                                                                                           | Immojudis, Supabase                                                 | Vie du compte ; suppression à l’effacement                                                  | Selon garanties Supabase                                  |
| Analyse de dossiers                                                    | Clients ; rapports, notes, simulations, exports, espaces                                                                                                            | Fournir Analyse et collaboration                                                                                      | Contrat                                                                                           | Immojudis, Supabase, collaborateurs invités                         | Vie du compte ; événements d’usage 24 mois                                                  | Selon garanties Supabase                                  |
| Paiement Analyse                                                       | Clients ; référence Stripe, montant, état, preuve d’acceptation                                                                                                     | Encaisser, activer, rembourser, prouver le contrat                                                                    | Contrat, obligation légale                                                                        | Immojudis, Stripe, Supabase                                         | Accès actif ; preuve/archives jusqu’à 10 ans                                                | Garanties Stripe/Supabase à vérifier                      |
| Alertes email                                                          | Utilisateurs consentants ; préférence, consentement, événements                                                                                                     | Envoyer les alertes demandées                                                                                         | Consentement, contrat pour le transactionnel                                                      | Immojudis, Resend                                                   | Jusqu’au retrait ; clôturées 6 mois                                                         | Garanties Resend à vérifier                               |
| Mise en relation avocat                                                | Demandeurs ; coordonnées, message, dossier                                                                                                                          | Transmettre une demande volontaire                                                                                    | Mesures précontractuelles, contrat                                                                | Immojudis, avocat sélectionné                                       | Temps du suivi puis délai de preuve                                                         | Selon destinataire                                        |
| Publication professionnelle                                            | Professionnels ; identité, pièces, demande                                                                                                                          | Examiner et publier une annonce                                                                                       | Mesures précontractuelles, contrat                                                                | Immojudis, Supabase                                                 | Temps du traitement puis délai de preuve                                                    | Selon garanties Supabase                                  |
| Enrichissement Outcome par sources ouvertes — préparatoire, non activé | Personnes citées dans des décisions pseudonymisées ; données de mutation/adresse DVF ; professionnels et structures judiciaires ; identifiants techniques de source | Constituer des candidats de preuve, rapprocher audiences et résultats, puis améliorer le modèle seulement après revue | **À valider et documenter avant activation** ; test de mise en balance si intérêt légitime retenu | Immojudis et Supabase côté serveur ; aucun accès navigateur au brut | **À fixer avant activation** ; corrections, occultations et suppressions amont prioritaires | Région et garanties Supabase à confirmer avant activation |
| Mesure et performance                                                  | Visiteurs/utilisateurs ; pages, performances, identifiants techniques                                                                                               | Exploiter et améliorer le service                                                                                     | Intérêt légitime                                                                                  | Immojudis, Vercel                                                   | Selon configuration fournisseur ; événements internes 24 mois                               | Cadre UE–États-Unis/SCC selon service                     |
| Support et droits                                                      | Utilisateurs ; email, demande, décision, dates                                                                                                                      | Répondre aux droits et réclamations                                                                                   | Obligation légale, défense des droits                                                             | Immojudis, prestataires strictement nécessaires                     | Demande ouverte puis 5 ans après clôture                                                    | Selon fournisseur utilisé                                 |

## Garde spécifique aux sources Outcome

Le traitement est encore préparatoire : des fichiers publics ont été téléchargés localement et des
parseurs/connecteurs ont été testés, mais aucun appel live Judilibre, aucun import dans la base
Supabase distante et aucun réentraînement du modèle n'ont été réalisés dans cette tranche.

Avant activation, le responsable de traitement doit :

- documenter la finalité précise, les catégories de personnes et données, la base juridique, le test
  de mise en balance lorsqu'il s'applique, les destinataires, les transferts, l'information et les
  modalités d'exercice des droits ;
- décider et documenter si une AIPD est requise, au regard du volume, du croisement de sources
  judiciaires et foncières, des textes intégraux et de l'usage prédictif envisagé ;
- considérer Judilibre comme susceptible de contenir des données personnelles malgré la
  pseudonymisation, et DVF comme contenant des données personnelles selon l'avertissement de la
  DGFiP ; interdire toute ré-identification indirecte et toute indexation DVF par un moteur externe ;
- appliquer l'interdiction légale de réutiliser l'identité des magistrats ou membres du greffe afin
  d'évaluer, analyser, comparer ou prédire leurs pratiques professionnelles réelles ou supposées ;
- limiter le registre analytique aux métadonnées nécessaires. Le texte intégral Judilibre, les zones
  libres et les coordonnées de contact restent dans un stockage brut privé ; ils ne deviennent ni
  features, ni agrégats, ni contenu utilisateur ;
- faire entrer toutes les sources comme candidats `training_eligible = false`. Seuls des résultats
  canoniques rattachés, revus, soutenus par une preuve A/B et conformes au cutoff peuvent alimenter
  une cohorte dans un futur workflow ; la tranche actuelle force également tous les résultats
  canoniques à rester non entraînables ;
- appliquer la migration qui provisionne le bucket privé, tester l'absence de droits
  `anon`/`authenticated`, livrer le janitor d'objets orphelins et le worker de purge physique, puis
  tester la propagation d'une correction/suppression à Storage, aux projections et aux files en
  échec ;
- conserver l'attribution, les versions de CGU/licence et la date de dernière mise à jour. Pour
  Judilibre, surveiller la synchronisation transactionnelle selon le délai approuvé ; les CGU
  recommandent un intervalle maximal de 72 heures, sous réserve de disponibilité.

Les URLs avec paramètres, headers d'authentification, textes intégraux, identités et secrets ne
doivent pas apparaître dans les logs ou tickets. Les preuves de purge conservent seulement les
identifiants techniques, dates, motifs et hashes strictement nécessaires.

## Contrôles de mise à jour

- rapprocher ce registre du schéma Supabase et des routes API ;
- confirmer les régions, sous-traitants ultérieurs et DPA dans les tableaux de bord fournisseurs ;
- documenter toute décision d’intérêt légitime ;
- vérifier que les formulaires affichent la mention d’information appropriée ;
- réviser la matrice de conservation et le cron après toute nouvelle table contenant un utilisateur.
- rapprocher le registre des versions de `data_sources`, des CGU Judilibre/PISTE/DVF, du manifeste de
  téléchargements et des tests de suppression décrits dans le
  [runbook d'ingestion Outcome](runbooks/outcome-source-ingestion.md).
