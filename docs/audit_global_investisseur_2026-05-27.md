# Audit global Immojudis - Vercel, Supabase, produit et experience investisseur

Date de l'audit : 27 mai 2026  
Perimetre audite : application Vercel `immojudis-dezt`, base Supabase `scrap_ventes_immo`, pipeline data `services/data-pipeline`, application web `apps/scout`.

## 1. Synthese executive

Immojudis a deja une base produit interessante : une marque identifiable, une application de consultation fonctionnelle, une carte, des fiches de biens, des favoris/alertes, une pipeline d'ingestion avec extraction PDF/LLM, et une premiere version de scoring contextualise avec preuves. Le projet n'est donc pas au stade "prototype vide" : il y a une vraie matiere technique et metier.

En revanche, pour une presentation a des business angels, la version actuelle doit encore franchir un cap de maturite. Les investisseurs ne jugeront pas seulement l'interface : ils regarderont la defensibilite de la donnee, la fiabilite du scoring, la scalabilite de la collecte, la securite, la clarte du modele economique et la capacite a industrialiser.

Mon diagnostic global :

| Axe | Niveau actuel | Niveau attendu pour une demo BA | Diagnostic |
| --- | ---: | ---: | --- |
| Socle technique web | 7/10 | 8/10 | Stack moderne et deployee, mais dette de dependances, region Vercel, CI/lint et hygiene repo a nettoyer. |
| Supabase / securite | 5.5/10 | 8/10 | RLS present sur les tables metier, mais alerte `spatial_ref_sys`, grants trop larges et `service_role` en prod a rationaliser. |
| Pipeline data | 6/10 | 8/10 | Bonne base PDF/LLM/cache, mais execution lente, probablement manuelle, peu observable et couverture encore faible. |
| Scoring / valeur metier | 6/10 | 9/10 | Le v3 contextualise les risques, mais il faut passer a une logique documentaire explicable, auditable et calibree. |
| Fonctionnalites produit | 6.5/10 | 8/10 | Liste, carte, detail, favoris, alertes et rentabilite existent ; il manque le "deal memo", la preuve PDF, les workflows investisseur. |
| UX / design | 6.5/10 | 8.5/10 | Identite premium reussie sur desktop ; mobile et details de confiance a corriger avant toute demo. |
| Readiness business angels | 5/10 | 8/10 | Potentiel clair, mais il faut transformer le prototype en "Investor Preview" credible, mesuree et securisee. |

Priorite absolue : corriger les signaux de manque de maturite avant de montrer le produit.

Les cinq correctifs les plus importants :

1. Securiser Supabase : resoudre l'alerte `spatial_ref_sys`, reduire les grants anon/auth au strict necessaire, retirer `SUPABASE_SERVICE_ROLE_KEY` de Vercel si l'app ne l'utilise pas.
2. Monter le scoring d'un cran : document classifier, evidence graph, citations par page, statut de risque `confirme / infirme / conditionnel / generique`.
3. Corriger la version mobile : le hero deborde et coupe le texte sur 390 px, ce qui est bloquant pour une demo.
4. Industrialiser l'ingestion : run planifie, logs, retries, monitoring, SLA data, rapport qualite publie en admin.
5. Construire une fiche "deal memo" : une page qui explique pourquoi acheter, pourquoi ne pas acheter, d'ou vient chaque information et quelle verification humaine reste a faire.

## 2. Etat actuel du deploiement Vercel

### 2.1 Deploiement production

Le deploiement production est actif.

- Projet Vercel : `immojudis-dezt`
- Alias public : `https://immojudis-dezt.vercel.app`
- Dernier deployment inspecte : `dpl_JCxyQs9kmkn9JBLbnjB9riQARVPR`
- Statut : `Ready`
- Creation : 27 mai 2026 a 18:59:33 CEST
- Build Vercel : une fonction server `__fallback`
- Region observee : `iad1`

Observation importante : l'utilisateur cible est en France, mais la fonction Vercel observee est en `iad1`, donc US East. Les tests montrent de bons temps de reponse a chaud, mais les premiers appels ou les appels inter-region peuvent etre sensiblement plus lents.

Mesures observees :

| Page | Statut | TTFB chaud observe | Taille HTML |
| --- | ---: | ---: | ---: |
| `/` | 200 | ~0.30 s | ~17 KB |
| `/sales` | 200 | ~0.24 s | ~22 KB |

Mesures precedentes a froid/inter-region :

- Home : TTFB autour de 2.0 s.
- Sales : TTFB autour de 2.0 s.
- `x-vercel-id` indiquait une entree Europe vers fonction `iad1`.

