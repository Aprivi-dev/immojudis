-- Index composite pour accélérer les requêtes par bounding box (carte, ventes voisines, DVF).
-- La vue v_auction_sales_app expose lat/lng depuis la table auction_sales.
CREATE INDEX IF NOT EXISTS auction_sales_lat_lng_idx
  ON public.auction_sales (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Index pour le tri principal (date de vente) avec filtre département très courant.
CREATE INDEX IF NOT EXISTS auction_sales_department_sale_date_idx
  ON public.auction_sales (department, sale_date);

-- Index pour le tri par score (filtre "meilleur score").
CREATE INDEX IF NOT EXISTS auction_sales_investment_score_idx
  ON public.auction_sales (investment_score DESC NULLS LAST);
