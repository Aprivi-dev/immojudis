"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  AdminCatalogueReadinessPanel,
  type InformationRequestSelection,
} from "@/components/admin/AdminCatalogueReadinessPanel";
import { AdminCatalogueReadinessSettings } from "@/components/admin/AdminCatalogueReadinessSettings";
import { AdminAuctionFactClaimReviewPanel } from "@/components/admin/AdminAuctionFactClaimReviewPanel";
import { AdminFactClaimDecisionPanel } from "@/components/admin/AdminFactClaimDecisionPanel";
import { AdminInformationAgentAutopilotPanel } from "@/components/admin/AdminInformationAgentAutopilotPanel";
import { AdminInformationAgentAutoPublicationPanel } from "@/components/admin/AdminInformationAgentAutoPublicationPanel";
import { AdminInformationAgentMissionsList } from "@/components/admin/AdminInformationAgentMissionsList";
import {
  AdminInformationAgentMissionsPanel,
  type OpenMissionRequest,
} from "@/components/admin/AdminInformationAgentMissionsPanel";
import { AdminInformationAgentOperationsPanel } from "@/components/admin/AdminInformationAgentOperationsPanel";
import { AdminInformationAgentReviewPanel } from "@/components/admin/AdminInformationAgentReviewPanel";
import { AdminInformationAgentSummary } from "@/components/admin/AdminInformationAgentSummary";
import { AdminInformationAgentTemplatePanel } from "@/components/admin/AdminInformationAgentTemplatePanel";
import { AdminInformationAgentUnroutedPanel } from "@/components/admin/AdminInformationAgentUnroutedPanel";
import { useInformationAgentSummary } from "@/components/admin/use-information-agent-summary";
import { toggle } from "@/components/admin/emails/email-ui";
import type { InformationAgentMission } from "@/lib/information-agent/schemas";

// Imports statiques, comme le module Emails : un `dynamic()` par onglet recopie les modules communs
// dans chaque groupe de chargement et coûte plus de JavaScript qu'il n'en économise.
export const AGENT_TABS = [
  { id: "a-contacter", label: "À contacter" },
  { id: "envois", label: "Envois" },
  { id: "reponses", label: "Réponses" },
  { id: "pilote", label: "Pilote" },
  { id: "reglages", label: "Réglages" },
] as const;
export type AgentTabId = (typeof AGENT_TABS)[number]["id"];

/** Au-delà de ce délai sans réponse des listes de réponses, l'onglet d'accueil est « À contacter ». */
const HOME_TAB_FALLBACK_MS = 3_000;

/**
 * Espace de travail de l'agent : bandeau de synthèse, puis cinq onglets. L'onglet vit dans l'adresse
 * (`?onglet=…`), lu au montage et écrit sans navigation (comme le module Emails).
 *
 * Un onglet n'est monté (et ne charge ses données) qu'à sa première visite ; ensuite il reste monté et
 * masqué (`hidden`) : un brouillon de message ou un gabarit en cours de modification survit au
 * changement d'onglet, sans nouvelle requête au retour.
 */
