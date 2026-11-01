"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPanel, AdminSectionHeading } from "@/components/admin/AdminShell";
import { Pill, queryProblem } from "@/components/admin/emails/email-ui";
import type { EmailListView } from "@/lib/admin-emails/views";

/**
 * Onglets « Adresses » et « Modèles » : un seul composant d'affichage pour des sections que le serveur
 * a déjà composées (libellés, couleurs, valeurs). `recheck` ajoute le bouton « Revérifier », qui
 * contourne le cache de 60 s du serveur.
 */
export function AdminEmailListTab({
  queryKey,
  loading,
  fetchView,
}: {
  queryKey: string;
  loading: string;
  fetchView: (refresh?: boolean) => Promise<EmailListView>;
}) {
  const queryClient = useQueryClient();
  const [rechecking, setRechecking] = useState(false);
  const query = useQuery({
    queryKey: [queryKey],
    queryFn: () => fetchView(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const problem = queryProblem(query, loading);
  if (problem || !query.data) return problem;
  const view = query.data;

  async function recheck() {
    setRechecking(true);
    try {
      queryClient.setQueryData([queryKey], await fetchView(true));
    } finally {
      setRechecking(false);
    }
  }

  return (
    <div className="space-y-5">
      {view.footnote ? (
        <AdminPanel className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-brand-navy/62">{view.footnote}</p>
          <button
            type="button"
            className="admin-button-secondary"
            disabled={rechecking}
            onClick={() => void recheck()}
          >
            {rechecking ? "Vérification…" : "Revérifier"}
          </button>
        </AdminPanel>
      ) : null}
      {view.alerts.length > 0 ? (
        <AdminPanel className="space-y-2 border-danger/30 bg-danger-tint p-4 text-danger">
          <h2 className="font-semibold">À corriger</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm" role="alert">
            {view.alerts.map((alert) => (
              <li key={alert}>{alert}</li>
            ))}
          </ul>
        </AdminPanel>
      ) : null}
      {view.sections.map((section) => (
        <AdminPanel key={section.title} className="space-y-3 p-5">
          <AdminSectionHeading title={section.title} description={section.description} />
          {section.notice ? (
            <p
              className={`text-sm ${section.notice.tone === "bad" ? "text-danger" : "text-warning"}`}
            >
              {section.notice.text}
            </p>
          ) : null}
          <ul className="divide-y divide-brand-navy/10 text-sm">
            {section.items.map((item) => (
              <li key={`${item.code}${item.title}`} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{item.title}</strong>
                  {item.code ? (
                    <code className="text-xs text-brand-navy/62">{item.code}</code>
                  ) : null}
                  {item.badges.map((badge) => (
                    <Pill key={badge.text} tone={badge.tone}>
                      {badge.text}
                    </Pill>
                  ))}
                </div>
                {item.lines.map((line) => (
                  <div
                    key={line.text}
                    className={`${line.mono ? "break-all font-mono text-xs" : "text-brand-navy/70"} ${line.bad ? "text-danger" : ""}`}
                  >
                    {line.text}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </AdminPanel>
      ))}
    </div>
  );
}
