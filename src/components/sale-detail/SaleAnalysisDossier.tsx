"use client";

// Le dossier du panneau « Votre analyse » (statut, plafond enregistré, rappels, agenda, changements) :
// chargé à la demande, comme la carte « Mon dossier », hors du JavaScript de la fiche.
import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { FavoriteButton } from "@/components/FavoriteButton";
import { Button } from "@/components/ui/primitives";
import { fetchNotificationPreferences, fetchSaleChangeEvents } from "@/lib/client-api";
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
import { useSaleDossier } from "./use-sale-dossier";
import styles from "./SaleAnalysisPanel.module.css";

/**
 * Le dossier de la vente dans le panneau : statut (liste), plafond enregistré, porte du dossier de
 * travail, puis rappels, agenda et rapport PDF. Le dossier est attaché au suivi de la vente.
 */
export function DossierActions({
  saleId,
  onOpenWorkspace,
  reportHref,
  calendarHref,
}: {
  saleId: string;
  /** Ouvre le dossier de travail (offre Analyse) ; absent quand la vente n'en a pas. */
  onOpenWorkspace?: () => void;
  /** Ancre de « Conserver votre analyse » (rapport PDF), quand elle existe. */
  reportHref?: string | null;
  /** Ancre de « Ajouter à mon agenda » (rendez-vous de la vente), quand l'export existe. */
  calendarHref?: string | null;
}) {
  const statusId = useId();
  const { userId, query, dossier, savedCeiling, save } = useSaleDossier(saleId);
  const [statusMessage, setStatusMessage] = useState("");
  // Rappels d'audience : la case (et son texte de consentement) reste dans « Mon dossier » ; le
  // panneau dit seulement s'ils sont activés et y mène.
  const preferences = useQuery({
    queryKey: queryKeys.notificationPreferences(userId ?? ""),
    queryFn: fetchNotificationPreferences,
    enabled: Boolean(userId),
    staleTime: 60_000,
  });
  const remindersOn = preferences.data?.preferences.saleRemindersEnabled ?? false;
  const remindersOffered = remindersOn || Boolean(preferences.data?.saleRemindersAvailable);
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
        {remindersOffered ? (
          <a
            href="#mon-dossier"
            className={styles.rowLink}
            title={
              remindersOn
                ? "Rappels d’audience activés : les gérer dans Mon dossier"
                : "Activer les rappels d’audience dans Mon dossier"
            }
          >
            {remindersOn ? "Rappels activés" : "Rappels"}
          </a>
        ) : null}
        {calendarHref ? (
          <a href={calendarHref} className={styles.rowLink} title="Ajouter la vente à mon agenda">
            Calendrier
          </a>
        ) : null}
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
