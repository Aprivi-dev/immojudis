"use client";

import dynamic from "next/dynamic";
import { AdminLaunchOfferPanel } from "@/components/admin/AdminLaunchOfferPanel";
import { AdminOfferOpeningPanel } from "@/components/admin/AdminOfferOpeningPanel";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminSubscriptionsPanel } from "@/components/admin/AdminSubscriptionsPanel";
import { useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";

// Préavis de fin d'offre (n° 74) : chargé à la demande, hors du JavaScript initial de la page.
const AdminLaunchOfferEndPanel = dynamic(() =>
  import("@/components/admin/AdminLaunchOfferEndPanel").then(
    (module) => module.AdminLaunchOfferEndPanel,
  ),
);

export function AdminClientsPage() {
  const { user } = useAuth();
  const { isRefreshing, refresh } = useAdminRefresh([
    "admin-subscriptions",
    "admin-launch-offer",
    "admin-launch-offer-end",
    "admin-offer-opening-audience",
  ]);
  return (
    <AdminShell
      activeSection="clients"
      title="Clients & abonnements"
      description="Gérez les accès commerciaux et les plans attribués."
      adminEmail={user?.email}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
    >
      <AdminLaunchOfferPanel />
      <AdminLaunchOfferEndPanel />
      <AdminOfferOpeningPanel />
      <AdminSubscriptionsPanel />
    </AdminShell>
  );
}
