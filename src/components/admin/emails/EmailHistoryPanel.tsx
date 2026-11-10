"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { AdminPanel } from "@/components/admin/AdminShell";
import { EmailMessageView } from "@/components/admin/emails/EmailMessageView";
import { Pill, queryProblem, toggle } from "@/components/admin/emails/email-ui";
import { fetchAdminEmailHistory } from "@/lib/client-api/admin-emails";

/**
 * Onglet « Historique » : envoyés et reçus, 50 lignes par page (curseur), recherche par adresse (exacte
 * ou début d'adresse). « Actualiser » relit chez Resend l'état des envois récents encore sans issue.
 * Le serveur compose toutes les lignes ; ce composant ne formate rien.
 */
export function EmailHistoryPanel() {
  const [box, setBox] = useState<"sent" | "received">("sent");
  const [typed, setTyped] = useState("");
  const [address, setAddress] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = useRef(false);
  const query = useInfiniteQuery({
    queryKey: ["admin-emails-history", box, address],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const refreshNow = refresh.current && !pageParam;
      refresh.current = false;
      return fetchAdminEmailHistory({ box, address, cursor: pageParam, refresh: refreshNow });
    },
    getNextPageParam: (last) => last.next ?? undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  const note = query.data?.pages[0]?.note;

  return (
    <div className="space-y-5">
      <AdminPanel className="flex flex-wrap items-center gap-3 p-4">
        {(["sent", "received"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={toggle(box === value)}
            onClick={() => (setBox(value), setOpenId(null))}
          >
            {value === "sent" ? "Envoyés" : "Reçus"}
          </button>
        ))}
        <form
          className="flex flex-1 flex-wrap items-center gap-2"
          onSubmit={(event) => (event.preventDefault(), setAddress(typed.trim()))}
        >
          <label className="admin-search">
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="Adresse ou début d’adresse"
              aria-label="Rechercher une adresse"
            />
          </label>
          <button type="submit" className="admin-button-secondary">
            Rechercher
          </button>
        </form>
        {box === "sent" ? (
          <button
            type="button"
            className="admin-button-secondary"
            disabled={query.isFetching}
            onClick={() => ((refresh.current = true), void query.refetch())}
          >
            {query.isFetching ? "Actualisation…" : "Actualiser"}
          </button>
        ) : null}
      </AdminPanel>
      {note ? <p className="text-sm text-warning">{note}</p> : null}
      {openId ? <EmailMessageView id={openId} onClose={() => setOpenId(null)} /> : null}
      {queryProblem(query, "Chargement de l’historique…") ?? (
        <AdminPanel className="p-2">
          {rows.length === 0 ? <p className="p-4 text-sm">Aucun email.</p> : null}
          <ul className="divide-y divide-brand-navy/10 text-sm">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="grid w-full gap-1 p-3 text-left hover:bg-surface-muted"
                  aria-pressed={openId === row.id}
                  onClick={() => setOpenId(row.id)}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-brand-navy/62">{row.at}</span>
                    <strong className="break-all">{row.who}</strong>
                    {row.status ? <Pill tone={row.status.tone}>{row.status.text}</Pill> : null}
                    {row.status?.detail ? (
                      <span className="text-xs text-brand-navy/62">{row.status.detail}</span>
                    ) : null}
                  </span>
                  <span>{row.subject}</span>
                  <span className="text-xs text-brand-navy/62">{row.tag}</span>
                </button>
              </li>
            ))}
          </ul>
          {query.hasNextPage ? (
            <button
              type="button"
              className="admin-button-secondary m-3"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Plus anciens
            </button>
          ) : null}
        </AdminPanel>
      )}
    </div>
  );
}
