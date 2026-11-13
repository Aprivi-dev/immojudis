"use client";

import { useQuery } from "@tanstack/react-query";
import { AdminPanel, AdminSectionHeading } from "@/components/admin/AdminShell";
import type {
  AdminCatalogueQualityView,
  CeilingCoverageView,
  CrossSourceDuplicatesView,
} from "@/lib/admin-catalogue-quality";
import { apiRequest } from "@/lib/client-api-core";

// Vert sous le seuil, rouge au-dessus ; neutre pour une tendance ou une mesure absente.
const TONES: Record<string, string> = {
  ok: "bg-success-tint text-success",
  alert: "bg-danger-tint text-danger",
};

export const CATALOGUE_QUALITY_QUERY_KEY = ["admin-catalogue-quality"] as const;

/**
 * Contrôles qualité du catalogue : mesures du dernier cliché quotidien de la sentinelle, seuils et alertes
 * `catalogue.quality.*` ouvertes. Tout arrive mis en forme par le serveur (`/api/admin/catalogue-quality`).
 */
export function AdminCatalogueQualityPanel() {
  const query = useQuery({
    queryKey: CATALOGUE_QUALITY_QUERY_KEY,
    queryFn: () => apiRequest<AdminCatalogueQualityView>("/api/admin/catalogue-quality"),
    staleTime: 60_000,
  });
  const view = query.data;
  const snapshot = view?.snapshot;

  return (
    <AdminPanel className="mt-6 p-5">
      <AdminSectionHeading
        title="Contrôles qualité du catalogue"
        description="Ventes en ligne : cliché quotidien de la sentinelle et alertes ouvertes."
      />
      {query.isPending ? (
        <p className="mt-3 text-sm text-brand-navy/70">Chargement des contrôles…</p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          Contrôles indisponibles. Réessayez avec Actualiser.
        </p>
      ) : null}
      {view && !snapshot ? (
        <p className="mt-3 text-sm text-brand-navy/70">Aucun cliché pour l’instant.</p>
      ) : null}
      {snapshot ? (
        <>
          <p className={`mt-3 text-sm ${snapshot.isToday ? "text-brand-navy/70" : "text-warning"}`}>
            {snapshot.title} · {snapshot.liveSales} ventes en ligne
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">Contrôles qualité du catalogue</caption>
              <thead className="text-xs font-semibold text-brand-navy/62">
                <tr>
                  <th>Contrôle</th>
                  <th>Nombre</th>
                  <th>Seuil</th>
                  <th>État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-navy/10">
                {snapshot.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className="py-2 pr-3 font-medium text-foreground">
                      {row.label}
                      {row.note ? (
                        <span className="block text-xs font-normal text-brand-navy/62">
                          {row.note}
                        </span>
                      ) : null}
                    </th>
                    <td className="py-2 pr-3 tabular-nums">{row.count}</td>
                    <td className="py-2 pr-3 text-brand-navy/70">{row.threshold}</td>
                    <td className="py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${TONES[row.state] ?? "bg-brand-navy/[0.06]"}`}
                      >
                        {row.stateLabel}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {view ? <CeilingCoverage coverage={view.ceilingCoverage ?? null} /> : null}
      {view ? <CrossSourceDuplicates duplicates={view.crossSourceDuplicates ?? null} /> : null}
      {view ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-brand-navy">Alertes qualité ouvertes</h3>
          {view.alerts.length === 0 ? (
            <p className="mt-1 text-sm text-brand-navy/70">Aucune alerte qualité ouverte.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {view.alerts.map((alert) => (
                <li key={alert.key} className="rounded-lg bg-danger-tint px-3 py-2 text-danger">
                  <strong>{alert.label}</strong> : {alert.detail}
                  <span className="block text-xs">{alert.seen}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </AdminPanel>
  );
}

/**
 * Part des ventes à venir dont l'enchère plafond est calculable, par type de vente, avec le motif d'échec le plus
 * fréquent (P7), à côté de la part des logements sans surface suivie par la sentinelle.
 */
function CeilingCoverage({ coverage }: { coverage: CeilingCoverageView | null }) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-brand-navy">
        Enchère plafond calculable (ventes à venir)
      </h3>
      {coverage ? (
        <>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">
                Part des ventes à venir dont le plafond est calculable
              </caption>
              <thead className="text-xs font-semibold text-brand-navy/62">
                <tr>
                  <th>Type de vente</th>
                  <th>Ventes à venir</th>
                  <th>Plafond calculable</th>
                  <th>Motif d’échec principal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-navy/10">
                {[...coverage.rows, coverage.total].map((row) => (
                  <tr key={row.key} className={row.key === "total" ? "font-semibold" : undefined}>
                    <th scope="row" className="py-2 pr-3 font-medium text-foreground">
                      {row.label}
                    </th>
                    <td className="py-2 pr-3 tabular-nums">{row.upcoming}</td>
                    <td className="py-2 pr-3 tabular-nums">{row.computable}</td>
                    <td className="py-2 text-brand-navy/70">{row.mainFailure ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs text-brand-navy/62">{coverage.note}</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-brand-navy/70">
          Mesure indisponible : aucune évaluation de vente à venir lue.
        </p>
      )}
    </div>
  );
}

/** Doublons entre sources encore au catalogue (D12) : affichage seulement, la fusion reste coupée. */
function CrossSourceDuplicates({ duplicates }: { duplicates: CrossSourceDuplicatesView | null }) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-brand-navy">Doublons entre sources</h3>
      {duplicates ? (
        <>
          <p className="mt-1 text-sm">
            <span className="tabular-nums">{duplicates.groups}</span> groupes,{" "}
            <span className="tabular-nums">{duplicates.lines}</span> lignes concernées ·{" "}
            <span className="text-brand-navy/70">{duplicates.threshold}</span>{" "}
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${TONES[duplicates.state] ?? "bg-brand-navy/[0.06]"}`}
            >
              {duplicates.stateLabel}
            </span>
          </p>
          <p className="mt-1 text-sm">
            Groupes à trois sources ou plus :{" "}
            <span className="tabular-nums">{duplicates.threeSourceGroups}</span>
          </p>
          {duplicates.threeSourceExamples.length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-xs text-brand-navy/70">
              {duplicates.threeSourceExamples.map((example) => (
                <li key={example}>{example}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-xs text-brand-navy/62">{duplicates.note}</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-brand-navy/70">
          Mesure indisponible : la fonction de lecture n’est pas encore déployée et l’alerte ne
          s’est jamais ouverte.
        </p>
      )}
    </div>
  );
}