Interpretation : la performance percue peut etre bonne apres warmup, mais la configuration n'est pas encore optimisee pour un public France/Europe.

### 2.2 Variables d'environnement

Variables presentes en Production et Development :

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Point de securite : `SUPABASE_SERVICE_ROLE_KEY` est presente sur Vercel. Le code contient un client server `client.server.ts`, mais la recherche d'imports montre que `supabaseAdmin` n'est pas utilise par les routes actuelles. Il faut donc soit :

- retirer cette variable de Vercel tant qu'elle n'est pas necessaire ;
- soit encapsuler tout usage service-role dans des server functions strictement auditees, jamais dans du code client, avec logs et tests de non-exposition.

### 2.3 Stack frontend

Stack observee :

- React 19.2
- TanStack Router / Query / Start
- Vite 7
- Nitro 3
- Supabase JS 2.105
- Tailwind 4
- Radix UI
- Leaflet / React Leaflet
- Recharts
- Lucide

Points positifs :

- Stack moderne.
- Decoupage manuel des chunks deja present (`vendor-supabase`, `vendor-radix`, `vendor-leaflet`, `vendor-icons`).
- Assets statiques servis avec cache immutable.
- SSR via TanStack/Nitro.

Points a nettoyer :

- Le package s'appelle encore `tanstack_start_ts` : signal de prototype.
- Il reste des traces Cloudflare (`@cloudflare/vite-plugin`, `wrangler.jsonc`) alors que le deploiement cible est Vercel.
- `npm run lint` a du etre interrompu apres une longue execution sans sortie : la configuration ESLint ignore `.output`, mais pas certains dossiers generes comme `.nitro`, `.tanstack`, `.vercel`. Pour une equipe investissable, lint et typecheck doivent etre rapides et systematiques.
- Le repo est dans un etat tres sale : nombreux fichiers modifies et non suivis. Avant demo/investisseur, il faut figer une branche propre, des commits explicites et un tag de version.

### 2.4 Vulnerabilites npm

Audit production `npm audit --omit=dev` :

- 4 vulnerabilites production.
- 1 high.
- 3 moderate.
- Paquets concernes : `nitro`, `h3`, `srvx`, `rendu`.
- La correction proposee par npm passe par une mise a jour de `nitro` vers une version beta plus recente.

Nature des alertes :

- Path traversal / arbitrary file read dans `h3`.
- Middleware bypass.
- SSE injection.
- Open redirect / proxy scope bypass dans Nitro.

Risque : l'app ne semble pas exposer de proxy complexe, mais une fonction SSR publique avec dependances serveur vulnerables n'est pas acceptable dans une version business angels.

Action recommandee :

1. Tester upgrade Nitro/TanStack compatible.
2. Relancer build Vercel.
3. Refaire `npm audit --omit=dev`.
4. Ajouter `npm audit --omit=dev` en check CI.

## 3. Audit Supabase

### 3.1 Volume et qualite actuelle

Etat des donnees :

| Indicateur | Valeur |
| --- | ---: |
| Ventes totales | 24 |
| Ventes upcoming | 15 |
| Geocodees | 23/24 |
| Date renseignee | 24/24 |
| Mise a prix renseignee | 24/24 |
| Surface app exploitable | 13/24 |
| Score calcule | 24/24 |
| Score v3 contextualise | 24/24 |
| Avec documents | 20/24 |
| Confiance score moyenne | 0.49 |
| Confiance score min | 0.16 |
| Confiance score max | 0.78 |

Lecture : la couverture prix/date/geocodage est bonne pour un prototype. La couverture surface et la confiance moyenne sont insuffisantes pour une promesse "precision". Une confiance moyenne a 0.49 signifie que le produit doit encore assumer clairement ses incertitudes.

### 3.2 Documents

Repartition des documents :

| Type document | Nombre | Extraits | Taille texte moyenne |
| --- | ---: | ---: | ---: |
| `cahier_conditions_vente` | 19 | 17 | ~23 995 caracteres |
| `pv_huissier` | 18 | 16 | ~8 385 caracteres |
| `annonce_vente` | 16 | 14 | ~1 774 caracteres |
| `pdf` non qualifie | 9 | 7 | ~7 434 caracteres |
| `diagnostics_techniques` | 6 | 5 | ~37 485 caracteres |

Bon signe : le projet commence deja a distinguer les familles documentaires essentielles.  
Point faible : 9 documents restent en type generique `pdf`, alors que la valeur metier depend justement de la nature du document.

