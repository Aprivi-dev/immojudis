"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.js";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";
import { formatPrice } from "@/lib/format";
import type { MaquetteKind } from "@/lib/sale-maquette";
import { cn } from "@/lib/utils";
import { MAQUETTE_HOURS, maquetteHourLabel } from "./maquette/light";
import { createMaquetteScene, type MaquetteScene } from "./maquette/scene";
import type { PriceSummaryCeiling } from "./PriceSummaryCard";

/** Les montants de la tête de fiche, tels que le compte peut les lire (les mêmes que « Le prix »). */
export type SaleMaquettePrices = {
  startLabel: string;
  /** `null` : non publié, ou en cours de vérification. */
  startingPrice: number | null;
  ceilingLabel: string;
  ceiling: PriceSummaryCeiling | null;
  /** Valeur estimée comparable au prix de départ, quand le compte la lit. */
  value: number | null;
};

/** Ce que montre le volume, et ce que l'or y désigne. */
const KIND_TEXT: Record<MaquetteKind, { scene: string; sold: string }> = {
  apartment: {
    scene: "un immeuble de ville, dont un lot est cerné d’or",
    sold: "L’appartement vendu (étage et emplacement fictifs)",
  },
  building: { scene: "un immeuble de ville, cerné d’or", sold: "L’immeuble vendu" },
  house: {
    scene: "une maison et son jardin, sur une parcelle cernée d’or",
    sold: "La parcelle de la maison vendue",
  },
  land: { scene: "un terrain nu, cerné d’or", sold: "Le terrain vendu" },
};

/** Couleur de ce qui est vendu, et couleur de chaque colonne de prix : jeton CSS et pastille. */
const SOLD_COLOR = { token: "--gold", swatch: "bg-gold" };
const COLUMN_COLORS = {
  start: { token: "--brand-navy", swatch: "bg-brand-navy" },
  ceiling: { token: "--info", swatch: "bg-info" },
  value: { token: "--success", swatch: "bg-success" },
} as const;

type PriceRow = {
  key: keyof typeof COLUMN_COLORS;
  label: string;
  /** `null` : montant réservé, la colonne est voilée. */
  amount: number | null;
  detail?: ReactNode;
};

function priceRows(prices: SaleMaquettePrices): PriceRow[] {
  const rows: PriceRow[] = [];
  if (prices.startingPrice != null) {
    rows.push({ key: "start", label: prices.startLabel, amount: prices.startingPrice });
  }
  if (prices.ceiling?.kind === "amount") {
    rows.push({ key: "ceiling", label: prices.ceilingLabel, amount: prices.ceiling.amount });
  } else if (prices.ceiling?.kind === "locked") {
    rows.push({
      key: "ceiling",
      label: prices.ceilingLabel,
      amount: null,
      detail: prices.ceiling.action,
    });
  }
  if (prices.value != null) {
    rows.push({ key: "value", label: "Valeur estimée", amount: prices.value });
  }
  return rows;
}

/** Valeur d'un jeton de couleur du site (`--gold`…), lue là où la maquette s'affiche. */
const tokenColor = (element: Element, token: string) =>
  getComputedStyle(element).getPropertyValue(token).trim();

const CONTROL_CLASS =
  "grid h-10 w-10 place-items-center rounded-md border border-white/70 bg-white/95 text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft";

/**
 * « Maquette 3D » de la galerie : un volume schématique du type de bien, les montants de la tête de
 * fiche en colonnes, et la lumière d'une heure choisie. Elle n'invente rien sur le bien : seuls le
 * type et les montants viennent de la vente, et la légende le dit. Three.js n'est chargé qu'avec ce
 * composant, lui-même chargé quand le visiteur choisit la maquette.
 */
