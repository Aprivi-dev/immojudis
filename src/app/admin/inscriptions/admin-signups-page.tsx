"use client";

import { AdminShell } from "@/components/admin/AdminShell";
import { AdminSignupsPanel, SIGNUPS_QUERY_KEY } from "@/components/admin/AdminSignupsPanel";
import { useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";

export function AdminSignupsPage() {
  const { user } = useAuth();
  const { isRefreshing, refresh } = useAdminRefresh(SIGNUPS_QUERY_KEY);
  return (
    <AdminShell
      activeSection="signups"
      title="Inscriptions"
      description="Suivez les comptes créés et prolongez l’essai gratuit des comptes choisis."
      adminEmail={user?.email}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
    >
      <AdminSignupsPanel />
    </AdminShell>
  );
}