Action prioritaire : imposer une taxonomie documentaire stable :

- page annonce / source listing ;
- avis simplifie / annonce de vente ;
- PV descriptif huissier ;
- PV notaire ;
- proces-verbal ;
- cahier des conditions de vente ;
- conditions generales ;
- diagnostics techniques ;
- diagnostics amiante ;
- diagnostics plomb / CREP ;
- termites ;
- DPE ;
- copropriete / reglement / etat descriptif de division ;
- servitudes / urbanisme ;
- annexes non pertinentes ;
- document inconnu.

### 3.3 Risques detectes

Distribution des risques consolides :

| Risque | Nombre | Confiance moyenne |
| --- | ---: | ---: |
| travaux | 9 | 0.83 |
| copropriete | 6 | 0.76 |
| amiante | 2 | 0.90 |
| servitude | 2 | 0.84 |
| termites | 2 | 0.90 |
| DPE | 1 | 0.84 |
| occupation | 1 | 0.82 |
| plomb | 1 | 0.94 |

Occurrences par type de document :

| Type document | Occurrences | Occurrences affirmees |
| --- | ---: | ---: |
| `pv_huissier` | 16 | 16 |
| `source_listing` | 11 | 11 |
| `diagnostics_techniques` | 9 | 9 |
| `cahier_conditions_vente` | 5 | 5 |
| `annonce_vente` | 4 | 4 |

Point positif : le scoring v3 ne se contente plus seulement du mot-cle. Il classe les occurrences avec extrait, type document, page, confidence, negation et contexte.

Point faible : les etats restent trop binaires. Le systeme doit distinguer :

- risque confirme sur le bien ;
- risque infirme explicitement ;
- information generique ou clause boilerplate ;
- risque conditionnel ;
- risque historique ou deja traite ;
- risque concernant un autre lot ;
- risque concernant les parties communes ;
- risque juridique de procedure, pas risque immobilier ;
- mention de diagnostic sans resultat ;
- absence de document donc incertitude.

### 3.4 Tables et taille

Tables principales :

| Table | Lignes estimees | Taille | RLS |
| --- | ---: | ---: | --- |
| `auction_sale_history` | 374 | 25 MB | Oui |
| `auction_extractions` | 190 | 5.4 MB | Oui |
| `auction_sales` | 24 | 1.4 MB | Oui |
| `auction_documents` | 68 | 200 KB | Oui |
| `auction_risk_occurrences` | 45 | 216 KB | Oui |
| `auction_score_factors` | 216 | 264 KB | Oui |
| `spatial_ref_sys` | 8 500 | 7.1 MB | Non |

Observation : `auction_sale_history` est deja la plus grosse table avec seulement 24 ventes. Elle contient vraisemblablement des payloads historiques volumineux. A faible echelle ce n'est pas grave ; a grande echelle, cela deviendra un cout et un frein de performance.

Actions :

- definir une retention history ;
- stocker les gros payloads en storage ou table archive ;
- compresser / separer le raw du read model ;
- indexer uniquement les champs interroges.

### 3.5 RLS, grants et alerte securite

Points positifs :

- RLS active sur les tables metier critiques.
- Politiques utilisateur propres sur `user_alerts` et `user_favorites` avec `user_id = auth.uid()`.
- Les vues principales utilisent `security_invoker = true`, ce qui evite le piege classique des vues qui bypassent RLS.

Points faibles :

1. Alerte Supabase critique non resolue sur `spatial_ref_sys`.

   - Table dans schema `public`.
   - RLS desactive.
   - Owner `supabase_admin`.
   - Supabase alerte "Table publicly accessible".

   Cette table vient de PostGIS, pas du metier Immojudis, mais le signal securite reste mauvais pour un audit investisseur. Elle doit etre resolue via dashboard Supabase ou en deplacant/isolant l'extension si l'environnement le permet.

2. Grants trop larges.

   L'audit des privileges montre des grants `DELETE, INSERT, UPDATE...` visibles pour `anon`/`authenticated` sur certaines tables/system views, meme si les policies RLS n'autorisent que `SELECT` sur les tables metier concernees. RLS protege les lignes, mais le principe de moindre privilege n'est pas respecte.

   A nettoyer :

   - `spatial_ref_sys`
   - `geometry_columns`
   - `geography_columns`
   - `auction_risk_occurrences`
   - `auction_score_factors`
   - `tribunals`
   - vues publiques
   - `user_alerts`
   - `user_favorites`

   Cible : `revoke all`, puis re-grant uniquement les operations necessaires.