export function SaleMaquette({
  kind,
  prices,
  frameClassName,
}: {
  kind: MaquetteKind;
  prices: SaleMaquettePrices;
  /** Cadre du visuel : mêmes hauteurs que la photo principale et la vue 360°. */
  frameClassName?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<MaquetteScene | null>(null);
  const hourRef = useRef<number>(MAQUETTE_HOURS.initial);
  const [hour, setHour] = useState<number>(MAQUETTE_HOURS.initial);
  // WebGL indisponible ou contexte perdu : un message remplace le canevas.
  const [failed, setFailed] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const hourId = useId();

  const rows = priceRows(prices);
  const highest = Math.max(...rows.map((row) => row.amount ?? 0));
  // En texte : les colonnes ne sont redessinées que si leur contenu change vraiment.
  const columnsKey = JSON.stringify(
    rows.map((row) => ({ key: row.key, share: row.amount == null ? null : row.amount / highest })),
  );

  useEffect(() => {
    const host = hostRef.current;
    if (failed || !host) return;
    // Un canevas par scène : son contexte WebGL est rendu au navigateur avec elle.
    const canvas = document.createElement("canvas");
    canvas.className = "block h-full w-full cursor-grab touch-pan-y active:cursor-grabbing";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Maquette 3D schématique : ${KIND_TEXT[kind].scene}.`);
    host.append(canvas);
    let scene: MaquetteScene;
    try {
      scene = createMaquetteScene({
        canvas,
        kind,
        accent: tokenColor(host, SOLD_COLOR.token),
        hour: hourRef.current,
        animated: !reducedMotion,
        onContextLost: () => setFailed(true),
      });
    } catch (error) {
      // Le plus souvent : pas de WebGL. L'erreur reste lisible dans la console si c'est autre chose.
      console.error("[maquette] scène 3D impossible à créer", error);
      canvas.remove();
      setFailed(true);
      return;
    }
    sceneRef.current = scene;
    return () => {
      sceneRef.current = null;
      scene.dispose();
      canvas.remove();
    };
  }, [failed, kind, reducedMotion]);

  // Après la création de la scène, et à chaque montant qui arrive : le point de vue est conservé.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const columns = JSON.parse(columnsKey) as Array<{ key: PriceRow["key"]; share: number | null }>;
    sceneRef.current?.setColumns(
      columns.map(({ key, share }) =>
        share == null
          ? { kind: "locked" }
          : { kind: "amount", color: tokenColor(host, COLUMN_COLORS[key].token), share },
      ),
    );
  }, [columnsKey, failed, kind, reducedMotion]);

  const changeHour = (value: number) => {
    hourRef.current = value;
    setHour(value);
    sceneRef.current?.setHour(value);
  };

  return (
    <div data-testid="sale-maquette">
      <div
        data-testid="sale-maquette-frame"
        className={cn("relative overflow-hidden", frameClassName)}
      >
        {failed ? (
          <p
            role="status"
            className="grid h-full place-items-center px-6 text-center text-sm text-ink-soft"
          >
            La maquette 3D ne peut pas s’afficher sur cet appareil.
          </p>
        ) : (
          <>
            <div ref={hostRef} className="h-full w-full" />
            <div className="absolute bottom-3 right-3 flex gap-1.5 md:bottom-4 md:right-4">
              <button
                type="button"
                className={CONTROL_CLASS}
                aria-label="Tourner la maquette vers la gauche"
                onClick={() => sceneRef.current?.rotate(-Math.PI / 6)}
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                className={CONTROL_CLASS}
                aria-label="Tourner la maquette vers la droite"
                onClick={() => sceneRef.current?.rotate(Math.PI / 6)}
              >
                <RotateCw className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                className={CONTROL_CLASS}
                aria-label="Rapprocher la maquette"
                onClick={() => sceneRef.current?.zoom(0.85)}
              >
                <Plus className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                className={CONTROL_CLASS}
                aria-label="Éloigner la maquette"
                onClick={() => sceneRef.current?.zoom(1 / 0.85)}
              >
                <Minus className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </>
        )}
      </div>

      <div className="mt-2 flex items-center gap-3">
        <label htmlFor={hourId} className="text-xs font-semibold text-brand-navy">
          Lumière
        </label>
        <input
          id={hourId}
          type="range"
          min={MAQUETTE_HOURS.min}
          max={MAQUETTE_HOURS.max}
          step={MAQUETTE_HOURS.step}
          value={hour}
          disabled={failed}
          onChange={(event) => changeHour(Number(event.target.value))}
          aria-valuetext={maquetteHourLabel(hour)}
          className="h-10 min-w-0 flex-1 accent-brand-navy"
        />
        <output htmlFor={hourId} className="w-16 text-right text-xs tabular-nums text-ink-soft">
          {maquetteHourLabel(hour)}
        </output>
      </div>

      <ul className="mt-1 grid gap-x-4 gap-y-1.5 text-xs text-brand-navy sm:grid-cols-2">
        <li className="flex items-baseline gap-2">
          <span className={cn("h-2.5 w-2.5 flex-none rounded-sm", SOLD_COLOR.swatch)} aria-hidden />
          <span>{KIND_TEXT[kind].sold}</span>
        </li>
        {rows.map((row) => (
          <li key={row.key} className="flex items-baseline gap-2">
            <span
              className={cn(
                "h-2.5 w-2.5 flex-none rounded-sm",
                row.amount == null
                  ? "border border-dashed border-ink-soft"
                  : COLUMN_COLORS[row.key].swatch,
              )}
              aria-hidden
            />
            <span>
              {row.label} :{" "}
              {row.amount == null ? (
                row.detail
              ) : (
                <span className="font-semibold tabular-nums">{formatPrice(row.amount)}</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs leading-relaxed text-ink-soft">
        Maquette schématique : elle illustre le type de bien, pas le bien lui-même. Formes,
        dimensions, orientation et environnement sont génériques ; la lumière ne dit rien de
        l’exposition réelle du bien.
        {rows.some((row) => row.amount != null)
          ? " La hauteur des colonnes suit les montants."
          : null}
      </p>
    </div>
  );
}
