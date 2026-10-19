"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { pointsToVerifyLabel, type PointToVerify } from "@/lib/search/points-to-verify";

/**
 * Pastille discrète « N points à vérifier » d'une carte de vente. Neutre : pas de couleur
 * d'alerte, pas de verbe qui presse. Un bouton l'ouvre (toucher, clavier) : la bulle liste les
 * points et renvoie vers la fiche, où se trouve le détail. Échap ou un second appui la ferme.
 * Rien n'est affiché sans point (voir `pointsToVerify`, qui écarte les données peu fiables).
 */
export function PointsToVerifyBadge({
  points,
  detailHref,
  detailLinkProps,
  onNavigate,
}: {
  points: readonly PointToVerify[];
  detailHref: string;
  detailLinkProps?: Omit<ComponentProps<typeof Link>, "href" | "children">;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (points.length === 0) return null;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((current) => !current)}
        className="relative z-20 inline-flex min-h-6 items-center rounded-full border border-line-soft bg-surface-muted px-2.5 py-1 text-xs font-semibold text-ink-soft hover:border-gold focus-visible:outline-2 focus-visible:outline-gold-soft after:absolute after:-inset-2 after:content-['']"
      >
        {pointsToVerifyLabel(points.length)}
      </button>
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
          <p className="mt-1 text-ink-soft">
            Le détail et les pièces figurent sur la fiche de la vente.
          </p>
          <Link
            {...detailLinkProps}
            href={detailHref}
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
