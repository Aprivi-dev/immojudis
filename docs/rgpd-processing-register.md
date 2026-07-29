# Registre simplifié des traitements RGPD

Propriétaire du registre : responsable de traitement indiqué dans les mentions légales. Revue
minimale : annuelle et avant toute nouvelle finalité, catégorie sensible, fournisseur ou transfert.

| Traitement                    | Personnes / données                                                   | Finalité                                           | Base                                         | Destinataires                                   | Conservation active / archive                                   | Transfert                             |
| ----------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| Compte et authentification    | Utilisateurs ; email, identité de compte, rôles, sessions             | Créer et sécuriser le compte                       | Contrat, intérêt légitime                    | Immojudis, Supabase                             | Vie du compte ; traces strictement nécessaires selon obligation | Selon région et garanties Supabase    |
| Recherche et personnalisation | Utilisateurs ; favoris, alertes, zones, préférences                   | Fournir les fonctions demandées                    | Contrat                                      | Immojudis, Supabase                             | Vie du compte ; suppression à l’effacement                      | Selon garanties Supabase              |
| Analyse de dossiers           | Clients ; rapports, notes, simulations, exports, espaces              | Fournir Analyse et collaboration                   | Contrat                                      | Immojudis, Supabase, collaborateurs invités     | Vie du compte ; événements d’usage 24 mois                      | Selon garanties Supabase              |
| Paiement Analyse              | Clients ; référence Stripe, montant, état, preuve d’acceptation       | Encaisser, activer, rembourser, prouver le contrat | Contrat, obligation légale                   | Immojudis, Stripe, Supabase                     | Accès actif ; preuve/archives jusqu’à 10 ans                    | Garanties Stripe/Supabase à vérifier  |
| Alertes email                 | Utilisateurs consentants ; préférence, consentement, événements       | Envoyer les alertes demandées                      | Consentement, contrat pour le transactionnel | Immojudis, Resend                               | Jusqu’au retrait ; clôturées 6 mois                             | Garanties Resend à vérifier           |
| Mise en relation avocat       | Demandeurs ; coordonnées, message, dossier                            | Transmettre une demande volontaire                 | Mesures précontractuelles, contrat           | Immojudis, avocat sélectionné                   | Temps du suivi puis délai de preuve                             | Selon destinataire                    |
| Publication professionnelle   | Professionnels ; identité, pièces, demande                            | Examiner et publier une annonce                    | Mesures précontractuelles, contrat           | Immojudis, Supabase                             | Temps du traitement puis délai de preuve                        | Selon garanties Supabase              |
| Mesure et performance         | Visiteurs/utilisateurs ; pages, performances, identifiants techniques | Exploiter et améliorer le service                  | Intérêt légitime                             | Immojudis, Vercel                               | Selon configuration fournisseur ; événements internes 24 mois   | Cadre UE–États-Unis/SCC selon service |
| Support et droits             | Utilisateurs ; email, demande, décision, dates                        | Répondre aux droits et réclamations                | Obligation légale, défense des droits        | Immojudis, prestataires strictement nécessaires | Demande ouverte puis 5 ans après clôture                        | Selon fournisseur utilisé             |

## Contrôles de mise à jour

- rapprocher ce registre du schéma Supabase et des routes API ;
- confirmer les régions, sous-traitants ultérieurs et DPA dans les tableaux de bord fournisseurs ;
- documenter toute décision d’intérêt légitime ;
- vérifier que les formulaires affichent la mention d’information appropriée ;
- réviser la matrice de conservation et le cron après toute nouvelle table contenant un utilisateur.
