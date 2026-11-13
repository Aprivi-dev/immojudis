import type { ReactNode } from "react";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { AdminPanel } from "@/components/admin/AdminShell";
import type { EmailViewTone } from "@/lib/admin-emails/views";

const TONES: Record<EmailViewTone, string> = {
  ok: "border-success/25 bg-success-tint text-success",
  bad: "border-danger/25 bg-danger-tint text-danger",
  warn: "border-warning/25 bg-warning-tint text-warning",
  neutral: "border-brand-navy/15 bg-surface-muted text-brand-navy/70",
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
  return (
    <span className={`inline-flex w-fit rounded-full border px-2.5 py-0.5 text-xs ${TONES[tone]}`}>
      {children}
    </span>
  );
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