3. Donnees publiques trop riches.

   Aujourd'hui, la vue app expose beaucoup de donnees enrichies. C'est utile pour aller vite, mais la valeur future d'Immojudis est dans la donnee structuree et la preuve. A terme, il faut differencier :

   - donnees publiques marketing ;
   - donnees accessibles utilisateur connecte ;
   - donnees premium ;
   - donnees internes pipeline ;
   - donnees raw/documents/cache non exposees.

## 4. Pipeline data et extraction documentaire

### 4.1 Pipeline actuel

Le pipeline realise :

1. collecte Avoventes ;
2. collecte Licitor optionnelle ;
3. inspection des fiches detail ;
4. normalisation ;
5. deduplication ;
6. telechargement PDF ;
7. extraction texte Docling puis fallback PyMuPDF/Tesseract ;
8. extraction LLM via Replicate / Gemini ;
9. geocodage BAN ;
10. enrichissement tribunal ;
11. normalisation actifs ;
12. scoring ;
13. export JSON/CSV ;
14. upsert Supabase ;
15. marquage `past` ;
16. rapport qualite.

C'est une architecture saine pour un prototype avance.

### 4.2 Performance pipeline

Dernier run complet observe :

- Date : 25 mai 2026
- Source : `all`
- Statut : `succeeded`
- Ventes collectees : 23
- Upsert : 23
- Duree totale : environ 14 minutes
- PDF : ~581 s
- LLM : ~174 s
- Scrape Avoventes : ~62 s
- Scrape Licitor : ~11 s
- Supabase : ~7 s

Lecture : le temps long vient principalement des PDF. C'est normal sur un prototype Docling/OCR, mais ce n'est pas encore une pipeline industrielle.

Optimisations :

- file de jobs par document ;
- extraction incrementalisee par hash document ;
- timeouts par type documentaire ;
- priorisation : annonce/PV/diagnostics d'abord, annexes ensuite ;
- pipeline asynchrone avec retry ;
- tableau de bord run quality ;
- seuil "document non exploitable" avec statut clair ;
- extraction page par page pour citations exactes.

### 4.3 Extraction LLM

Point positif :

- Prompt structurel.
- JSON valide controle par Pydantic.
- Cache par contexte/modele.
- Temperature 0.
- Backoff/retry Replicate.

Point faible :

- Le rapport du dernier run indique `llm_occupancy_extracted_pct: 0.0` alors que `with_occupancy_status_pct` est haut. Cela suggere que l'occupation vient surtout d'autres heuristiques/sources, pas de l'extraction LLM fiable.
- Le modele ne produit pas encore un raisonnement documentaire auditable.
- Les facteurs de score n'ont pas encore des `evidence_refs` pleinement exploitables.

Objectif cible : le LLM ne doit pas "donner un score". Il doit produire des assertions documentaires verifiables :

```json
{
  "claim": "presence_plomb",
  "status": "confirmed",
  "asset_scope": "lot_principal",
  "document_type": "diagnostics_techniques",
  "page": 14,
  "quote": "...",
  "confidence": 0.92,
  "risk_impact": "medium",
  "needs_human_review": false
}
```

Le score doit ensuite etre calcule de maniere deterministe depuis ces assertions.

## 5. Scoring et valeur metier

### 5.1 Etat actuel

Le score actuel combine :

- occupation ;
- etat du bien ;
- type ;
- localisation ;
- surface ;
- prix/m2 ;
- atouts ;
- risques ;
- qualite des donnees.

Forces :

- Comprenable.
- Explique par facteurs.
- Base score + delta.
- Versionne (`v3_contextual_evidence`).
- Tient compte de la qualite d'extraction.
- Associe deja certains risques a une evidence.

Limites :

- Les bandes de prix sont encore statiques par ville/departement.
- La localisation est grossiere.
- La liquidite n'est pas calibree sur transactions reelles.
- Le risque travaux reste base sur des patterns.
- Le risque copropriete peut etre une information normale, pas un risque.
- Les risques juridiques ne sont pas encore classes par impact investisseur.
- Pas de validation par outcome d'adjudication.
- Pas de backtesting.
- Pas de score par profil investisseur.

### 5.2 Point cle de valeur ajoutee

La promesse Immojudis ne doit pas etre "on a vu le mot plomb". La promesse doit etre :

> "Nous avons lu le bon document, identifie si l'information concerne vraiment le lot, extrait la phrase exacte, classe le niveau de risque, et explique son impact financier/juridique."

Le scoring doit donc devenir une chaine :

