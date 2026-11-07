"use client";

import Link from "next/link";
import { SaleDetailLink } from "@/components/SaleDetailLink";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, Notice, PageShell, buttonClasses } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import {
  deleteSaleAnalysisSet,
  disableSaleComparisonShare,
  enableSaleComparisonShare,
  fetchSaleAnalysisSets,
} from "@/lib/client-api";
import { formatDate, formatPrice, formatStartingPrice } from "@/lib/format";
import { userMessage } from "@/lib/user-messages";
import type {
  SaleAnalysisItem,
  SaleAnalysisSet,
  SaleAnalysisSetListResponse,
  SaleComparisonShareResponse,
} from "@/lib/sale-analysis-sets";
import * as queryKeys from "@/lib/query-keys";

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
  const queryKey = queryKeys.saleAnalysisSets(userId);
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
    <PageShell
      width="wide"
      eyebrow="Mon espace"
      title="Mes comparaisons"
      description="Retrouvez les biens que vous avez rapprochés dans le catalogue, consultez le détail de chaque annonce et partagez une comparaison avec un proche ou votre conseil."
      actions={
        <Link href="/sales" className={buttonClasses({ variant: "primary" })}>
          Comparer d’autres biens
        </Link>
      }
    >
      <div>
        {notice ? (
          <p
            role="status"
            className="mb-6 rounded-lg border border-gold/25 bg-gold/10 px-4 py-3 text-sm text-foreground"
          >
            {notice}
          </p>
        ) : null}

        {query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Chargement de vos comparaisons…
          </p>
        ) : null}

        {query.isError ? (
          <Card role="alert" className="max-w-xl">
            <h2 className="font-display text-2xl text-foreground">Comparaisons indisponibles</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {errorMessage(query.error, "Impossible de charger vos comparaisons.")}
            </p>
            <Button className="mt-4" onClick={() => void query.refetch()}>
              Réessayer
            </Button>
          </Card>
        ) : null}

        {query.data && comparisons.length === 0 ? (
          <Card as="section" className="max-w-2xl" aria-live="polite">
            <h2 className="font-display text-2xl text-foreground">
              Aucune comparaison enregistrée
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Sélectionnez deux ou trois biens dans le catalogue, puis choisissez « Enregistrer »
              dans le comparateur pour les retrouver ici.
            </p>
            <Link
              href="/sales"
              className="mt-3 inline-flex min-h-11 items-center font-bold text-gold-text underline"
            >
              Ouvrir le catalogue
            </Link>
          </Card>
        ) : null}

        {query.data && comparisons.length > 0 ? (
          <section aria-label="Comparaisons enregistrées">
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
    </PageShell>
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
    <Card as="article" aria-labelledby={titleId}>
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
          <Badge tone="success">Lien actif jusqu’au {formatDate(set.sharing.expiresAt)}</Badge>
        ) : null}
      </header>

      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Metric
          label="Mises à prix"
          value={formatStartingPrice(summary.totalStartingPriceEur)}
          note={partialTotalNote(summary)}
        />
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
        <Button variant="primary" onClick={onShare} disabled={busy}>
          {set.sharing.enabled ? "Générer un nouveau lien" : "Créer un lien de partage"}
        </Button>
        {set.sharing.enabled ? (
          <Button onClick={onUnshare} disabled={busy}>
            Désactiver le lien
          </Button>
        ) : null}
        <Button variant="danger" className="ml-auto" onClick={onDelete} disabled={busy}>
          Supprimer
        </Button>
      </div>

      {shareUrl ? (
        <Notice tone="success" className="mt-4">
          <p className="font-semibold">Lien public prêt à être ouvert</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses({ variant: "primary" })}
            >
              Ouvrir le partage
            </a>
            <Button onClick={onCopy}>Copier le lien</Button>
          </div>
        </Notice>
      ) : set.sharing.enabled ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Un lien existe déjà. Générez un nouveau lien pour l’ouvrir depuis cet appareil.
        </p>
      ) : null}
    </Card>
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
            <SaleDetailLink
              saleId={sale.id}
              returnTo="/comparaisons"
              className="font-semibold text-foreground underline decoration-gold/60 underline-offset-2 hover:text-gold-text"
            >
              {saleLabel}
            </SaleDetailLink>
          ) : (
            <p className="font-semibold text-muted-foreground">{saleLabel}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {sale?.saleDate ? `Audience : ${formatDate(sale.saleDate)}` : "Audience à confirmer"}
            {item.decision_status ? ` · ${DECISION_STATUS_LABELS[item.decision_status]}` : ""}
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>Mise à prix : {formatStartingPrice(sale?.startingPriceEur)}</p>
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

/** Un total de mises à prix qui n'additionne pas tous les biens le dit : il ne passe pas pour complet. */
function partialTotalNote(summary: SaleAnalysisSet["summary"]): string | null {
  if (summary.totalStartingPriceEur == null || summary.pricedItemCount >= summary.itemCount) {
    return null;
  }
  const priced = summary.pricedItemCount;
  return `Total partiel : ${priced} bien${priced > 1 ? "s" : ""} sur ${summary.itemCount}`;
}

function Metric({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div className="rounded-lg border border-border/70 bg-white/50 px-3 py-2">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 font-semibold tabular-nums text-foreground">{value}</dd>
      {note ? <dd className="mt-0.5 text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

function comparisonCountLabel(count: number, data: SaleAnalysisSetListResponse) {
  const countText = `${count} comparaison${count > 1 ? "s" : ""}`;
  if (data.limit == null) return `${countText} enregistrée${count > 1 ? "s" : ""}`;
  return `${countText} sur ${data.limit} disponible${data.limit > 1 ? "s" : ""}`;
}

function errorMessage(error: unknown, fallback: string) {
  return userMessage(error, fallback);
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
