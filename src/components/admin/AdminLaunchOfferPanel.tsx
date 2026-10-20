"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Gift from "lucide-react/dist/esm/icons/gift.js";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { AdminPanel } from "@/components/admin/AdminShell";
import { formatInteger } from "@/components/admin/admin-format";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchAdminLaunchOffer, setAdminLaunchOfferClient } from "@/lib/client-api";
import { fetchAdminPilotage } from "@/lib/client-api/admin";
import { LAUNCH_OFFER_ACCOUNT_TEXT } from "@/lib/launch-offer";

export const LAUNCH_OFFER_QUERY_KEY = ["admin-launch-offer"] as const;
const LAUNCH_OFFER_ACCOUNTS_QUERY_KEY = ["admin-launch-offer-accounts"] as const;

const CUT_MESSAGE =
  "Offre de lancement coupée : les comptes gratuits reviennent à l’offre Découverte.";
const RESTORED_MESSAGE = "Offre de lancement rétablie.";

/**
 * Interrupteur de l'offre de lancement : tant qu'elle est active, tout compte gratuit bénéficie des
 * avantages de l'offre Analyse (aucune écriture sur les comptes). La couper les ramène à leur offre
 * réelle, sans préavis ; la page et l'API suivent en une minute au plus (cache de 30 s + 30 s du CDN).
 * Couper demande une confirmation (boîte de dialogue) qui dit combien de comptes sont touchés ; le
 * changement d'état est annoncé dans une zone `role="status"`.
 * Procédure complète : docs/runbooks/offre-de-lancement.md.
 */
export function AdminLaunchOfferPanel() {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Annonce du changement d'état aux lecteurs d'écran : la zone existe avant que le texte y paraisse.
  const [announcement, setAnnouncement] = useState("");
  const query = useQuery({
    queryKey: LAUNCH_OFFER_QUERY_KEY,
    queryFn: fetchAdminLaunchOffer,
    staleTime: 15_000,
  });
  const mutation = useMutation({
    mutationFn: (active: boolean) => setAdminLaunchOfferClient(active),
    onSuccess: (state) => {
      queryClient.setQueryData(LAUNCH_OFFER_QUERY_KEY, state);
      const message = state.active ? RESTORED_MESSAGE : CUT_MESSAGE;
      setAnnouncement(message);
      toast.success(message);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Action impossible";
      setAnnouncement(`Offre de lancement non modifiée : ${message}`);
      toast.error(message);
    },
  });
  // Nombre de comptes touchés : lu seulement à l'ouverture de la confirmation, exact (c'est une
  // aide à la décision de l'administrateur, pas une statistique affichée).
  const accountsQuery = useQuery({
    queryKey: LAUNCH_OFFER_ACCOUNTS_QUERY_KEY,
    queryFn: async () => (await fetchAdminPilotage()).snapshot.launchOfferAccounts,
    enabled: confirmOpen,
    staleTime: 0,
    gcTime: 0,
  });

  const active = query.data?.active;

  function toggle() {
    if (active === undefined || mutation.isPending) return;
    // Couper l'offre retire les avantages à tous les comptes gratuits, sans préavis : on demande
    // confirmation. La rétablir n'enlève rien à personne.
    if (active) {
      setConfirmOpen(true);
      return;
    }
    mutation.mutate(true);
  }

  function confirmCut() {
    setConfirmOpen(false);
    mutation.mutate(false);
  }

  const accountsAffected = accountsQuery.data ?? null;
  const accountsText = accountsQuery.isPending
    ? "Calcul du nombre de comptes concernés…"
    : accountsAffected == null
      ? "Le nombre de comptes concernés n’est pas disponible."
      : accountsAffected === 0
        ? "Aucun compte ne bénéficie de l’offre que grâce à elle."
        : accountsAffected === 1
          ? "1 compte perd les avantages de l’offre Analyse."
          : `${formatInteger(accountsAffected)} comptes perdent les avantages de l’offre Analyse.`;

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
          <p className="mt-2 text-sm leading-6 text-brand-navy/70">
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
      <p role="status" className="mt-3 text-sm font-medium text-brand-navy">
        {announcement}
      </p>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Couper l’offre de lancement ?</DialogTitle>
            <DialogDescription>
              Tous les comptes gratuits perdent immédiatement les avantages de l’offre Analyse (la
              mise à jour peut prendre jusqu’à une minute).
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm font-semibold" data-testid="launch-offer-accounts">
            {accountsText}
          </p>
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <button type="button" className="admin-button-secondary">
                Annuler
              </button>
            </DialogClose>
            <button type="button" className="admin-button-primary" onClick={confirmCut}>
              Couper l’offre
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPanel>
  );
}
