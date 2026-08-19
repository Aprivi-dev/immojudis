"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import {
  TribunalStatisticsDashboard,
  TRIBUNAL_STATISTICS_ACCESS_ERROR_MESSAGE,
  TRIBUNAL_STATISTICS_LOAD_ERROR_MESSAGE,
  type TribunalStatisticsWindowMonths,
} from "@/components/TribunalStatisticsDashboard";
import { PremiumPreview } from "@/components/PremiumPreview";
import { useAuth } from "@/hooks/use-auth";
import { fetchFeatureEntitlements } from "@/lib/client-api";
import { createFileRoute } from "@/lib/router-compat";
import { fetchTribunalStatistics } from "@/lib/tribunal-statistics-client";

export const Route = createFileRoute("/tribunaux")({
  head: () => ({
    meta: [
      { title: "Statistiques par tribunal — Immojudis" },
      {
        name: "description",
        content:
          "Statistiques descriptives par tribunal avec couverture, échantillons et niveau de fiabilité visibles.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: TribunalsPage,
});

export function TribunalsPage() {
  const [windowMonths, setWindowMonths] = useState<TribunalStatisticsWindowMonths>(36);
  const { user, loading: authLoading } = useAuth();
  const entitlementsQuery = useQuery({
    queryKey: ["feature-entitlements", user?.id ?? "anonymous"],
    queryFn: fetchFeatureEntitlements,
    enabled: Boolean(user) && !authLoading,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const hasAccess = entitlementsQuery.data?.plan.features.salesStatistics === "included";
  const statisticsQuery = useQuery({
    queryKey: ["tribunal-statistics", user?.id ?? "anonymous", windowMonths],
    queryFn: () => fetchTribunalStatistics({ windowMonths }),
    enabled:
      Boolean(user) &&
      !authLoading &&
      !entitlementsQuery.isLoading &&
      !entitlementsQuery.isError &&
      hasAccess,
    retry: false,
    staleTime: 2 * 60_000,
  });

  if (authLoading || (user && entitlementsQuery.isLoading)) {
    return (
      <TribunalStatisticsDashboard
        isLoading
        windowMonths={windowMonths}
        onWindowMonthsChange={setWindowMonths}
      />
    );
  }

  if (entitlementsQuery.isError) {
    return (
      <TribunalStatisticsDashboard
        error={new Error(TRIBUNAL_STATISTICS_ACCESS_ERROR_MESSAGE)}
        windowMonths={windowMonths}
        onWindowMonthsChange={setWindowMonths}
        onRetry={() => void entitlementsQuery.refetch()}
      />
    );
  }

  if (!hasAccess) {
    return <LockedTribunalStatisticsPreview />;
  }

  return (
    <TribunalStatisticsDashboard
      data={statisticsQuery.data}
      error={statisticsQuery.error ? new Error(TRIBUNAL_STATISTICS_LOAD_ERROR_MESSAGE) : null}
      isLoading={statisticsQuery.isLoading}
      windowMonths={windowMonths}
      onWindowMonthsChange={setWindowMonths}
      onRetry={() => void statisticsQuery.refetch()}
    />
  );
}

function LockedTribunalStatisticsPreview() {
  return (
    <main className="min-h-screen bg-[#eef7ff] px-4 py-10 text-brand-navy sm:px-6 lg:px-8 lg:py-14">
      <div className="mx-auto max-w-[1260px]">
        <header>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
            <Landmark className="h-4 w-4" aria-hidden />
            Outil Analyse
          </p>
          <h1 className="mt-3 max-w-4xl font-display text-4xl font-medium leading-tight sm:text-5xl lg:text-6xl">
            Statistiques par tribunal
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-brand-navy/68 sm:text-base">
            Consultez les historiques vérifiés avec leur couverture, leurs échantillons et leurs
            limites. Le détail est réservé au plan Analyse.
          </p>
        </header>

        <p className="mt-8 text-xs font-semibold uppercase tracking-[0.12em] text-brand-navy/55">
          L’aperçu flouté ci-dessous est une démonstration entièrement fictive.
        </p>

        <PremiumPreview
          title="Statistiques tribunal réservées au plan Analyse"
          description="Débloquez les taux observés et ajustés, les volumes connus et la référence nationale."
          className="mt-3 border-brand-navy/12 bg-white"
        >
          <div className="space-y-6" data-preview-kind="strictly-fictional">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-navy/55">
              Démonstration fictive — aucune donnée réelle
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <PreviewValue icon={ShieldCheck} label="Couverture connue" value="78 %" />
              <PreviewValue icon={BarChart3} label="Audience tenue" value="64 %" />
              <PreviewValue icon={Landmark} label="Observations" value="42" />
            </div>
            <div className="overflow-hidden rounded-md border border-brand-navy/10">
              {["Audience tenue", "Report", "Annulation"].map((label, index) => (
                <div
                  key={label}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-5 border-b border-brand-navy/10 px-4 py-3 text-sm last:border-b-0"
                >
                  <span className="font-semibold">{label}</span>
                  <span className="tabular-nums">{["64 %", "21 %", "9 %"][index]}</span>
                  <span className="font-semibold tabular-nums text-gold-soft">
                    {["61 %", "23 %", "11 %"][index]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </PremiumPreview>
      </div>
    </main>
  );
}

function PreviewValue({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Landmark;
  label: string;
  value: string;
}) {
  return (
    <div className="border-y border-brand-navy/12 py-4">
      <Icon className="h-5 w-5 text-gold-soft" aria-hidden />
      <p className="mt-3 text-xs text-brand-navy/60">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
