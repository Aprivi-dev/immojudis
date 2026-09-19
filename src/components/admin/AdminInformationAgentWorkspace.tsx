"use client";

import { useState } from "react";
import {
  AdminCatalogueReadinessPanel,
  type InformationRequestSelection,
} from "@/components/admin/AdminCatalogueReadinessPanel";
import { AdminInformationAgentMissionsPanel } from "@/components/admin/AdminInformationAgentMissionsPanel";
import { AdminInformationAgentReviewPanel } from "@/components/admin/AdminInformationAgentReviewPanel";
import { AdminInformationAgentTemplatePanel } from "@/components/admin/AdminInformationAgentTemplatePanel";

export function AdminInformationAgentWorkspace() {
  const [selection, setSelection] = useState<InformationRequestSelection | null>(null);
  return (
    <div className="space-y-6">
      <AdminCatalogueReadinessPanel onPrepareInformationRequest={setSelection} />
      <AdminInformationAgentMissionsPanel
        selection={selection}
        onClose={() => setSelection(null)}
      />
      <AdminInformationAgentReviewPanel />
      <AdminInformationAgentTemplatePanel />
    </div>
  );
}
