"use client";

import { AdminLaunchOfferPanel } from "@/components/admin/AdminLaunchOfferPanel";
import { AdminOfferOpeningPanel } from "@/components/admin/AdminOfferOpeningPanel";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminSubscriptionsPanel } from "@/components/admin/AdminSubscriptionsPanel";
import { useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";

export function AdminClientsPage() {
  const { user } = useAuth();
  const { isRefreshing, refresh } = useAdminRefresh([
    "admin-subscriptions",
    "admin-launch-offer",
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
      <AdminOfferOpeningPanel />
      <AdminSubscriptionsPanel />
    </AdminShell>
  );
}
