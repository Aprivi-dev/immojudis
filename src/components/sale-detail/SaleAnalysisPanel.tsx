"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { FavoriteButton } from "@/components/FavoriteButton";
import { SaleCalendarButton } from "@/components/SaleCalendarButton";
import { SaleRemindersToggle } from "@/components/SaleRemindersToggle";
import { Button } from "@/components/ui/primitives";
import {
  CEILING_PROFILES,
  CEILING_PROJECTS,
  ceilingsByWorks,
  type CeilingHypotheses,
} from "@/lib/bid-ceiling-engine";
import { fetchSaleChangeEvents } from "@/lib/client-api";
import {
  FAVORITE_DOSSIER_STATUSES,
  favoriteDossierStatusLabel,
  normalizeFavoriteDossierStatus,
} from "@/lib/favorite-dossier-shared";
import { formatDate, formatPrice } from "@/lib/format";
import * as queryKeys from "@/lib/query-keys";
import {
  MAX_DISPLAYED_SALE_CHANGES,
  RECENT_SALE_CHANGE_DAYS,
  recentSaleChanges,
  saleChangeDetectedOn,
} from "@/lib/sale-change-display";
import type { PriceSummaryCeiling } from "./PriceSummaryCard";
import { useSaleDossier } from "./use-sale-dossier";
import styles from "./SaleAnalysisPanel.module.css";

/** « Habiter · Équilibré · sans travaux » : les hypothèses du plafond en une ligne. */
export function hypothesesSummary(h: CeilingHypotheses): string {
  const project = CEILING_PROJECTS.find((item) => item.key === h.project)?.label ?? null;
  const profile =
    h.customMarginPct != null
      ? `marge personnalisée ${h.customMarginPct} %`
      : (CEILING_PROFILES.find((item) => item.key === h.profile)?.label ?? null);
  const works =
    h.works.key === "aucun" || h.works.amount <= 0
      ? "sans travaux"
      : h.works.key === "devis"
        ? `travaux ${formatPrice(h.works.amount)}`
        : (ceilingsByWorks(h)
            .find((row) => row.key === h.works.key)
            ?.label.toLowerCase() ?? `travaux ${formatPrice(h.works.amount)}`);
  return [project, profile, works].filter(Boolean).join(" · ");
}

/**
 * Tête du panneau « Votre analyse » (offre Analyse) : l'enchère plafond en grand, son écart avec la
 * mise à prix (pastille verte ou rouge, dite en toutes lettres, sans conseil), les deux autres
 * montants et le résumé des hypothèses, avec un lien pour les modifier.
 */
