-- Les réservations de dépôt expirées sans validation sont désormais libérées par l'application
-- (`releaseExpiredInformationAgentPortalUploads`), une fois l'objet orphelin supprimé du stockage.
-- Le schéma ne change pas : seul le commentaire de la colonne est mis à jour.
comment on column public.information_agent_portal_upload_reservations.status is
  'reserved while a signed URL may still be used, consumed after validation, or released once expired (plus a 15-minute grace) after its orphan Storage object was removed.';
