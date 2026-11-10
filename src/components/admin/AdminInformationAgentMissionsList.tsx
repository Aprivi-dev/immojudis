"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { missionsQuery } from "@/components/admin/information-agent-queries";
import {
  isMissionEditable,
  missionStatusLabel,
} from "@/components/admin/information-agent-missions-ui";
import { ADMIN_PAGE_SIZE, adminClampOffset } from "@/lib/admin-pagination";
import { formatAdminDateTime as formatDateTime } from "@/lib/admin-date-format";
import type { InformationAgentMission } from "@/lib/information-agent";
import { saleDetailPath } from "@/lib/navigation";

/**
 * Onglet « Envois » : les missions et demandes, avec leur état. Ouvrir une ligne rend la main à
 * l'éditeur de l'onglet « À contacter » (`onOpenMission`), qui charge la fiche.
 */
export function AdminInformationAgentMissionsList({
  onOpenMission,
}: {
  onOpenMission: (mission: InformationAgentMission) => void;
}) {
  const [listOffset, setListOffset] = useState(0);
  const query = useQuery({
    ...missionsQuery(listOffset),
    placeholderData: keepPreviousData,
  });
  // Après traitement des dernières lignes d'une page, revient sur la dernière page non vide.
  useEffect(() => {
    const data = query.data;
    if (data && !data.missions.length && data.offset > 0) {
      setListOffset(adminClampOffset(data.offset, data.limit, data.total));
    }
  }, [query.data]);

  return (
    <section className="overflow-hidden rounded-xl border bg-white">
      <div className="p-5">
        <h2 className="text-sm font-semibold">Missions récentes</h2>
        <p className="mt-1 text-xs text-brand-navy/60">
          Brouillons, demandes envoyées et réponses. Un brouillon ou un échec se reprend dans
          l’onglet « À contacter » ; les autres s’ouvrent en lecture seule.
        </p>
        {query.isPending ? (
          <p className="mt-3 text-sm text-brand-navy/55">Chargement…</p>
        ) : query.error ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {query.error instanceof Error ? query.error.message : "Missions indisponibles"}
          </p>
        ) : query.data?.missions.length ? (
          <div className="mt-3 divide-y rounded-lg border">
            {query.data.missions.map((mission) => (
              <div
                key={mission.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  {mission.saleId ? (
                    <p className="truncate font-medium">
                      <Link
                        href={saleDetailPath(mission.saleId)}
                        className="underline-offset-2 hover:underline"
                      >
                        {mission.saleTitle || "Annonce sans titre"}
                      </Link>
                    </p>
                  ) : null}
                  <p
                    className={`truncate ${mission.saleId ? "text-xs text-brand-navy/70" : "font-medium"}`}
                  >
                    {mission.recipientEmail}
                  </p>
                  <p className="mt-0.5 text-xs text-brand-navy/50">
                    {missionStatusLabel(mission.status)} · {formatDateTime(mission.updatedAt)}
                  </p>
                  {mission.status === "failed" && mission.failureReason ? (
                    <p
                      className={`mt-0.5 line-clamp-2 text-xs ${
                        mission.sendOutcome === "unverified" ? "text-amber-900" : "text-red-800"
                      }`}
                    >
                      {mission.sendOutcome === "unverified" ? "À vérifier : " : ""}
                      {mission.failureReason}
                    </p>
                  ) : null}
                </div>
                {/* Un brouillon ou un échec se reprend ; tout autre statut s'ouvre en lecture seule
                    (seul le formulaire de réponse consignée reste actif pour envoyée / répondue). */}
                <button
                  type="button"
                  className="admin-button-secondary"
                  onClick={() => onOpenMission(mission)}
                >
                  {isMissionEditable(mission.status) ? "Reprendre" : "Ouvrir"}
                </button>
              </div>
            ))}
            <AdminPagination
              label="missions récentes"
              offset={query.data.offset ?? 0}
              limit={query.data.limit ?? ADMIN_PAGE_SIZE}
              total={query.data.total ?? query.data.missions.length}
              shown={query.data.missions.length}
              busy={query.isFetching}
              onOffsetChange={setListOffset}
              className="!px-3"
            />
          </div>
        ) : (
          <p className="mt-3 text-sm text-brand-navy/55">Aucune mission.</p>
        )}
      </div>
    </section>
  );
}
