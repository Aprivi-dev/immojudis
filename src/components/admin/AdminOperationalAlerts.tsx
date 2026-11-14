"use client";

import { useQuery } from "@tanstack/react-query";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import Link from "next/link";
import { AdminPanel, AdminSectionHeading } from "@/components/admin/AdminShell";
import { adminReadinessQuery } from "@/components/admin/admin-readiness-query";
import { formatCompactDateTime } from "@/components/admin/admin-format";
import { AdminPill } from "@/components/admin/admin-pill";

/**
 * Alertes d'exploitation ouvertes, en libellés français (mis en forme par le serveur), avec leur gravité
 * et un lien vers l'endroit où agir. Le diagnostic liste aussi des alertes refermées dont la notification reste à livrer : seules
 * les ouvertes sont montrées ici.
 */
export function AdminOperationalAlerts() {
  const query = useQuery(adminReadinessQuery());
  // Null tant que le nombre est inconnu : chargement, erreur, ou base injoignable côté serveur.
  const count = query.data?.operations.openAlertCount ?? null;
  const alerts = query.data?.operations.alerts.filter((alert) => alert.status === "open") ?? [];
  const hidden = count === null ? 0 : Math.max(0, count - alerts.length);

  return (
    <AdminPanel className="p-5">
      <AdminSectionHeading title="Alertes ouvertes" />
      {query.isError && query.data ? (
        <p className="mt-3 text-sm text-amber-800" role="status">
          Actualisation impossible : la liste date du dernier chargement réussi.
        </p>
      ) : null}
      {query.isPending ? (
        <p className="mt-3 text-sm text-brand-navy/60" role="status">
          Chargement des alertes…
        </p>
      ) : count === null ? (
        <div className="mt-3 text-sm text-red-700" role="alert">
          <p>Alertes indisponibles pour le moment.</p>
          <button
            type="button"
            className="admin-button-secondary mt-3"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Réessayer
          </button>
        </div>
      ) : count === 0 ? (
        <p className="mt-3 text-sm text-brand-navy/70">Aucune alerte ouverte</p>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-brand-navy/10">
            {alerts.map((alert) => {
              const { label, place } = alert;
              return (
                <li
                  key={alert.key}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <AdminPill tone={alert.severity === "critical" ? "danger" : "warning"}>
                        {alert.severityLabel}
                      </AdminPill>
                      <span className="font-medium text-brand-navy">{label}</span>
                    </div>
                    <p className="mt-1 text-xs text-brand-navy/60">
                      Dernier signal le {formatCompactDateTime(alert.lastSeenAt)}
                    </p>
                  </div>
                  <Link
                    href={place.href}
                    className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-gold-text"
                  >
                    {place.label} <ChevronRight className="size-4" />
                  </Link>
                </li>
              );
            })}
          </ul>
          {hidden ? (
            <p className="mt-2 text-sm text-brand-navy/70">
              Et {hidden} autre{hidden > 1 ? "s" : ""} alerte{hidden > 1 ? "s" : ""} ouverte
              {hidden > 1 ? "s" : ""}, non détaillée{hidden > 1 ? "s" : ""} ici.
            </p>
          ) : null}
        </>
      )}
    </AdminPanel>
  );
}
