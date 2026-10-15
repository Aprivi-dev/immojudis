"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

export type SimulatorMode = "cost" | "budget" | "surenchere";

const SIMULATOR_MODES: ReadonlyArray<{
  value: SimulatorMode;
  label: string;
  hint: string;
}> = [
  { value: "cost", label: "Prix vers coût total", hint: "Je connais le prix d’adjudication" },
  { value: "budget", label: "Budget vers prix maximal", hint: "J’ai un budget total" },
  { value: "surenchere", label: "Surenchère du dixième", hint: "Après une adjudication" },
];

/**
 * Choix du calcul : un groupe de boutons radio natifs (flèches du clavier, un seul arrêt de tabulation,
 * annonce « 1 sur 3 » par les lecteurs d'écran), habillé en onglets. Le contenu choisi s'affiche juste
 * dessous ; seul le mode actif est dans la page.
 */
export function ModeSelector({
  mode,
  onChange,
}: {
  mode: SimulatorMode;
  onChange: (mode: SimulatorMode) => void;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-semibold">Que voulez-vous calculer ?</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {SIMULATOR_MODES.map((item) => (
          <label
            key={item.value}
            className={cn(
              "flex min-h-11 cursor-pointer flex-col justify-center rounded-lg border bg-white px-3 py-2 text-sm",
              "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gold/60 has-[:focus-visible]:ring-offset-2",
              mode === item.value
                ? "border-gold bg-gold/10 shadow-sm"
                : "border-line hover:border-brand-navy",
            )}
          >
            <input
              type="radio"
              name={name}
              value={item.value}
              checked={mode === item.value}
              onChange={() => onChange(item.value)}
              className="sr-only"
            />
            <span className="font-semibold">{item.label}</span>
            <span className="text-xs text-ink-soft">{item.hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
