begin;

set local lock_timeout = '5s';

-- Comment only, no data and no right changes. The previous comment said the snapshots hold no
-- directly identifying data (true) but read as if they could not be linked to a person. A notarial
-- row keeps the hearing day, the department, the property type and the exact starting price (and the
-- exact adjudication price when published): that combination finds the public announcement again,
-- hence the property and its seller, often an individual (estate, joint ownership).
comment on table app_private.sale_market_estimate_snapshots is
  'Un instantané par vente de tribunal ou notariale, écrit juste avant la disparition de la ligne d''estimation (purge à l''audience ou sortie des statuts active/upcoming) : tribunal (nul pour une vente notariale), département, type de bien, mise à prix, date d''audience, estimation P10/P50/P90 et qualité, résultat de la règle pepite-v1 (version, statut, plafond de référence, prix probable, part B, ratio C, régime, occupation, état) et, pour une vente notariale dont la source a publié le résultat, prix d''adjudication et mention de résultat. Données non directement identifiantes, réidentifiables par recoupement avec l''annonce publique : aucune adresse, aucun identifiant de vente en clair (snapshot_key = empreinte SHA-256 non salée de l''identifiant de la vente : pseudonymisation, pas anonymisation, tant que l''identifiant existe ailleurs), mais le jour d''audience, le département, le type de bien et la mise à prix retrouvent l''annonce, donc le bien et son vendeur, souvent un particulier. Sert à apparier plus tard estimation, pépite et prix d''adjudication agrégé. Conservé 36 mois après l''audience (app_private.market_estimate_snapshot_retention), purgé par run_data_retention.';

commit;
