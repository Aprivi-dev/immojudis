"use client";

import dynamic from "next/dynamic";
import { AdminPanelLoading } from "@/components/admin/admin-ui";
import { AdminShell } from "@/components/admin/AdminShell";
import { useAuth } from "@/hooks/use-auth";

// Cinq panneaux lourds (maturité du catalogue, missions, faits, réponses, template) : chargés
// après le cadre de la page pour tenir le budget de JavaScript initial de la route.
const LazyAdminInformationAgentWorkspace = dynamic(
  () =>
    import("@/components/admin/AdminInformationAgentWorkspace").then(
      (module) => module.AdminInformationAgentWorkspace,
    ),
  { loading: () => <AdminPanelLoading label="le template agent" /> },
);

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
