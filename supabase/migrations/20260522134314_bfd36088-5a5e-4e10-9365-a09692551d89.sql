
CREATE TABLE public.auction_contacts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sale_id UUID NOT NULL,
  role TEXT,
  name TEXT,
  organization TEXT,
  email TEXT,
  phone TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  source_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_auction_contacts_sale_id ON public.auction_contacts(sale_id);

ALTER TABLE public.auction_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auction_contacts_public_read"
ON public.auction_contacts FOR SELECT
TO anon, authenticated
USING (true);

CREATE TRIGGER update_auction_contacts_updated_at
BEFORE UPDATE ON public.auction_contacts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
