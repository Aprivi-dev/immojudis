REVOKE EXECUTE ON FUNCTION public.is_user_approved(UUID) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, public;