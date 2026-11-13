"use client";

import {
  AdminLaunchOfferPanel,
  LAUNCH_OFFER_QUERY_KEY,
} from "@/components/admin/AdminLaunchOfferPanel";
import {
  AdminOfferOpeningPanel,
  OFFER_OPENING_AUDIENCE_QUERY_KEY,
} from "@/components/admin/AdminOfferOpeningPanel";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminSubscriptionsPanel } from "@/components/admin/AdminSubscriptionsPanel";
import { useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";
import { SUBSCRIPTIONS_QUERY_KEY } from "@/lib/admin-query-keys";

export function AdminClientsPage() {
  const { user } = useAuth();
  const { isRefreshing, refresh } = useAdminRefresh([
    SUBSCRIPTIONS_QUERY_KEY[0],
    LAUNCH_OFFER_QUERY_KEY[0],
    OFFER_OPENING_AUDIENCE_QUERY_KEY[0],
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
