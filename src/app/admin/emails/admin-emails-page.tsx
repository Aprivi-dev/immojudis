"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { useAuth } from "@/hooks/use-auth";
// Imports statiques, sans `dynamic()` par onglet : mesuré le 01/11/2026, trois chargements différés
// faisaient passer le JavaScript client total de +19 Ko à +124 Ko (les modules communs sont recopiés
// dans chaque groupe de chargement). Le code des onglets pèse moins de 15 Ko.
import { AdminEmailDesignsTab } from "@/components/admin/emails/AdminEmailDesignsTab";
import { AdminEmailListTab } from "@/components/admin/emails/AdminEmailListTab";
import { EmailHistoryPanel } from "@/components/admin/emails/EmailHistoryPanel";
import { toggle } from "@/components/admin/emails/email-ui";
import { fetchAdminEmailAddresses, fetchAdminEmailTemplates } from "@/lib/client-api/admin-emails";

const TABS = [
  { id: "designs", label: "Designs" },
  { id: "adresses", label: "Adresses" },
  { id: "templates", label: "Modèles" },
  { id: "historique", label: "Historique" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/**
 * Vue « Emails ». L'onglet vit dans l'adresse (`?onglet=…`), lu au montage et écrit sans navigation :
 * `useSearchParams` sortirait la page du HTML préfabriqué (voir `AuthGate`).
 */
export function AdminEmailsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabId>("designs");

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("onglet");
    const found = TABS.find((item) => item.id === requested);
    if (found) setTab(found.id);
  }, []);

  function select(id: TabId) {
    setTab(id);
    const url = new URL(window.location.href);
    url.searchParams.set("onglet", id);
    window.history.replaceState(window.history.state, "", url);
  }

  return (
    <AdminShell
      activeSection="emails"
      title="Emails"
      description="Aperçus, adresses d’envoi et domaines des emails d’Immojudis."
      adminEmail={user?.email}
    >
      <div className="space-y-5">
        <div role="tablist" aria-label="Rubriques des emails" className="flex flex-wrap gap-2">
          {TABS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className={toggle(tab === item.id)}
              onClick={() => select(item.id)}
              onKeyDown={(event) => {
                const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                const next = TABS[(index + step + TABS.length) % TABS.length];
                select(next.id);
                document.getElementById(`tab-${next.id}`)?.focus();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "designs" ? <AdminEmailDesignsTab /> : null}
          {tab === "adresses" ? (
            <AdminEmailListTab
              queryKey="admin-emails-addresses"
              loading="Chargement des adresses…"
              fetchView={fetchAdminEmailAddresses}
            />
          ) : null}
          {tab === "templates" ? (
            <AdminEmailListTab
              queryKey="admin-emails-templates"
              loading="Chargement des modèles…"
              fetchView={fetchAdminEmailTemplates}
            />
          ) : null}
          {tab === "historique" ? <EmailHistoryPanel /> : null}
        </div>
      </div>
    </AdminShell>
  );
}
