"use client";

import { useCallback, useEffect, useState } from "react";
import type { CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { WORKS_SCENARIOS } from "@/lib/profitability";
import type { CeilingWorksKey } from "@/lib/bid-ceiling-engine";

const STORAGE_PREFIX = "immojudis:ceiling:v2";
const PROJECTS = new Set(["habiter", "louer", "revendre"]);
const PROFILES = new Set(["prudent", "equilibre", "offensif"]);
const OCCUPATIONS = new Set(["libre", "occupe", "loue", "squat", "inconnu"]);
const WORKS_KEYS = new Set(["aucun", "rafraichissement", "confort", "premium", "devis"]);
const NUMBER_FIELDS = [
  "customMarginPct",
  "manualPricePerM2",
  "releaseMonths",
  "releaseCost",
  "rentedDiscountPct",
  "fpt",
  "lawyerFees",
  "registrationRatePct",
  "monthlyCharges",
  "annualPropertyTax",
  "financingRatePct",
  "monthlyRent",
  "targetNetYieldPct",
  "sellingCostsPct",
] as const;

export function ceilingStorageKey(ownerId: string, saleId: string) {
  return `${STORAGE_PREFIX}:${ownerId}:${saleId}`;
}

/** Keeps only the known fields with valid values: stored drafts are untrusted input. */
export function parseCeilingChoices(raw: unknown): CeilingUserChoices {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const choices: CeilingUserChoices = {};
  if (PROJECTS.has(value.project as string))
    choices.project = value.project as CeilingUserChoices["project"];
  if (PROFILES.has(value.profile as string))
    choices.profile = value.profile as CeilingUserChoices["profile"];
  if (OCCUPATIONS.has(value.occupation as string))
    choices.occupation = value.occupation as CeilingUserChoices["occupation"];
  if (value.taxRegime === "vat" || value.taxRegime === "registration")
    choices.taxRegime = value.taxRegime;
  for (const field of NUMBER_FIELDS) {
    const number = value[field];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0)
      choices[field] = number;
  }
  const works = value.works as Record<string, unknown> | null | undefined;
  if (
    works &&
    WORKS_KEYS.has(works.key as string) &&
    typeof works.amount === "number" &&
    Number.isFinite(works.amount) &&
    works.amount >= 0
  ) {
    choices.works = {
      key: works.key as CeilingWorksKey,
      amount: works.amount,
      months: typeof works.months === "number" && works.months >= 0 ? works.months : null,
    };
  }
  return choices;
}

export function worksChoiceForAmount(
  surface: number | null | undefined,
  amount: number,
): NonNullable<CeilingUserChoices["works"]> {
  const clean = Math.max(0, Math.round(amount || 0));
  if (clean === 0) return { key: "aucun", amount: 0 };
  const scenario =
    surface && surface > 0
      ? WORKS_SCENARIOS.find((item) => Math.round(surface * item.pricePerM2) === clean)
      : undefined;
  return { key: scenario ? (scenario.key as CeilingWorksKey) : "devis", amount: clean };
}

/** Per user and per sale, the choices survive a reload; storage failures are ignored. */
export function useCeilingChoices(ownerId: string, saleId: string) {
  const key = ceilingStorageKey(ownerId, saleId);
  const [state, setState] = useState<{ key: string; choices: CeilingUserChoices }>(() => ({
    key,
    choices: readChoices(key),
  }));
  if (state.key !== key) setState({ key, choices: readChoices(key) });

  useEffect(() => {
    try {
      window.localStorage.setItem(state.key, JSON.stringify(state.choices));
    } catch {
      /* private window or quota: the choices stay in memory */
    }
  }, [state]);

  const update = useCallback(
    (change: (choices: CeilingUserChoices) => CeilingUserChoices) =>
      setState((current) => ({ ...current, choices: change(current.choices) })),
    [],
  );
  const reset = useCallback(
    () => setState((current) => ({ ...current, choices: { works: current.choices.works } })),
    [],
  );
  return { choices: state.choices, update, reset };
}

function readChoices(key: string): CeilingUserChoices {
  if (typeof window === "undefined") return {};
  try {
    return parseCeilingChoices(JSON.parse(window.localStorage.getItem(key) ?? "null"));
  } catch {
    return {};
  }
}
