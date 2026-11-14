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
import { AdminQueryErrorNotice, useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";
import { useBillingOffer, type BillingOfferSource } from "@/hooks/use-billing-offer";
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
  // État de l'offre Analyse, lu sur l'onglet Clients seulement. Hors React Query : « Actualiser » le
  // relit explicitement.
  const billing = useBillingOffer(tab === "clients");
  return (
    <AdminShell
      activeSection="accounts"
      title="Comptes"
      description="Suivez les inscriptions, l’essai gratuit et les accès payants."
      adminEmail={user?.email}
      onRefresh={() => {
        void refresh();
        if (tab === "clients") billing.reload();
      }}
      isRefreshing={isRefreshing}
    >
      <div className="space-y-5">
        <AdminTabs label="Rubriques des comptes" tabs={TABS} active={tab} onSelect={select} />
        {tab ? (
          <AdminTabPanel tab={tab}>
            {tab === "inscriptions" ? <AdminSignupsPanel /> : <ClientsTab billing={billing} />}
          </AdminTabPanel>
        ) : null}
      </div>
    </AdminShell>
  );
}

function ClientsTab({ billing: { offer, reload } }: { billing: BillingOfferSource }) {
  // « Prévenir la liste d'attente » n'a d'objet qu'une fois l'abonnement Analyse réellement ouvert :
  // même condition que les pages publiques qui proposent d'être prévenu (`analysisOfferOpen`). L'état
  // est lu à l'ouverture de l'onglet et par « Actualiser » : le panneau apparaît alors.
  return (
    <>
      <AdminLaunchOfferPanel />
      {offer.status === "ready" && offer.open ? <AdminOfferOpeningPanel /> : null}
      {offer.status === "error" ? (
        <AdminQueryErrorNotice
          className="mb-6"
          error={null}
          fallback="L’état de l’offre Analyse n’a pas pu être lu : « Prévenir la liste d’attente » n’apparaît qu’une fois l’abonnement ouvert."
          hasData={false}
          isRetrying={false}
          onRetry={reload}
        />
      ) : null}
      <AdminSubscriptionsPanel />
    </>
  );
}
