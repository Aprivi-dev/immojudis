import type { ReactNode } from "react";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { AdminPanel } from "@/components/admin/AdminShell";
import { AdminPill, type AdminPillTone } from "@/components/admin/admin-pill";
import type { EmailViewTone } from "@/lib/admin-emails/views";

/** Les tons des vues des e-mails, dans les pastilles de l'administration. */
const PILL_TONES: Record<EmailViewTone, AdminPillTone> = {
  ok: "success",
  bad: "danger",
  warn: "warning",
  neutral: "neutral",
};

/** Classe d'un bouton à bascule : plein quand il est actif. */
export const toggle = (on: boolean) => (on ? "admin-button-primary" : "admin-button-secondary");

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: EmailViewTone;
  children: ReactNode;
}) {
  return <AdminPill tone={PILL_TONES[tone]}>{children}</AdminPill>;
}

/**
 * Chargement ou erreur d'une requête de l'onglet, ou `null` quand les données sont là. Écrit ici plutôt
 * que repris de `admin-ui.tsx` : ce module entrait en double dans le JavaScript de la route.
 */
export function queryProblem(
  query: {
    data: unknown;
    isLoading: boolean;
    isFetching: boolean;
    error: unknown;
    refetch: () => unknown;
  },
  loading: string,
): ReactNode {
  if (query.data) return null;
  if (query.isLoading) {
    return (
      <AdminPanel className="p-6 text-sm text-brand-navy/60">
        <span role="status">{loading}</span>
      </AdminPanel>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/30 bg-danger-tint p-4 text-sm text-danger"
    >
      <p>{queryErrorMessage(query.error, "Chargement impossible.")}</p>
      <button
        type="button"
        className="admin-button-secondary mt-3"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Réessayer
      </button>
    </div>
  );
}
