"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  AdminLawyerReferralRequestsPanel,
  LAWYER_REFERRAL_REQUESTS_QUERY_KEY,
} from "@/components/admin/AdminLawyerReferralRequestsPanel";
import {
  AdminLawyerStatementPanel,
  LAWYER_STATEMENT_QUERY_KEY,
} from "@/components/admin/AdminLawyerStatementPanel";
import {
  AdminReferencedLawyersPanel,
  REFERENCED_LAWYERS_QUERY_KEY,
} from "@/components/admin/AdminReferencedLawyersPanel";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";
import { fetchAdminReferencedLawyers } from "@/lib/client-api";

const TABS = [
  { id: "referrals", label: "Mises en relation" },
  { id: "directory", label: "Réseau référencé" },
  { id: "statement", label: "Relevé mensuel" },
] as const;
type LawyerTab = (typeof TABS)[number]["id"];

export function AdminLawyersPage() {
  const { user } = useAuth();
  const [lawyerTab, setLawyerTab] = useState<LawyerTab>("referrals");
  const { isRefreshing, refresh } = useAdminRefresh([
    LAWYER_REFERRAL_REQUESTS_QUERY_KEY[0],
    REFERENCED_LAWYERS_QUERY_KEY[0],
    LAWYER_STATEMENT_QUERY_KEY,
  ]);
  // Même requête (et même cache) que le panneau « Réseau référencé » : enregistrer le premier avocat
  // la relit, et les deux onglets réapparaissent d'eux-mêmes.
  const lawyersQuery = useQuery({
    queryKey: REFERENCED_LAWYERS_QUERY_KEY,
    queryFn: fetchAdminReferencedLawyers,
    staleTime: 30_000,
  });
  // Onglets montrés dès qu'un avocat est référencé, ou si la liste est illisible (rien n'est caché
  // sur une erreur). « Référencer un avocat » les ouvre pour saisir le premier.
  const [revealed, setRevealed] = useState(false);
  const lawyers = lawyersQuery.data?.lawyers;
  const showTabs = revealed || lawyersQuery.isError || (lawyers?.length ?? 0) > 0;

  return (
    <AdminShell
      activeSection="lawyers"
      title="Avocats"
      description="Pilotez le réseau référencé et les mises en relation."
      adminEmail={user?.email}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
    >
      <div className="space-y-4">
        {showTabs ? (
          <AdminTabs
            label="Rubriques des avocats"
            tabs={TABS}
            active={lawyerTab}
            onSelect={setLawyerTab}
          />
        ) : lawyers ? (
          <p className="text-sm text-brand-navy/70">
            Aucun avocat référencé : le réseau et le relevé mensuel apparaîtront avec le premier.{" "}
            <button
              type="button"
              className="font-semibold text-gold-text underline"
              onClick={() => {
                setRevealed(true);
                setLawyerTab("directory");
              }}
            >
              Référencer un avocat
            </button>
          </p>
        ) : null}
        {/* Même élément avec ou sans onglets : le panneau des mises en relation n'est pas remonté
            (ni ses saisies perdues) quand les onglets apparaissent. */}
        <div
          role={showTabs ? "tabpanel" : undefined}
          id={showTabs ? `panel-${lawyerTab}` : undefined}
          aria-labelledby={showTabs ? `tab-${lawyerTab}` : undefined}
        >
          {lawyerTab === "referrals" ? (
            <AdminLawyerReferralRequestsPanel />
          ) : lawyerTab === "directory" ? (
            <AdminReferencedLawyersPanel />
          ) : (
            <AdminLawyerStatementPanel />
          )}
        </div>
      </div>
    </AdminShell>
  );
}
