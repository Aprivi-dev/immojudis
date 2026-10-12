-- Publication creation and moderation run through authenticated server handlers.
-- RLS does not replace table privileges, including for the service role.
grant select, insert, update on table public.listing_publication_requests to service_role;
