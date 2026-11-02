"use client";

import { useState } from "react";
import {
  AdminCatalogueReadinessPanel,
  type InformationRequestSelection,
} from "@/components/admin/AdminCatalogueReadinessPanel";
import { AdminAuctionFactClaimReviewPanel } from "@/components/admin/AdminAuctionFactClaimReviewPanel";
import { AdminInformationAgentMissionsPanel } from "@/components/admin/AdminInformationAgentMissionsPanel";
import { AdminInformationAgentOperationsPanel } from "@/components/admin/AdminInformationAgentOperationsPanel";
import { AdminInformationAgentReviewPanel } from "@/components/admin/AdminInformationAgentReviewPanel";
import { AdminInformationAgentTemplatePanel } from "@/components/admin/AdminInformationAgentTemplatePanel";
import { AdminInformationAgentUnroutedPanel } from "@/components/admin/AdminInformationAgentUnroutedPanel";

export function AdminInformationAgentWorkspace() {
  const [selection, setSelection] = useState<InformationRequestSelection | null>(null);
  return (
    <div className="space-y-6">
      <AdminCatalogueReadinessPanel onPrepareInformationRequest={setSelection} />
      <AdminInformationAgentMissionsPanel
        selection={selection}
        onClose={() => setSelection(null)}
      />
      <AdminInformationAgentOperationsPanel />
      <AdminAuctionFactClaimReviewPanel />
      <AdminInformationAgentReviewPanel />
      <AdminInformationAgentUnroutedPanel />
      <AdminInformationAgentTemplatePanel />
    </div>
  );
}
