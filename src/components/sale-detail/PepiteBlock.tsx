"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import Check from "lucide-react/dist/esm/icons/check.js";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help.js";
import Lock from "lucide-react/dist/esm/icons/lock.js";
import { PepiteIcon } from "@/components/PepiteBadge";
import { SaleSignalFeedback } from "@/components/SaleSignalFeedback";
import { formatDate, formatPrice } from "@/lib/format";
import {
  PEPITE_ANCHOR,
  PEPITE_EXPLANATION,
  PEPITE_METHOD_LINK_LABEL,
  PEPITE_METHOD_PATH,
} from "@/lib/pepite-copy";
import type { PepiteCriterionView, PepitePayload } from "@/lib/sale-pepite-view";

const METHOD_LINK =
  "font-semibold text-gold-text underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft";

function CriteriaList({
  label,
  items,
  className = "text-sm",
}: {
  label: string;
  items: PepiteCriterionView[];
  className?: string;
}) {
  return (
    <ul aria-label={label} className={`grid gap-x-6 gap-y-1.5 lg:grid-cols-2 ${className}`}>
      {items.map((criterion) => (
        <li key={criterion.id} className="flex items-start gap-2 text-foreground">
          {criterion.state === "pass" ? (
            <>
              <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <span className="sr-only">Réussi : </span>
            </>
          ) : (
            <>
              <CircleHelp className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <span className="font-semibold text-warning">À confirmer : </span>
            </>
          )}
          <span>{criterion.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Bloc « Pourquoi cette pépite » de la fiche (cible de `#pepite`). Deux versions, jamais de flou CSS :
 *
 *  - ouverte (`payload.access === "detail"` : offre Analyse, vente débloquée) : titre, critères, la condition en
 *    toutes lettres, le plafond de référence, le prix probable avec sa réserve, la date du calcul, et le retour
 *    « Utile / Pas pertinent » ;
 *  - verrouillée (visiteur, compte Découverte qui n'a pas débloqué la vente) : titre, nombre et noms des critères
 *    réunis, puis une ligne avec cadenas qui renvoie au déblocage (`lockedAction`). Aucun montant, aucune valeur
 *    ne figure dans les données reçues : la route ne les envoie pas à ce niveau.
 *
 * Chaque critère dit son état en texte et en icône (réussi, à confirmer) : jamais la couleur seule.
 * Chargé à la demande (`next/dynamic`) : seule une pépite l'affiche.
 */
export function PepiteBlock({
  payload,
  saleId,
  userCeilingEur = null,
  lockedAction,
  className = "mx-auto w-full max-w-[1380px] px-4 sm:px-6 lg:px-8",
}: {
  /** Mise en page du conteneur (les pages qui ont déjà leur colonne passent `""`). */
  className?: string;
  payload: PepitePayload | null;
  saleId: string;
  /** Plafond de l'utilisateur sur cette vente (ses hypothèses), pour le comparer au plafond de référence. */
  userCeilingEur?: number | null;
  /** L'action qui ouvre le détail : « Débloquer cette vente » (compte), « Créez un compte gratuit » (visiteur). */
  lockedAction?: ReactNode;
}) {
  if (!payload) return null;
  const detail = payload.access === "detail" ? payload.detail : null;
  const reference = detail?.referenceCeilingEur ?? null;
  const differs =
    userCeilingEur != null &&
    reference != null &&
    Math.round(userCeilingEur) !== Math.round(reference);

  const count = payload.count;
  const title =
    count > 0
      ? `Pépite : ${count} test${count > 1 ? "s" : ""} réussi${count > 1 ? "s" : ""}`
      : "Pépite : tests à confirmer";

  return (
    <section
      id={PEPITE_ANCHOR}
      aria-labelledby="pepite-title"
      className={`scroll-mt-36 ${className}`}
    >
      <div className="rounded-lg border border-gold bg-white p-4 sm:p-5">
        <h2
          id="pepite-title"
          className="flex items-center gap-2 text-lg font-semibold text-brand-navy"
        >
          <PepiteIcon className="size-5" />
          {title}
        </h2>
        <CriteriaList label="Tests de la pépite" items={payload.tests} className="mt-3 text-base" />
        {payload.checks.length > 0 ? (
          <details className="mt-3 text-sm">
            <summary className="min-h-11 cursor-pointer py-2 font-semibold text-brand-navy">
              Vérifications de fiabilité réussies ({payload.checksPassed})
            </summary>
            <CriteriaList label="Vérifications de fiabilité" items={payload.checks} />
          </details>
        ) : null}

        {detail ? (
          <div className="mt-4 space-y-2 border-t border-line-soft pt-4 text-sm text-foreground">
            <p>{detail.condition}</p>
            {detail.ceilingLine ? (
              <p>
                {detail.ceilingLine}{" "}
                <a href="#calculation" className={METHOD_LINK}>
                  Voir avec mes hypothèses
                </a>
              </p>
            ) : null}
            {detail.chanceLine ? <p>{detail.chanceLine}</p> : null}
            {differs ? (
              <p>
                Votre plafond : {formatPrice(userCeilingEur)} · Plafond de référence de la pépite :{" "}
                {formatPrice(reference)}
              </p>
            ) : null}
            {detail.priceLine ? <p className="font-semibold">{detail.priceLine}</p> : null}
            {detail.priceLowNote ? <p>{detail.priceLowNote}</p> : null}
            {detail.priceNote ? <p className="text-ink-soft">{detail.priceNote}</p> : null}
            <p className="text-ink-soft">
              {detail.calculatedAt
                ? `Calcul automatique du ${formatDate(detail.calculatedAt)}. `
                : null}
              Ni conseil, ni recommandation d&apos;acheter, ni garantie.{" "}
              <Link href={PEPITE_METHOD_PATH} prefetch={false} className={METHOD_LINK}>
                {PEPITE_METHOD_LINK_LABEL}
              </Link>
            </p>
            <SaleSignalFeedback saleId={saleId} signal="pepite" className="pt-1" />
          </div>
        ) : (
          <div className="mt-4 space-y-2 border-t border-line-soft pt-4 text-sm text-foreground">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold text-brand-navy">
              <span className="inline-flex items-center gap-2">
                <Lock className="size-4 shrink-0" aria-hidden />
                Montant et détail : débloquez cette vente
              </span>
              {lockedAction}
            </p>
            <p className="text-ink-soft">
              {PEPITE_EXPLANATION}{" "}
              <Link href={PEPITE_METHOD_PATH} prefetch={false} className={METHOD_LINK}>
                {PEPITE_METHOD_LINK_LABEL}
              </Link>
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