1. Classification document.
2. Segmentation du document.
3. Extraction d'assertions.
4. Qualification de l'assertion.
5. Rattachement au lot.
6. Calcul de score.
7. Explication utilisateur.
8. Niveau de confiance.
9. Action recommandee.

### 5.3 Nouvelle grille de scoring recommandee

Je recommande de separer le score final en sous-scores :

| Sous-score | Role |
| --- | --- |
| Opportunite prix | Decote mise a prix vs marche local. |
| Liquidite | Faculte de revente/location. |
| Qualite actif | Surface, type, etat, equipements. |
| Risque juridique | Occupation, servitudes, procedure, copropriete. |
| Risque technique | Amiante, plomb, termites, DPE, travaux. |
| Qualite dossier | Nombre/type de documents, contradictions, confiance extraction. |
| Conviction | Synthese ponderee de l'ensemble. |

Le score affiche peut rester `/100`, mais l'utilisateur doit voir les dimensions. Un score unique sans decomposition inspire moins confiance.

### 5.4 Assertions documentaires cible

Pour chaque information critique, stocker :

- type d'assertion ;
- statut : `confirmed`, `negated`, `generic`, `conditional`, `unknown`, `conflicting`;
- document type ;
- document label ;
- page ;
- extrait ;
- position approximative ;
- champ concerne ;
- lot concerne ;
- severite ;
- impact financier estime ;
- besoin de verification humaine ;
- version detecteur ;
- modele LLM ;
- timestamp.

Tables possibles :

- `auction_document_sections`
- `auction_claims`
- `auction_claim_evidence`
- `auction_score_dimensions`
- `auction_score_explanations`
- `auction_review_flags`

## 6. Fonctionnalites produit

### 6.1 Fonctionnalites presentes

Deja present ou visible dans le code :

- Home premium.
- Liste d'annonces.
- Filtres par departement, ville, type, prix, surface, occupation, score.
- Tri score/date/prix/surface.
- Carte.
- Detail annonce.
- Score badge.
- Analyse d'investissement.
- Documents officiels.
- Favoris.
- Alertes.
- Login.
- Simulateur de rentabilite.
- Insights quartier.
- Historique local "vu".
- Pages legal/privacy/contact.

C'est solide pour une premiere demo.

### 6.2 Limites fonctionnelles

1. Filtres avances partiellement cote client.

   Sur `/sales`, certains filtres comme prix/m2, rendement estime et rayon geographique sont appliques apres chargement des pages. A 24 annonces ce n'est pas grave ; a 10 000 annonces, les resultats seront faux ou incomplets.

   Cible : RPC Supabase ou vue materialisee avec filtres serveur.

2. Alertes sans preuve d'envoi.

   Les alertes existent en UI/base, mais je n'ai pas vu de systeme de notification email/cron robuste. Pour vendre la promesse "veille intelligente", il faut le workflow complet.

3. Favoris non utilises.

   La base indique 1 utilisateur, 0 favori, 0 alerte. C'est normal en pre-produit, mais pour BA il faudra des signaux d'usage, meme faibles.

4. Fiche detail pas encore assez "deal room".

   La fiche est belle, mais la section la plus differenciante ("pourquoi ce score ?") arrive trop bas et n'offre pas encore un lecteur PDF/citations.

5. Pas d'export.

   Les investisseurs adoreraient un export PDF "memo d'investissement" :

   - resume opportunite ;
   - score ;
   - risques ;
   - preuves ;
   - documents ;
   - checklist visite/adjudication ;
   - hypothese de rendement.

6. Pas de profil investisseur.

   Un meme bien n'a pas le meme score pour :

   - marchand de biens ;
   - investisseur locatif ;
   - primo-adjudicataire ;
   - investisseur patrimonial ;
   - renovateur lourd.

   Le scoring devrait etre parametrable par profil.

## 7. UX, design et graphisme

### 7.1 Identite visuelle

L'identite faucon / bleu nuit / or est bonne. Elle transmet :

- precision ;
- vigilance ;
- confiance ;
- serieux ;
- premium.

La direction est meilleure que le premier logo mascotte trop enfantin. Le faucon stylise, plus sobre, est la bonne voie.

Palette observee :

- bleu nuit ;
- or ;
- creme ;
- blanc ponctuel.

Recommandation : conserver l'esprit, mais eviter une interface entierement sombre. Pour un produit legal/financier, il faut aussi des zones de respiration et des surfaces tres lisibles.

### 7.2 Desktop

Points positifs :

- Home tres presentable.
- Hero premium.
- Cartes annonces lisibles.
- Score visible.
- Fiche detail ambitieuse.
- Cartographie utile.

