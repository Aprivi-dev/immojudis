"use client";

import {
  AdminPrivacyRequestsPanel,
  PRIVACY_REQUESTS_QUERY_KEY,
} from "@/components/admin/AdminPrivacyRequestsPanel";
import { AdminShell } from "@/components/admin/AdminShell";
import { useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";

/**
 * Vue « Conformité » : les demandes RGPD et les rétractations. Le diagnostic « Activation
 * commerciale » (Stripe, webhook, tâches planifiées) est dans Configuration > Services.
 */
export function AdminCompliancePage() {
  const { user } = useAuth();
  const { isRefreshing, refresh } = useAdminRefresh([PRIVACY_REQUESTS_QUERY_KEY[0]]);
  return (
    <AdminShell
      activeSection="compliance"
      title="Conformité"
      description="Suivez les demandes réglementaires et les échéances."
      adminEmail={user?.email}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
    >
      <AdminPrivacyRequestsPanel />
    </AdminShell>
  );
}
