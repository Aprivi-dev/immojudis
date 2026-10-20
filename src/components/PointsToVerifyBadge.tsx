"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useEffect, useId, useRef, useState } from "react";
import ListChecks from "lucide-react/dist/esm/icons/list-checks.js";
import { escapeBelongsToAnotherLayer } from "@/lib/escape-layer";
import {
  POINTS_TO_VERIFY_ANCHOR,
  POINTS_TO_VERIFY_NOTE,
  pointsToVerifyLabel,
  type PointToVerify,
} from "@/lib/search/points-to-verify";

/**
 * Pastille discrète « N points à vérifier » d'une carte de vente. Neutre : pas de couleur
 * d'alerte, pas de verbe qui presse. Un bouton l'ouvre (toucher, clavier) : la bulle liste les
 * points, rappelle que la liste n'est pas exhaustive et renvoie vers la fiche (ancre
 * `#points-a-verifier`, qui reprend ces points). Échap ou un second appui la ferme, sauf si un
 * dialogue ouvert par-dessus a déjà pris l'Échap.
 * Rien n'est affiché sans point (voir `pointsToVerify`, qui écarte les données peu fiables).
 *
 * `variant="icon"` : la vue tableau n'a pas la place d'un libellé ; le bouton est une icône dont le
 * nom accessible est le même « N points à vérifier ».
 */
export function PointsToVerifyBadge({
  points,
  detailHref,
  detailLinkProps,
  onNavigate,
  variant = "pill",
}: {
  points: readonly PointToVerify[];
  detailHref: string;
  detailLinkProps?: Omit<ComponentProps<typeof Link>, "href" | "children">;
  onNavigate?: () => void;
  variant?: "pill" | "icon";
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || escapeBelongsToAnotherLayer(event, trigger.current)) return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (points.length === 0) return null;

  const label = pointsToVerifyLabel(points.length);
  // Zone d'appui de 44 px : le bouton reste petit à l'œil, son pseudo-élément déborde.
  const focusClasses =
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft";

  return (
    <>
      {variant === "icon" ? (
        <button
          ref={trigger}
          type="button"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-label={label}
          onClick={() => setOpen((current) => !current)}
          className={`relative z-20 inline-flex size-6 items-center justify-center rounded-full border border-line-soft bg-surface-muted text-ink-soft hover:border-gold ${focusClasses} after:absolute after:-inset-2.5 after:content-['']`}
        >
          <ListChecks className="size-3.5" aria-hidden />
        </button>
      ) : (
        <button
          ref={trigger}
          type="button"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((current) => !current)}
          className={`relative z-20 inline-flex min-h-6 items-center rounded-full border border-line-soft bg-surface-muted px-2.5 py-1 text-xs font-semibold text-ink-soft hover:border-gold ${focusClasses} after:absolute after:-inset-x-2 after:-inset-y-2.5 after:content-['']`}
        >
          {label}
        </button>
      )}
      {open ? (
        <div
          id={id}
          role="note"
          className="relative z-20 w-full rounded-lg border border-line-soft bg-surface-muted p-3 text-xs leading-relaxed text-foreground"
        >
          <p className="font-semibold">Relevé dans l’annonce</p>
          <ul className="mt-1 list-disc pl-4">
            {points.map((point) => (
              <li key={point.key}>{point.label}</li>
            ))}
          </ul>
          <p className="mt-1 text-ink-soft">{POINTS_TO_VERIFY_NOTE}</p>
          <p className="mt-1 text-ink-soft">
            Le détail et les pièces figurent sur la fiche de la vente.
          </p>
          <Link
            {...detailLinkProps}
            href={`${detailHref}#${POINTS_TO_VERIFY_ANCHOR}`}
            prefetch={false}
            onClick={onNavigate}
            className="inline-flex min-h-11 items-center font-semibold text-gold-text underline underline-offset-4"
          >
            Voir la fiche
          </Link>
        </div>
      ) : null}
    </>
  );
}