Points a corriger :

- Les stats home peuvent afficher des tirets au chargement ; preferer skeletons ou valeur fallback.
- Le bandeau "Sources officielles & certifiees" cite `DGFIP`, `Ministere de la Justice`, `Notaires de France`, `Infogreffe`. Attention : cela peut etre interprete comme une certification/partenariat. Remplacer par "Sources publiques consultees" et clarifier.
- Les images annonce sont souvent absentes : "Pas d'illustration disponible" nuit a la perception.
- Sur une fiche, `unknown` est encore visible : il faut mapper/habiller tous les etats internes.
- "source llm" dans l'interface n'est pas presentable. Remplacer par "extraction documentaire" ou "source : PDF / annonce / diagnostic".

### 7.3 Mobile

Probleme bloquant observe sur 390 px :

- le headline "Investir avec precision." est coupe horizontalement ;
- le texte de support deborde ;
- les boutons CTA sont trop larges ;
- l'impression mobile est moins mature que desktop.

Action immediate :

- revoir tailles hero mobile ;
- contraindre largeur texte ;
- autoriser retours ligne ;
- diminuer padding horizontal boutons ;
- verifier screenshots mobile home, liste, detail.

### 7.4 Accessibilite

Risques :

- contraste or/bleu parfois delicat ;
- textes en uppercase avec tracking eleve ;
- boutons sans arrondis coherents selon contexte ;
- cartes sombres tres denses.

Actions :

- verifier contrastes WCAG ;
- focus states visibles ;
- textes non tronques ;
- labels explicites ;
- tests clavier sur filtres/menus.

## 8. Performance et scalabilite

### 8.1 Frontend

Bundles observes lors du build :

- CSS principal : ~106 KB.
- JS principal : ~413 KB.
- Supabase vendor : ~208 KB.
- Leaflet vendor : ~184 KB.
- Radix vendor : ~91 KB.
- Fonction server fallback : ~1.08 MB.

Actions :

- lazy-load Leaflet seulement sur carte/detail avec carte ;
- lazy-load composants lourds detail ;
- reduire Radix imports si possible ;
- verifier si Recharts est necessaire dans le bundle initial ;
- mettre en cache SSR/statique les pages marketing ;
- region Vercel Europe si disponible.

### 8.2 Supabase queries

La vue `v_auction_sales_app` simplifie beaucoup le frontend mais agrege :

- risques ;
- occurrences ;
- score factors ;
- documents ;
- tribunaux.

A 24 ventes, c'est parfait. A 10 000 ventes, cela peut devenir couteux.

Action cible :

- creer un read model `auction_sales_app_snapshot` ;
- rafraichir a chaque upsert pipeline ;
- garder les tables normalisees pour audit/detail ;
- utiliser la vue detail uniquement pour une annonce ;
- indexes composites sur les filtres principaux.

Indexes recommandes :

```sql
create index concurrently if not exists idx_sales_app_status_score
on auction_sales(status, investment_score desc)
where latitude is not null and longitude is not null;

create index concurrently if not exists idx_sales_department_date
on auction_sales(department, sale_date);

create index concurrently if not exists idx_occurrences_source_label_asserted
on auction_risk_occurrences(source_url, risk_label, confidence desc, page_number)
where is_negated = false;
```

### 8.3 Pipeline

Le pipeline est le futur moat, mais aussi le futur goulot.

Optimisations :

- jobs paralleles par document ;
- stockage hash par document ;
- extraction incrementalisee ;
- separation OCR lourd / extraction textuelle simple ;
- suivi cout LLM par run ;
- queue et retries ;
- alerting sur chute de couverture ;
- dashboard admin run health.

## 9. Securite, conformite et confiance

### 9.1 Priorites securite

P0 :

- resoudre l'alerte Supabase `spatial_ref_sys` ;
- reduire les grants anon/auth ;
- retirer `SUPABASE_SERVICE_ROLE_KEY` de Vercel si inutilise ;
- corriger vulnerabilites Nitro/H3 ;
- confirmer que la cle service n'apparait jamais dans les bundles client ;
- nettoyer les variables inutiles ;
- ajouter check CI `npm audit --omit=dev`.

### 9.2 Conformite produit

Le produit touche a des decisions d'investissement et a des documents judiciaires. Il faut cadrer la promesse :

- ne pas presenter le score comme conseil financier ;
- afficher que les informations sont extraites de sources publiques/documents ;
- encourager verification avocat/notaire/diagnostiqueur ;
- tracer la date de derniere mise a jour ;
- tracer la source exacte de chaque conclusion ;
- distinguer estimation, fait documentaire et hypothese.

