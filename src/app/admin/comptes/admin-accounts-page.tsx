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
import { AdminSignupsPanel, SIGNUPS_QUERY_KEY } from "@/components/admin/AdminSignupsPanel";
import { AdminSubscriptionsPanel } from "@/components/admin/AdminSubscriptionsPanel";
import { AdminTabPanel, AdminTabs } from "@/components/admin/AdminTabs";
import { useAdminTabParam } from "@/components/admin/use-admin-tab-param";
import { useAdminRefresh } from "@/components/admin/admin-ui";
import { useAnalysisCheckoutOpen } from "@/hooks/use-analysis-checkout-open";
import { useAuth } from "@/hooks/use-auth";
import { SUBSCRIPTIONS_QUERY_KEY } from "@/lib/admin-query-keys";

const TABS = [
  { id: "inscriptions", label: "Inscriptions" },
  { id: "clients", label: "Clients & abonnements" },
] as const;

/**
 * Vue « Comptes » : inscriptions et accès payants, en deux onglets. Les anciennes adresses
 * /admin/inscriptions et /admin/clients redirigent vers l'onglet correspondant.
 */
export function AdminAccountsPage() {
  const { user } = useAuth();
  const [tab, select] = useAdminTabParam(TABS, "inscriptions");
  const { isRefreshing, refresh } = useAdminRefresh([
    SIGNUPS_QUERY_KEY[0],
    SUBSCRIPTIONS_QUERY_KEY[0],
    LAUNCH_OFFER_QUERY_KEY[0],
    OFFER_OPENING_AUDIENCE_QUERY_KEY[0],
  ]);
  return (
    <AdminShell
      activeSection="accounts"
      title="Comptes"
      description="Suivez les inscriptions, l’essai gratuit et les accès payants."
      adminEmail={user?.email}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
    >
      <div className="space-y-5">
        <AdminTabs label="Rubriques des comptes" tabs={TABS} active={tab} onSelect={select} />
        {tab ? (
          <AdminTabPanel tab={tab}>
            {tab === "inscriptions" ? <AdminSignupsPanel /> : <ClientsTab />}
          </AdminTabPanel>
        ) : null}
      </div>
    </AdminShell>
  );
}

function ClientsTab() {
  // « Prévenir la liste d'attente » n'a d'objet qu'une fois l'abonnement Analyse réellement ouvert :
  // même condition que les pages publiques qui proposent d'être prévenu (`analysisOfferOpen`). Le
  // panneau réapparaît de lui-même à l'ouverture.
  const offerOpen = useAnalysisCheckoutOpen();
  return (
    <>
      <AdminLaunchOfferPanel />
      {offerOpen === true ? <AdminOfferOpeningPanel /> : null}
      <AdminSubscriptionsPanel />
    </>
  );
}
