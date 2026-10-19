"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Gift from "lucide-react/dist/esm/icons/gift.js";
import { toast } from "sonner";
import { AdminPanel } from "@/components/admin/AdminShell";
import { fetchAdminLaunchOffer, setAdminLaunchOfferClient } from "@/lib/client-api";
import { LAUNCH_OFFER_ACCOUNT_TEXT } from "@/lib/launch-offer";

export const LAUNCH_OFFER_QUERY_KEY = ["admin-launch-offer"] as const;

/**
 * Interrupteur de l'offre de lancement : tant qu'elle est active, tout compte gratuit bénéficie des
 * avantages de l'offre Analyse (aucune écriture sur les comptes). La couper les ramène à leur offre
 * réelle, sans préavis ; la page et l'API suivent en une minute au plus (cache de 30 s + 30 s du CDN).
 * Procédure complète : docs/runbooks/offre-de-lancement.md.
 */
export function AdminLaunchOfferPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: LAUNCH_OFFER_QUERY_KEY,
    queryFn: fetchAdminLaunchOffer,
    staleTime: 15_000,
  });
  const mutation = useMutation({
    mutationFn: (active: boolean) => setAdminLaunchOfferClient(active),
    onSuccess: (state) => {
      queryClient.setQueryData(LAUNCH_OFFER_QUERY_KEY, state);
      toast.success(
        state.active
          ? "Offre de lancement rétablie."
          : "Offre de lancement coupée : les comptes gratuits reviennent à l’offre Découverte.",
      );
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Action impossible"),
  });

  const active = query.data?.active;

  function toggle() {
    if (active === undefined || mutation.isPending) return;
    // Couper l'offre retire les avantages à tous les comptes gratuits, sans préavis : on demande
    // confirmation. La rétablir n'enlève rien à personne.
    if (
      active &&
      !window.confirm(
        "Couper l’offre de lancement ? Tous les comptes gratuits perdent immédiatement les avantages de l’offre Analyse (la mise à jour peut prendre jusqu’à une minute).",
      )
    ) {
      return;
    }
    mutation.mutate(!active);
  }

  return (
    <AdminPanel className="mb-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-text">
            <Gift className="size-4" aria-hidden />
            Offre de lancement
          </div>
          <h2 className="mt-2 text-xl font-semibold">
            {query.isPending
              ? "Chargement de l’offre de lancement…"
              : query.isError
                ? "Offre de lancement indisponible"
                : active
                  ? "Offre de lancement active"
                  : "Offre de lancement coupée"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-brand-navy/65">
            Tant qu’elle est active, tout compte gratuit bénéficie des avantages de l’offre Analyse,
            sans carte bancaire. Aucune écriture dans les comptes ni dans les abonnements : la
            couper ramène chacun à son offre réelle. Mention affichée aux utilisateurs :
          </p>
          <p className="mt-2 rounded-lg bg-gold/10 p-3 text-sm leading-6">
            {LAUNCH_OFFER_ACCOUNT_TEXT}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {query.isError ? (
            <button
              type="button"
              className="admin-button-secondary"
              onClick={() => void query.refetch()}
            >
              Réessayer
            </button>
          ) : (
            <button
              type="button"
              className={active ? "admin-button-secondary" : "admin-button-primary"}
              disabled={active === undefined || mutation.isPending}
              onClick={toggle}
            >
              {mutation.isPending
                ? "Enregistrement…"
                : active
                  ? "Couper l’offre de lancement"
                  : "Rétablir l’offre de lancement"}
            </button>
          )}
        </div>
      </div>
    </AdminPanel>
  );
}