### 9.3 Donnees personnelles

Les annonces judiciaires peuvent contenir noms, adresses, occupants, debiteurs. Le pipeline doit prevoir :

- minimisation des donnees personnelles affichees ;
- masquage des noms non necessaires ;
- justification des donnees conservees ;
- politique de conservation ;
- logs sans secrets ;
- RGPD : contact, suppression, rectification si applicable.

## 10. Readiness business angels

### 10.1 Ce qui est deja vendable dans l'histoire

Narratif fort :

- marche opaque ;
- documents longs et difficiles ;
- opportunites sous-exploitees ;
- besoin de precision, rapidite et confiance ;
- IA + donnees publiques + workflow investisseur ;
- possibilite de transformer une veille manuelle en plateforme.

Ce qui peut convaincre :

- extraction PDF et scoring deja fonctionnels ;
- preuves documentaires en cours ;
- marque premium differenciante ;
- pipeline proprietaire ;
- extension possible a toute la France ;
- modeles d'abonnement, lead gen, outils pros.

### 10.2 Ce qui manque pour convaincre

Les BA demanderont :

- combien de ventes couvertes ?
- quelle fraicheur ?
- quelle precision vs humain ?
- combien de faux positifs ?
- quelle source de marche pour la decote ?
- quel usage utilisateur ?
- quel cout par annonce analysee ?
- comment scaler la collecte ?
- quel risque legal sur scraping/documents ?
- quelle defensibilite si un concurrent copie l'interface ?

Aujourd'hui, les reponses existent partiellement mais ne sont pas encore productisees.

### 10.3 Version cible a presenter

Nom recommande : `Immojudis Investor Preview v0.3`

Contenu minimum :

- 100 a 300 ventes actives sur une zone claire ;
- 90%+ geocodees ;
- 80%+ avec documents classes ;
- 70%+ avec au moins une preuve documentaire exploitable ;
- score en 5 dimensions ;
- detail avec citations PDF ;
- export "deal memo" ;
- favoris et alertes fonctionnels de bout en bout ;
- dashboard admin data quality ;
- metrics cout/temps pipeline ;
- demo mobile propre ;
- securite Supabase sans alerte critique.

## 11. Roadmap d'optimisation

### P0 - Avant toute demo investisseur

| Sujet | Action | Impact | Effort |
| --- | --- | --- | --- |
| Supabase security | Resoudre `spatial_ref_sys`, grants stricts, verifier policies | Tres fort | M |
| Secrets | Retirer `SUPABASE_SERVICE_ROLE_KEY` de Vercel si inutilise | Fort | S |
| Vulnerabilites | Upgrade Nitro/H3 ou mitigation documentee | Fort | M |
| Mobile | Corriger overflow hero / CTA | Fort | S |
| UI confiance | Supprimer `unknown`, `source llm`, textes internes | Fort | S |
| Legal copy | Remplacer "sources certifiees" par formulation prudente | Fort | S |
| Repo | Branche propre, commits, tag demo, docs setup | Fort | S |
| Lint | Ignorer dossiers generes et rendre `npm run lint` rapide | Moyen | S |

### P1 - 2 a 4 semaines

| Sujet | Action | Impact | Effort |
| --- | --- | --- | --- |
| Scoring v4 | Assertions documentaires, negation, genericite, conflit | Tres fort | L |
| Evidence viewer | Afficher document, page, extrait, raison | Tres fort | L |
| Read model | Snapshot Supabase pour liste/carte | Fort | M |
| Pipeline run | Cron/worker + observabilite | Fort | M |
| Alertes | Envoi email reel + preferences | Fort | M |
| Deal memo | Export PDF/print pour une vente | Tres fort | M |
| Admin quality | Page qualite data/scoring/run | Fort | M |
| Mobile detail | Detail annonce mobile premium | Moyen | M |

### P2 - 1 a 3 mois

| Sujet | Action | Impact | Effort |
| --- | --- | --- | --- |
| Couverture | Extension departements / France progressive | Tres fort | L |
| Marche | Integration DVF / loyers / comparables | Tres fort | L |
| Backtesting | Comparer scores a adjudications/outcomes | Tres fort | L |
| Profils | Scoring par profil investisseur | Fort | M |
| Paiement | Plans, Stripe, entitlements Supabase | Fort | M |
| Collaboration | Notes, checklist, partage dossier | Moyen | M |
| Monitoring | Sentry/Log drain/Uptime/DB advisors | Fort | M |