export function AdminInformationAgentWorkspace() {
  const summary = useInformationAgentSummary();
  const [tab, setTab] = useState<AgentTabId | null>(null);
  const [urlRead, setUrlRead] = useState(false);
  const [visited, setVisited] = useState<ReadonlySet<AgentTabId>>(() => new Set());
  const [selection, setSelection] = useState<InformationRequestSelection | null>(null);
  const [openRequest, setOpenRequest] = useState<OpenMissionRequest | null>(null);

  function show(id: AgentTabId) {
    setTab(id);
    setVisited((previous) => (previous.has(id) ? previous : new Set(previous).add(id)));
  }

  function select(id: AgentTabId) {
    show(id);
    const url = new URL(window.location.href);
    url.searchParams.set("onglet", id);
    window.history.replaceState(window.history.state, "", url);
  }

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("onglet");
    const found = AGENT_TABS.find((item) => item.id === requested);
    if (found) show(found.id);
    setUrlRead(true);
  }, []);

  // Onglet d'accueil, choisi une seule fois (sans `?onglet=`) : « Réponses » s'il y a une réponse à
  // relire ou un message non rattaché, sinon « À contacter ». Une fois un onglet affiché, les
  // compteurs qui bougent ensuite ne le changent plus.
  const hasReplies = (summary.toReview.value ?? 0) + (summary.unrouted.value ?? 0) > 0;
  useEffect(() => {
    if (!urlRead || tab !== null) return;
    if (summary.repliesSettled) {
      show(hasReplies ? "reponses" : "a-contacter");
      return;
    }
    const timer = setTimeout(() => show("a-contacter"), HOME_TAB_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [urlRead, tab, summary.repliesSettled, hasReplies]);

  function openMission(mission: InformationAgentMission) {
    setSelection(null);
    setOpenRequest((previous) => ({ mission, nonce: (previous?.nonce ?? 0) + 1 }));
    select("a-contacter");
  }

  const counts: Partial<Record<AgentTabId, number | null>> = {
    "a-contacter": summary.contactable.value,
    reponses: summary.replies,
  };

  function panel(id: AgentTabId, content: ReactNode) {
    return (
      <div
        role="tabpanel"
        id={`agent-panel-${id}`}
        aria-labelledby={`agent-tab-${id}`}
        hidden={tab !== id}
        className="space-y-6"
      >
        {visited.has(id) ? content : null}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AdminInformationAgentSummary summary={summary} />
      <div role="tablist" aria-label="Rubriques de l’agent" className="flex flex-wrap gap-2">
        {AGENT_TABS.map((item, index) => {
          const count = counts[item.id];
          const selected = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`agent-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`agent-panel-${item.id}`}
              tabIndex={selected || (tab === null && index === 0) ? 0 : -1}
              className={`${toggle(selected)} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-navy`}
              onClick={() => select(item.id)}
              onKeyDown={(event) => {
                const last = AGENT_TABS.length - 1;
                const current = tab === null ? index : AGENT_TABS.findIndex((t) => t.id === tab);
                const target =
                  event.key === "ArrowRight"
                    ? (current + 1) % AGENT_TABS.length
                    : event.key === "ArrowLeft"
                      ? (current - 1 + AGENT_TABS.length) % AGENT_TABS.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? last
                          : null;
                if (target === null) return;
                event.preventDefault();
                select(AGENT_TABS[target].id);
                document.getElementById(`agent-tab-${AGENT_TABS[target].id}`)?.focus();
              }}
            >
              {item.label}
              {count != null ? ` (${count})` : ""}
            </button>
          );
        })}
      </div>
      {tab === null ? (
        <p role="status" className="text-sm text-brand-navy/60">
          Chargement de l’espace de travail…
        </p>
      ) : null}
      {panel(
        "a-contacter",
        <>
          <AdminCatalogueReadinessPanel onPrepareInformationRequest={setSelection} />
          <AdminInformationAgentMissionsPanel
            selection={selection}
            onClose={() => setSelection(null)}
            openRequest={openRequest}
            active={tab === "a-contacter"}
          />
        </>,
      )}
      {panel("envois", <AdminInformationAgentMissionsList onOpenMission={openMission} />)}
      {panel(
        "reponses",
        <>
          <AdminInformationAgentReviewPanel />
          <AdminAuctionFactClaimReviewPanel />
          <AdminFactClaimDecisionPanel />
          <AdminInformationAgentUnroutedPanel />
        </>,
      )}
      {panel(
        "pilote",
        <>
          <AdminInformationAgentAutopilotPanel />
          <AdminInformationAgentOperationsPanel />
        </>,
      )}
      {panel(
        "reglages",
        <>
          <AdminInformationAgentAutoPublicationPanel />
          <AdminInformationAgentTemplatePanel />
          <AdminCatalogueReadinessSettings />
        </>,
      )}
    </div>
  );
}
