"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AdminPanel, AdminSectionHeading } from "@/components/admin/AdminShell";
import { formatDateTime, queryErrorMessage } from "@/components/admin/admin-format";
import type { SaleFeedbackBySale } from "@/lib/admin-sale-signal-feedback";
import { authHeaders, readJson } from "@/lib/client-api-core";
import { saleDetailPath } from "@/lib/navigation";
import {
  SALE_SIGNAL_REASON_LABELS,
  type SaleSignal,
  type SaleSignalReason,
} from "@/lib/sale-signal-feedback";

const SIGNAL_LABELS: Record<SaleSignal, string> = {
  market_gap_band: "Écart au marché",
  points_to_verify: "Points à vérifier",
  pepite: "Repère Pépite",
};

/** Motif d'un retour « Pas pertinent » : sa phrase, ou « Sans motif ». */
export function saleFeedbackReasonLabel(reason: string): string {
  if (reason === "none") return "Sans motif";
  return SALE_SIGNAL_REASON_LABELS[reason as SaleSignalReason] ?? reason;
}

/**
 * Retours « Pas pertinent » par vente, signal et motif (90 jours) : où corriger. Un nombre par ligne, jamais un
 * compte ni un texte libre. Les nombres sont exacts : ils désignent une vente, pas une personne.
 */
export function AdminSaleFeedbackPanel({
  signals,
  title,
}: {
  /** Les signaux listés ici ; les autres le sont sur l'autre page. */
  signals: readonly SaleSignal[];
  title: string;
}) {
  const query = useQuery({
    queryKey: ["admin-sale-feedback"],
    queryFn: async () =>
      readJson<SaleFeedbackBySale>(
        await fetch("/api/admin/sale-feedback", {
          signal: AbortSignal.timeout(30_000),
          headers: await authHeaders(),
          cache: "no-store",
        }),
      ),
    staleTime: 60_000,
  });
  const rows = (query.data?.rows ?? []).filter((row) => signals.includes(row.signal));
  const showVersion = signals.includes("pepite");

  return (
    <AdminPanel className="p-5">
      <AdminSectionHeading title={title} />
      <p className="mt-1 text-sm text-brand-navy/70">
        Retours « Pas pertinent » des comptes connectés sur les {query.data?.windowDays ?? 90}{" "}
        derniers jours, par vente. Un nombre par ligne : aucun compte n’est affiché.
      </p>
      {query.isPending ? (
        <p className="mt-3 text-sm text-brand-navy/70">Chargement des retours par vente…</p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {queryErrorMessage(query.error, "Retours par vente indisponibles")}
        </p>
      ) : null}
      {query.data && !query.data.measured ? (
        <p className="mt-3 text-sm text-brand-navy/70">non mesuré (migration non appliquée)</p>
      ) : null}
      {query.data?.measured && rows.length === 0 ? (
        <p className="mt-3 text-sm text-brand-navy/70">Aucun retour négatif sur la période.</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="border-b border-brand-navy/12 text-xs uppercase text-brand-navy/70">
                <th scope="col" className="px-2 py-2 font-semibold">
                  Vente
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Signal
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Motif
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Retours
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Dernier
                </th>
                {showVersion ? (
                  <th scope="col" className="px-2 py-2 font-semibold">
                    Version de la règle
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.saleId}:${row.signal}:${row.reason}`}
                  className="border-b border-brand-navy/8 align-top"
                >
                  <th scope="row" className="px-2 py-2 font-medium">
                    <Link className="underline" href={saleDetailPath(row.saleId)}>
                      {row.title || "Vente sans titre"}
                    </Link>
                    <span className="block text-xs font-normal text-brand-navy/70">
                      {[row.city, row.department].filter(Boolean).join(" · ")}
                    </span>
                  </th>
                  <td className="px-2 py-2">{SIGNAL_LABELS[row.signal]}</td>
                  <td className="px-2 py-2">{saleFeedbackReasonLabel(row.reason)}</td>
                  <td className="px-2 py-2 font-semibold tabular-nums">{row.count}</td>
                  <td className="px-2 py-2 tabular-nums">
                    {row.lastAt ? formatDateTime(row.lastAt) : "—"}
                  </td>
                  {showVersion ? <td className="px-2 py-2">{row.ruleVersion ?? "—"}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </AdminPanel>
  );
}