### P3 - Moat

| Sujet | Action | Impact | Effort |
| --- | --- | --- | --- |
| Modele proprietaire | Calibration score sur historique adjudications | Tres fort | XL |
| Evaluation extraction | Jeu de verite terrain annote | Tres fort | L |
| Donnees enrichies | Estimation travaux, loyers, liquidite locale | Tres fort | L |
| Assistant dossier | Q&A sourcee sur les PDF du bien | Fort | L |
| Marketplace pros | Avocats, diagnostiqueurs, financement, travaux | Fort | L |

## 12. Optimisations detaillees identifiees

### Technique

- Configurer Vercel region Europe si compatible TanStack/Nitro.
- Mettre en cache les pages marketing ou pre-render.
- Lazy-load Leaflet et composants detail lourds.
- Nettoyer dependances Cloudflare si Vercel devient cible unique.
- Renommer le package.
- Ajouter CI : install, lint, typecheck, build, npm audit.
- Ajouter tests smoke Playwright desktop/mobile.
- Fix ESLint ignores.
- Stabiliser le lockfile : un seul gestionnaire (`npm` ou `bun`, pas les deux en signal produit).

### Supabase

- Resoudre alerte `spatial_ref_sys`.
- Revoquer privileges non necessaires.
- Separateur schemas : `public_app`, `internal`, `extensions` si possible.
- Read model pour l'app.
- Materialized stats.
- Retention history.
- Index composite occurrences.
- Audits Supabase advisors.
- Verifier les vues `security_invoker` a chaque migration.

### Data / scoring

- Taxonomie documentaire stricte.
- Classification automatique document + confidence.
- Assertions documentaires.
- Evidence refs utilisables.
- Statuts nuance des risques.
- Mode "contradiction" si documents divergents.
- Score multidimensionnel.
- Backtesting.
- Jeu d'evaluation annote.
- Cout pipeline par annonce.
- Score confidence visible et comprehensible.

### Produit

- Deal memo.
- Watchlist.
- Alertes email.
- Comparaison de biens.
- Recherche sauvegardee.
- Profil investisseur.
- Checklist adjudication.
- Notes utilisateur.
- Export PDF.
- Mode premium.
- Admin qualite.

### UX/design

- Mobile first correction.
- Detail annonce avec preuve en haut.
- Remplacer placeholders vides par visuels utiles.
- Terminologie 100% metier.
- Ne pas afficher valeurs internes.
- Ameliorer etats de chargement.
- Renforcer accessibilite.
- Clarifier "sources publiques".
- Ajouter une page methodologie scoring.

### Graphisme

- Conserver faucon sobre.
- Utiliser le faucon comme repere de precision, pas comme mascotte enfantine.
- Prevoir formats : mark, wordmark, favicon, app icon, inverse.
- Eviter fond blanc dominant.
- Garder bleu nuit/or/creme, mais introduire surfaces neutres lisibles.
- Harmoniser iconographie : precision, vigilance, droit, immobilier.

## 13. KPI a suivre avant levee

Data :

- nombre de ventes actives ;
- taux documents classes ;
- taux documents extraits ;
- taux ventes avec preuve ;
- taux geocodage ;
- fraicheur moyenne ;
- cout moyen par annonce ;
- duree moyenne run ;
- faux positifs risques ;
- score confidence moyen.

Produit :

- visiteurs uniques ;
- comptes crees ;
- favoris par utilisateur ;
- alertes creees ;
- taux retour ;
- clics documents ;
- exports deal memo ;
- temps sur fiche ;
- conversion free -> premium si pricing.

Metier :

- opportunites identifiees ;
- ecart mise a prix vs marche ;
- adjudications suivies ;
- precision scoring vs outcome ;
- dossiers verifies par humain.

## 14. Conclusion

Immojudis a une base plus avancee qu'une simple maquette : ingestion, scoring, preuves, interface et marque existent deja. Le potentiel est reel, surtout si le produit devient la couche de lecture intelligente des documents judiciaires immobiliers.

Le risque principal n'est pas le frontend. Le vrai sujet est la confiance : prouver que le score sait lire le bon document, comprendre le contexte, citer la preuve, qualifier l'incertitude et eviter les faux positifs.

La prochaine version doit donc etre construite autour d'une idee simple :

> Chaque score Immojudis doit etre explicable, sourcé et contestable.

Si cette promesse est tenue, la plateforme peut devenir beaucoup plus qu'un agrégateur d'annonces : un outil d'aide a la decision pour un marche opaque, avec une vraie valeur investisseur.
