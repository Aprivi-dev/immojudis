"use client";

import dynamic from "next/dynamic";
import { AdminPanel, AdminShell } from "@/components/admin/AdminShell";
import { useAuth } from "@/hooks/use-auth";

// Cinq panneaux lourds (maturité du catalogue, missions, faits, réponses, template) : chargés
// après le cadre de la page pour tenir le budget de JavaScript initial de la route.
const LazyAdminInformationAgentWorkspace = dynamic(
  () =>
    import("@/components/admin/AdminInformationAgentWorkspace").then(
      (module) => module.AdminInformationAgentWorkspace,
    ),
  { loading: () => <AgentPanelsLoading /> },
);

// Libellé propre à cette vue : « Chargement de … » de AdminPanelLoading ne s'accorde pas avec
// « des panneaux de l'agent d'information ».
export function AgentPanelsLoading() {
  return (
    <AdminPanel className="flex min-h-36 items-center justify-center p-6 text-sm text-brand-navy/60">
      <span role="status">Chargement des panneaux de l’agent d’information…</span>
    </AdminPanel>
  );
}

/**
 * Vue « Agent IA ». Pas de bouton « Actualiser » global : rafraîchir l'éditeur du template
 * le remonterait depuis la réponse du serveur et pourrait effacer un brouillon en cours. Chaque
 * panneau charge et pagine ses propres listes.
 */
export function AdminAgentPage() {
  const { user } = useAuth();
  return (
    <AdminShell
      activeSection="agent"
      title="Agent IA"
      description="Configurez les prises de contact et contrôlez le template envoyé aux professionnels."
      adminEmail={user?.email}
    >
      <LazyAdminInformationAgentWorkspace />
    </AdminShell>
  );
}
