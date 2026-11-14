"use client";

import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { AdminPanel } from "@/components/admin/AdminShell";
import { formatInteger, queryErrorMessage, runStatusLabel } from "@/components/admin/admin-format";
import { AdminPill } from "@/components/admin/admin-pill";

export function AdminPanelLoading({ label }: { label: string }) {
  return (
    <AdminPanel className="flex min-h-36 items-center justify-center p-6 text-sm text-brand-navy/60">
      <span role="status">Chargement de {label}…</span>
    </AdminPanel>
  );
}

export function AdminQueryErrorNotice({
  className = "",
  error,
  fallback,
  hasData,
  isRetrying,
  onRetry,
}: {
  className?: string;
  error: unknown;
  fallback: string;
  hasData: boolean;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      className={`rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 ${className}`}
      role="alert"
    >
      <div>
        {hasData
          ? "Actualisation impossible. Les dernières données reçues restent affichées."
          : queryErrorMessage(error, fallback)}
      </div>
      <button
        type="button"
        className="admin-button-secondary mt-3"
        disabled={isRetrying}
        onClick={onRetry}
      >
        {isRetrying ? "Nouvelle tentative…" : "Réessayer"}
      </button>
    </div>
  );
}
export function OverviewMetric({
  icon,
  value,
  label,
  tone = "blue",
}: {
  icon: React.ReactElement;
  value: string;
  label: string;
  tone?: "blue" | "green" | "copper";
}) {
  const iconTone =
    tone === "green" ? "text-emerald-700" : tone === "copper" ? "text-gold-text" : "text-info";
  return (
    <div className="flex min-h-24 items-center gap-4 px-5 py-4">
      <span className={`${iconTone} [&>svg]:size-7`}>{icon}</span>
      <span>
        <strong className="block text-2xl font-semibold tabular-nums text-brand-navy">
          {value}
        </strong>
        <span className="mt-0.5 block text-sm text-brand-navy/62">{label}</span>
      </span>
    </div>
  );
}

export function PipelineStat({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number | null;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-4 text-sm">
      <span className="text-brand-navy/68">{label}</span>
      <strong className={`text-xl tabular-nums ${danger ? "text-red-600" : "text-info"}`}>
        {value == null ? "—" : formatInteger(value)}
      </strong>
    </div>
  );
}

/** Statut d'une exécution du pipeline. */
export function StatusPill({ status }: { status: string }) {
  const tone =
    status === "succeeded"
      ? "success"
      : status === "failed"
        ? "danger"
        : status === "running"
          ? "info"
          : "warning";
  return <AdminPill tone={tone}>{runStatusLabel(status)}</AdminPill>;
}

export function EmptyState({ label }: { label: string }) {
  return <p className="text-sm text-muted-foreground">{label}</p>;
}

/**
 * Bouton « Actualiser » d'une vue : ne relance que les requêtes actives dont la première clé figure
 * dans `queryKeys` (jamais celles d'une autre vue, ni un éditeur qui perdrait un brouillon).
 */
export function useAdminRefresh(queryKeys: readonly string[]) {
  const queryClient = useQueryClient();
  const predicate = (query: { queryKey: readonly unknown[] }) =>
    queryKeys.includes(String(query.queryKey[0]));
  const fetching = useIsFetching({ type: "active", predicate });
  return {
    isRefreshing: fetching > 0,
    refresh: () => queryClient.refetchQueries({ type: "active", predicate }),
  };
}
