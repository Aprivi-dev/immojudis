"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { AdminSaleFeedbackPanel } from "@/components/admin/AdminSaleFeedbackPanel";
import { AdminPanel, AdminSectionHeading, AdminShell } from "@/components/admin/AdminShell";
import { useAuth } from "@/hooks/use-auth";
import type { AdminPepitesView, PepitesViewCell } from "@/lib/admin-pepites-view";
import { authHeaders, readJson } from "@/lib/client-api-core";

/**
 * Page des pépites : un afficheur de sections préparées par le serveur (`buildAdminPepitesView`). Rien
 * n'est calculé ici, pour garder le JavaScript du navigateur au plus juste (budget de build).
 */
export function AdminPepitesPage() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ["admin-pepites"],
    queryFn: async () =>
      readJson<AdminPepitesView>(
        await fetch("/api/admin/pepites", {
          signal: AbortSignal.timeout(30_000),
          headers: await authHeaders(),
          cache: "no-store",
        }),
      ),
    staleTime: 60_000,
  });

  // Arrêt d'urgence : « on » vers « shadow » seulement, jamais l'inverse (la base le refuse aussi).
  const suspend = useMutation({
    mutationFn: async () =>
      readJson<{ mode: string }>(
        await fetch("/api/admin/pepites", {
          method: "POST",
          headers: { ...(await authHeaders()), "content-type": "application/json" },
          body: JSON.stringify({ mode: "shadow" }),
        }),
      ),
    onSuccess: () => void query.refetch(),
  });

  return (
    <AdminShell
      activeSection="pepites"
      title="Pépites"
      description="Règle des pépites : contrôle des résultats sur le catalogue réel avant toute publication."
      adminEmail={user?.email}
      onRefresh={() => void query.refetch()}
      isRefreshing={query.isFetching}
    >
      <div className="max-w-6xl space-y-6">
        {query.isPending ? <p role="status">Chargement des pépites…</p> : null}
        {query.isError ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/25 bg-danger-tint p-4 text-sm text-danger"
          >
            {query.error.message || "Pépites indisponibles"}{" "}
            <button
              type="button"
              className="admin-button-secondary"
              onClick={() => void query.refetch()}
            >
              Réessayer
            </button>
          </p>
        ) : null}
        {query.data?.canSuspend ? (
          <p>
            <button
              type="button"
              className="admin-button-secondary"
              disabled={suspend.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Repasser les pépites en mode shadow : elles ne seront plus visibles du public. Continuer ?",
                  )
                )
                  suspend.mutate();
              }}
            >
              Suspendre les pépites
            </button>
            {suspend.isError ? (
              <span role="alert" className="ml-3 text-sm text-danger">
                {suspend.error.message || "Pépites non suspendues"}
              </span>
            ) : null}
          </p>
        ) : null}
        {query.data?.sections.map((section) => (
          <AdminPanel key={section.id} className="p-5">
            <AdminSectionHeading title={section.title} />
            {section.paragraphs.map((text) => (
              <p key={text} className="mt-2 text-sm leading-6 text-brand-navy/70">
                {text}
              </p>
            ))}
            {section.alert ? (
              <p
                role="alert"
                className="mt-3 rounded-lg border border-danger/25 bg-danger-tint p-3 text-sm text-danger"
              >
                {section.alert}
              </p>
            ) : null}
            {section.table ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <caption className="sr-only">{section.table.caption}</caption>
                  <thead>
                    <tr className="border-b border-brand-navy/12 text-xs uppercase text-brand-navy/70">
                      {section.table.head.map((label) => (
                        <th key={label} scope="col" className="px-2 py-2 font-semibold">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.table.rows.map((cells, index) => (
                      <tr key={index} className="border-b border-brand-navy/8 align-top">
                        {cells.map((cell, column) =>
                          column === 0 ? (
                            <th key={column} scope="row" className="px-2 py-2 font-medium">
                              <Cell cell={cell} />
                            </th>
                          ) : (
                            <td key={column} className="px-2 py-2 tabular-nums">
                              <Cell cell={cell} />
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </AdminPanel>
        ))}
        <AdminSaleFeedbackPanel
          signals={["pepite"]}
          title="Retours « Pas pertinent » sur le repère Pépite, par vente"
        />
        <p className="mt-2 text-sm leading-6 text-brand-navy/70">
          Les retours sont rattachés à la version de règle en vigueur au moment de la lecture, pas à
          celle du clic.
        </p>
      </div>
    </AdminShell>
  );
}

function Cell({ cell }: { cell: PepitesViewCell }) {
  const text = cell.h ? (
    <a className="underline" href={cell.h}>
      {cell.t}
    </a>
  ) : (
    cell.t
  );
  const items = [...(cell.bad ?? []), ...(cell.l ?? [])];
  return (
    <>
      {cell.l || cell.bad ? (
        <details>
          <summary className="cursor-pointer">{text}</summary>
          <ul className="mt-1 list-disc pl-4 text-xs">
            {items.map((item) => (
              <li key={item} className={item.startsWith("Manqué") ? "text-danger" : undefined}>
                {item}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        text
      )}
      {cell.s ? <span className="block text-xs text-brand-navy/70">{cell.s}</span> : null}
    </>
  );
}
