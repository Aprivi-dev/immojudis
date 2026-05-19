## Découverte du nouveau schéma

Le schéma révèle une refonte côté pipeline avec :

**Nouvelles colonnes sur `auction_sales`**
- `app_surface_m2`, `app_surface_kind`, `surface_source`, `surface_confidence`, `surface_scope` (surface "officielle" choisie par le pipeline, avec traçabilité)
- `bathrooms_count`, `parking_count` (en plus des chambres/pièces)
- `primary_source`, `source_urls`, `dedupe_confidence` (déduplication multi-sources)
- `tribunal_code` → FK vers `public.tribunals`
- `quality_flags`, `observations`, `score_version`, `last_run_id`
- `location` (PostGIS geography)

**Nouvelles tables liées**
- `auction_risks` : liste structurée (type, label, severity 1-N, evidence) — remplace le champ texte `risk_notes`
- `auction_documents` : documents enrichis (label, type, statut OCR/extraction, sha256) — remplace le JSON `documents`
- `auction_features` / `auction_surfaces` / `auction_extractions` / `auction_observations` : tables d'analyse intermédiaires
- `tribunals` : référentiel canonique (code, nom, dépt, ville)
- `auction_runs`, `auction_sale_history`, `auction_scoring_versions` : observabilité

**Inchangé** : `user_favorites`, `user_alerts` → 0 impact app côté auth.

---

## Plan d'alignement (3 étapes)

### 1. Mettre à jour la vue `v_auction_sales_app` (migration SQL)
Étendre la vue pour exposer :
- nouveaux champs : `app_surface_m2`, `app_surface_kind`, `surface_scope`, `bathrooms_count`, `parking_count`, `primary_source`, `tribunal_code`
- jointure `LEFT JOIN tribunals` pour exposer `tribunal_name`, `tribunal_city`
- agrégat `auction_risks` en JSON (array de `{type,label,severity}`)
- agrégat `auction_documents` en JSON (array de `{url,label,type,status}`)

Filtre conservé : `status IN ('upcoming','unknown') AND lat/lng NOT NULL`.

### 2. Adapter le code TypeScript
- `src/lib/types.ts` : ajouter les nouveaux champs sur `AuctionSale` + types `SaleRisk`, `SaleDocumentRich`
- `src/lib/queries.ts` :
  - tri `surface_desc` basé sur `app_surface_m2`
  - filtre `min_surface` → utiliser `app_surface_m2` (plus fiable que `habitable_surface_m2` seul)
  - nouveau filtre optionnel `tribunal_code`
- `src/components/SaleCard.tsx` : afficher `app_surface_m2` en priorité, badge "source dédupliquée" si `primary_source` ≠ source courante
- `src/routes/sales.$id.tsx` :
  - nouvelle section **Risques** (liste colorée selon `severity`)
  - section **Documents** depuis le nouveau tableau enrichi (label + type + lien)
  - nouvelles stats : salles de bain, parkings
  - afficher le tribunal canonique + ville
  - badge "confiance surface" (`surface_confidence`)
- `src/components/SaleFilters.tsx` : ajouter sélecteur tribunal (optionnel, phase 2 si trop)

### 3. Garder rétrocompatibilité
- Tous les nouveaux champs côté TS sont `| null` → aucune casse si la vue n'est pas encore migrée
- L'app fonctionne avec ou sans les agrégats `risks` / `documents_rich`

---

## Question avant exécution

Tu peux soit :
- **(A)** me laisser créer la **migration SQL** qui met à jour `v_auction_sales_app` (recommandé — je l'écris, tu la passes dans Supabase)
- **(B)** me dire que tu mettras la vue à jour toi-même, et je n'aligne que le **code TS** sur le schéma actuel (sans agrégats risks/documents pour l'instant)

Dis-moi A ou B et je lance.