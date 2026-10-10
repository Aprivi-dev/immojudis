"use client";

import { AdminPrivacyRequestsPanel } from "@/components/admin/AdminPrivacyRequestsPanel";
import { AdminReadinessPanel } from "@/components/admin/AdminReadinessPanel";
import { AdminShell } from "@/components/admin/AdminShell";
import { useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";

export function AdminCompliancePage() {
  const { user } = useAuth();
  const { isRefreshing, refresh } = useAdminRefresh(["admin-privacy-requests", "admin-readiness"]);
  return (
    <AdminShell
      activeSection="compliance"
      title="Conformité"
      description="Suivez les demandes réglementaires et les échéances."
      adminEmail={user?.email}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
    >
      <div className="space-y-6">
        <AdminPrivacyRequestsPanel />
        <AdminReadinessPanel />
      </div>
    </AdminShell>
  );
}
