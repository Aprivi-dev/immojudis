"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {
  deleteSaleAnalysisSet,
  disableSaleComparisonShare,
  enableSaleComparisonShare,
  fetchSaleAnalysisSets,
} from "@/lib/client-api";
import { formatDate, formatPrice } from "@/lib/format";
import type {
  SaleAnalysisItem,
  SaleAnalysisSet,
  SaleAnalysisSetListResponse,
  SaleComparisonShareResponse,
} from "@/lib/sale-analysis-sets";

const DECISION_STATUS_LABELS: Record<SaleAnalysisItem["decision_status"], string> = {
  watching: "À surveiller",
  shortlisted: "Présélectionné",
  bid_ready: "Prêt à enchérir",
  rejected: "Écarté",
  won: "Gagné",
  lost: "Perdu",
};

export function ComparisonsPage() {
  const { user, loading } = useAuth();

  if (loading || !user) return null;
  return <AccountComparisons key={user.id} userId={user.id} />;
}

function AccountComparisons({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["sale-analysis-sets", userId] as const;
  const [shareLinks, setShareLinks] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchSaleAnalysisSets(),
    staleTime: 60_000,
    retry: false,
  });

  const shareMutation = useMutation({
    mutationFn: (setId: string) => enableSaleComparisonShare({ setId }),
    onSuccess: async (response, setId) => {
      if (!response.url) {
        setNotice("Le lien de partage n’a pas pu être généré.");
        return;
      }
      setShareLinks((current) => ({ ...current, [setId]: response.url! }));
      const copied = await copyToClipboard(response.url);
      setNotice(copied ? "Lien créé et copié dans le presse-papiers." : "Lien créé.");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => setNotice(errorMessage(error, "Partage impossible.")),
  });

  const unshareMutation = useMutation({
    mutationFn: (setId: string) => disableSaleComparisonShare({ setId }),
    onSuccess: async (response, setId) => {
      applyShareResponse(setShareLinks, setId, response);
      setNotice("Lien de partage désactivé.");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => setNotice(errorMessage(error, "Désactivation impossible.")),
  });

  const deleteMutation = useMutation({
    mutationFn: (setId: string) => deleteSaleAnalysisSet({ setId }),
    onSuccess: async (_response, setId) => {
      setShareLinks((current) => {
        const next = { ...current };
        delete next[setId];
        return next;
      });
      setNotice("Comparaison supprimée.");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => setNotice(errorMessage(error, "Suppression impossible.")),
  });

  const comparisons = query.data?.sets.filter((set) => set.analysis_kind === "comparison") ?? [];
  const busy = shareMutation.isPending || unshareMutation.isPending || deleteMutation.isPending;

  return (
    <main className="liquid-page min-h-screen px-4 pb-16 pt-28 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gold">
            Espace personnel
          </p>
          <h1 className="mt-3 font-display text-4xl leading-tight text-foreground sm:text-5xl">
            Mes comparaisons
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
            Retrouvez les biens que vous avez rapprochés dans le catalogue, consultez le détail de
            chaque annonce et partagez une comparaison avec un proche ou votre conseil.
          </p>
          <Link
            href="/sales"
            className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-gold-soft px-4 py-3 text-sm font-bold text-white transition hover:bg-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            Comparer d’autres biens
          </Link>
        </header>

        {notice ? (
          <p
            role="status"
            className="mt-5 rounded-lg border border-gold/25 bg-gold/10 px-4 py-3 text-sm text-foreground"
          >
            {notice}
          </p>
        ) : null}

        {query.isPending ? (
          <p role="status" className="mt-10 text-sm text-muted-foreground">
            Chargement de vos comparaisons…
          </p>
        ) : null}

        {query.isError ? (
          <div role="alert" className="liquid-panel mt-10 max-w-xl rounded-xl p-5">
            <h2 className="font-display text-2xl text-foreground">Comparaisons indisponibles</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {errorMessage(query.error, "Impossible de charger vos comparaisons.")}
            </p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-gold/40 px-4 py-2 text-sm font-bold text-gold-soft transition hover:bg-gold/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              Réessayer
            </button>
          </div>
        ) : null}

        {query.data && comparisons.length === 0 ? (
          <section className="liquid-panel mt-10 max-w-2xl rounded-xl p-6" aria-live="polite">
            <h2 className="font-display text-2xl text-foreground">
              Aucune comparaison enregistrée
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Sélectionnez deux ou trois biens dans le catalogue, puis choisissez « Enregistrer »
              dans le comparateur pour les retrouver ici.
            </p>
            <Link href="/sales" className="mt-5 inline-flex font-bold text-gold-soft underline">
              Ouvrir le catalogue
            </Link>
          </section>
        ) : null}

        {query.data && comparisons.length > 0 ? (
          <section className="mt-10" aria-label="Comparaisons enregistrées">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-display text-3xl text-foreground">Vos dossiers de comparaison</h2>
              <p className="text-sm text-muted-foreground">
                {comparisonCountLabel(comparisons.length, query.data)}
              </p>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              {comparisons.map((set) => (
                <ComparisonCard
                  key={set.id}
                  set={set}
                  busy={busy}
                  shareUrl={shareLinks[set.id] ?? null}
                  onShare={() => shareMutation.mutate(set.id)}
                  onUnshare={() => unshareMutation.mutate(set.id)}
                  onDelete={() => {
                    if (window.confirm(`Supprimer « ${set.name} » ?`)) {
                      deleteMutation.mutate(set.id);
                    }
                  }}
                  onCopy={async () => {
                    const url = shareLinks[set.id];
                    if (!url) return;
                    const copied = await copyToClipboard(url);
                    setNotice(
                      copied
                        ? "Lien copié dans le presse-papiers."
                        : "Copie automatique indisponible.",
                    );
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function ComparisonCard({
  set,
  busy,
  shareUrl,
  onShare,
  onUnshare,
  onDelete,
  onCopy,
}: {
  set: SaleAnalysisSet;
  busy: boolean;
  shareUrl: string | null;
  onShare: () => void;
  onUnshare: () => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const titleId = `comparison-${set.id}`;
  const { summary } = set;

  return (
    <article className="liquid-panel rounded-xl p-5" aria-labelledby={titleId}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={titleId} className="font-display text-2xl text-foreground">
            {set.name}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Mise à jour le {formatDate(set.updated_at)} · {summary.itemCount} bien(s)
          </p>
        </div>
        {set.sharing.enabled ? (
          <span className="rounded-full border border-emerald-600/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-800">
            Lien actif jusqu’au {formatDate(set.sharing.expiresAt)}
          </span>
        ) : null}
      </header>

      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Metric label="Mises à prix" value={formatPrice(summary.totalStartingPriceEur)} />
        <Metric label="Plafonds saisis" value={formatPrice(summary.totalUserMaxBidEur)} />
        <Metric
          label="Score moyen"
          value={
            summary.averageInvestmentScore == null ? "—" : `${summary.averageInvestmentScore}/100`
          }
        />
        <Metric label="Première audience" value={formatDate(summary.earliestSaleDate)} />
      </dl>

      {summary.cities.length ? (
        <p className="mt-4 text-xs text-muted-foreground">Communes : {summary.cities.join(", ")}</p>
      ) : null}

      <ul className="mt-5 space-y-3" aria-label={`Biens de ${set.name}`}>
        {set.items.map((item) => (
          <ComparisonItem key={item.id} item={item} />
        ))}
      </ul>

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
        <button
          type="button"
          onClick={onShare}
          disabled={busy}
          className="inline-flex min-h-10 items-center rounded-lg bg-gold-soft px-3 py-2 text-xs font-bold text-white transition hover:bg-gold disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        >
          {set.sharing.enabled ? "Générer un nouveau lien" : "Créer un lien de partage"}
        </button>
        {set.sharing.enabled ? (
          <button
            type="button"
            onClick={onUnshare}
            disabled={busy}
            className="inline-flex min-h-10 items-center rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground transition hover:border-gold/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            Désactiver le lien
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="ml-auto inline-flex min-h-10 items-center rounded-lg px-3 py-2 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
        >
          Supprimer
        </button>
      </div>

      {shareUrl ? (
        <div className="mt-4 rounded-lg border border-emerald-600/25 bg-emerald-500/5 p-3">
          <p className="text-sm font-semibold text-foreground">Lien public prêt à être ouvert</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-10 items-center rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              Ouvrir le partage
            </a>
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex min-h-10 items-center rounded-lg border border-emerald-700/30 px-3 py-2 text-xs font-bold text-emerald-800 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              Copier le lien
            </button>
          </div>
        </div>
      ) : set.sharing.enabled ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Un lien existe déjà. Générez un nouveau lien pour l’ouvrir depuis cet appareil.
        </p>
      ) : null}
    </article>
  );
}

function ComparisonItem({ item }: { item: SaleAnalysisItem }) {
  const sale = item.sale;
  const saleLabel = sale
    ? [sale.title, [sale.city, sale.department].filter(Boolean).join(" · ")]
        .filter(Boolean)
        .join(" — ")
    : "Annonce indisponible";

  return (
    <li className="rounded-lg border border-border/70 bg-white/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {sale ? (
            <Link
              href={`/sales/${sale.id}`}
              className="font-semibold text-foreground underline decoration-gold/60 underline-offset-2 hover:text-gold-soft"
            >
              {saleLabel}
            </Link>
          ) : (
            <p className="font-semibold text-muted-foreground">{saleLabel}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {sale?.saleDate ? `Audience : ${formatDate(sale.saleDate)}` : "Audience à confirmer"}
            {item.decision_status ? ` · ${DECISION_STATUS_LABELS[item.decision_status]}` : ""}
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>Mise à prix : {formatPrice(sale?.startingPriceEur)}</p>
          {item.user_max_bid_eur != null ? (
            <p className="mt-1 font-semibold text-foreground">
              Plafond : {formatPrice(item.user_max_bid_eur)}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-white/50 px-3 py-2">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function comparisonCountLabel(count: number, data: SaleAnalysisSetListResponse) {
  const countText = `${count} comparaison${count > 1 ? "s" : ""}`;
  if (data.limit == null) return `${countText} enregistrée${count > 1 ? "s" : ""}`;
  return `${countText} sur ${data.limit} disponible${data.limit > 1 ? "s" : ""}`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function applyShareResponse(
  setShareLinks: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  setId: string,
  response: SaleComparisonShareResponse,
) {
  if (response.url) {
    setShareLinks((current) => ({ ...current, [setId]: response.url! }));
    return;
  }
  setShareLinks((current) => {
    const next = { ...current };
    delete next[setId];
    return next;
  });
}

async function copyToClipboard(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
