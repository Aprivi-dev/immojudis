"use client";

import { useState } from "react";
import { AdminLawyerReferralRequestsPanel } from "@/components/admin/AdminLawyerReferralRequestsPanel";
import {
  AdminLawyerStatementPanel,
  LAWYER_STATEMENT_QUERY_KEY,
} from "@/components/admin/AdminLawyerStatementPanel";
import { AdminReferencedLawyersPanel } from "@/components/admin/AdminReferencedLawyersPanel";
import { AdminShell } from "@/components/admin/AdminShell";
import { useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";

type LawyerTab = "referrals" | "directory" | "statement";

export function AdminLawyersPage() {
  const { user } = useAuth();
  const [lawyerTab, setLawyerTab] = useState<LawyerTab>("referrals");
  const { isRefreshing, refresh } = useAdminRefresh([
    "admin-lawyer-referral-requests",
    "admin-referenced-lawyers",
    LAWYER_STATEMENT_QUERY_KEY,
  ]);

  return (
    <AdminShell
      activeSection="lawyers"
      title="Avocats"
      description="Pilotez le réseau référencé et les mises en relation."
      adminEmail={user?.email}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
    >
      <AdminLawyers activeTab={lawyerTab} onTabChange={setLawyerTab} />
    </AdminShell>
  );
}

function AdminLawyers({
  activeTab,
  onTabChange,
}: {
  activeTab: LawyerTab;
  onTabChange: (tab: LawyerTab) => void;
}) {
  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-brand-navy/14">
        <button
          type="button"
          onClick={() => onTabChange("referrals")}
          className={`border-b-2 px-4 py-3 text-sm font-medium ${
            activeTab === "referrals"
              ? "border-gold-soft text-gold-text"
              : "border-transparent text-brand-navy/58"
          }`}
        >
          Mises en relation
        </button>
        <button
          type="button"
          onClick={() => onTabChange("directory")}
          className={`border-b-2 px-4 py-3 text-sm font-medium ${
            activeTab === "directory"
              ? "border-gold-soft text-gold-text"
              : "border-transparent text-brand-navy/58"
          }`}
        >
          Réseau référencé
        </button>
        <button
          type="button"
          onClick={() => onTabChange("statement")}
          className={`border-b-2 px-4 py-3 text-sm font-medium ${
            activeTab === "statement"
              ? "border-gold-soft text-gold-text"
              : "border-transparent text-brand-navy/58"
          }`}
        >
          Relevé mensuel
        </button>
      </div>
      {activeTab === "referrals" ? (
        <AdminLawyerReferralRequestsPanel />
      ) : activeTab === "directory" ? (
        <AdminReferencedLawyersPanel />
      ) : (
        <AdminLawyerStatementPanel />
      )}
    </div>
  );
}