export function AnalysisLead({
  label,
  ceiling,
  startLabel,
  startingPrice,
  value,
  hypotheses,
  modifyHref,
}: {
  label: ReactNode;
  ceiling: PriceSummaryCeiling | null;
  /** « Mise à prix », « Première offre possible », « Prix publié ». */
  startLabel: string;
  startingPrice: number | null;
  value: number | null;
  /** Le résumé des hypothèses ; absent sans plafond chiffré. */
  hypotheses: string | null;
  modifyHref: string;
}) {
  const startTerm = startLabel.toLowerCase();
  const gap = ceiling?.kind === "amount" ? (ceiling.startGap ?? null) : null;
  return (
    <div className={styles.lead}>
      <p className={styles.eyebrow}>Votre analyse</p>
      <p className={styles.label}>{label}</p>
      {ceiling?.kind === "amount" ? (
        <p className={styles.ceiling}>{formatPrice(ceiling.amount)}</p>
      ) : ceiling?.kind === "note" ? (
        <p className={styles.ceilingNote}>{ceiling.note}</p>
      ) : ceiling?.kind === "locked" ? (
        <p className={styles.note}>{ceiling.action}</p>
      ) : (
        <p className={styles.ceilingNote}>Non disponible pour cette vente</p>
      )}
      {gap != null ? (
        <p className={`${styles.gap} ${gap >= 0 ? styles.gapUp : styles.gapDown}`}>
          {gap > 0
            ? `+${formatPrice(gap)} par rapport à la ${startTerm}`
            : gap === 0
              ? `Égale à la ${startTerm}`
              : `${formatPrice(-gap)} sous la ${startTerm}, à ces hypothèses`}
        </p>
      ) : null}
      <p className={styles.note}>
        {startLabel}{" "}
        <span className="tabular-nums">
          {startingPrice != null ? formatPrice(startingPrice) : "à confirmer"}
        </span>
        {value != null ? (
          <>
            {" · valeur estimée "}
            <span className="tabular-nums">{formatPrice(value)}</span>
          </>
        ) : null}
      </p>
      {hypotheses ? (
        <p className={styles.note}>
          {hypotheses} ·{" "}
          <a href={modifyHref} className={styles.link} aria-label="Modifier les hypothèses">
            Modifier
          </a>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Le dossier de la vente dans le panneau : statut (liste), plafond enregistré, porte du dossier de
 * travail, puis rappels, agenda et rapport PDF. Le dossier est attaché au suivi de la vente.
 */
export function DossierActions({
  saleId,
  onOpenWorkspace,
  reportHref,
}: {
  saleId: string;
  /** Ouvre le dossier de travail (offre Analyse) ; absent quand la vente n'en a pas. */
  onOpenWorkspace?: () => void;
  /** Ancre de « Conserver votre analyse » (rapport PDF), quand elle existe. */
  reportHref?: string | null;
}) {
  const statusId = useId();
  const { userId, query, dossier, savedCeiling, save } = useSaleDossier(saleId);
  const [statusMessage, setStatusMessage] = useState("");
  if (!userId) return null;
  return (
    <div className={styles.actions}>
      {query.isPending ? (
        <p role="status" className={styles.note}>
          Chargement de votre dossier…
        </p>
      ) : dossier && !dossier.followed ? (
        <div className={styles.follow}>
          <FavoriteButton saleId={saleId} className="min-h-11 w-full px-4 text-sm" />
          <p className={styles.note}>
            Suivez cette vente pour noter son statut et enregistrer votre plafond.
          </p>
        </div>
      ) : dossier ? (
        <>
          <label htmlFor={statusId} className={styles.fieldLabel}>
            Statut de mon dossier
          </label>
          <select
            id={statusId}
            className="form-input min-h-11 w-full"
            value={dossier.personalStatus ?? ""}
            aria-busy={save.isPending}
            onChange={(event) => {
              if (save.isPending) return;
              const personalStatus = normalizeFavoriteDossierStatus(event.target.value);
              setStatusMessage("");
              save.mutate(
                { personalStatus },
                {
                  onSuccess: () =>
                    setStatusMessage(personalStatus ? "Statut enregistré" : "Statut retiré"),
                },
              );
            }}
          >
            <option value="">Aucun statut</option>
            {FAVORITE_DOSSIER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {favoriteDossierStatusLabel(status)}
              </option>
            ))}
          </select>
          <p role="status" className={styles.statusMessage}>
            {statusMessage}
          </p>
          <p className={styles.note} data-testid="panel-saved-ceiling">
            {savedCeiling != null ? (
              <>
                Plafond enregistré :{" "}
                <strong className="tabular-nums">{formatPrice(savedCeiling)}</strong>
                {dossier.bidCeilingSavedAt ? `, le ${formatDate(dossier.bidCeilingSavedAt)}` : ""}
              </>
            ) : (
              "Plafond enregistré : aucun"
            )}
          </p>
        </>
      ) : null}
      {onOpenWorkspace ? (
        <Button variant="primary" className="min-h-12 w-full" onClick={onOpenWorkspace}>
          Ouvrir Mon dossier
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      ) : null}
      <div className={styles.row}>
        <SaleRemindersToggle userId={userId} className="" compact />
        <SaleCalendarButton saleId={saleId} compact />
        {reportHref ? (
          <a href={reportHref} className={styles.rowLink}>
            Rapport PDF
          </a>
        ) : null}
      </div>
    </div>
  );
}

/**
 * « Changements de cette vente » : ce que le suivi des changements des favoris (offre Analyse) a
 * détecté sur la vente ces 30 derniers jours (date, mise à prix, statut, pièces). Un refus ou une
 * panne n'affiche rien : le suivi reste lisible dans « Mes favoris ».
 */
export function SaleFollowChanges({
  saleId,
  userId,
  hiddenTopics,
}: {
  saleId: string;
  userId: string;
  /** Sujets dont les valeurs restent masquées (relecture de la fiche en cours). */
  hiddenTopics: ReadonlySet<"price" | "date">;
}) {
  const query = useQuery({
    queryKey: queryKeys.saleChangeEventsForSale(userId, saleId),
    queryFn: () => fetchSaleChangeEvents({ saleId, includeDismissed: true, limit: 50 }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const changes = useMemo(
    () =>
      query.data
        ? recentSaleChanges(query.data.events, new Set([saleId]), {
            hiddenTopics: () => hiddenTopics,
          }).slice(0, MAX_DISPLAYED_SALE_CHANGES)
        : [],
    [hiddenTopics, query.data, saleId],
  );
  if (!query.data) return null;
  return (
    <section className={styles.changes} aria-labelledby="sale-follow-changes-title">
      <h2 id="sale-follow-changes-title" className={styles.changesTitle}>
        Changements de cette vente
      </h2>
      {changes.length ? (
        <ul>
          {changes.map(({ event, label, detail }) => {
            const on = saleChangeDetectedOn(event.detectedAt);
            return (
              <li key={event.id}>
                <span>
                  {label}
                  {detail ? <span className={styles.changeDetail}> : {detail}</span> : null}
                </span>
                {on ? <time dateTime={event.detectedAt}>{on}</time> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.note}>
          Aucun changement détecté ces {RECENT_SALE_CHANGE_DAYS} derniers jours.
        </p>
      )}
    </section>
  );
}
