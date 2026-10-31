"use client";

import { useCallback, useEffect, useState } from "react";
import type { CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { WORKS_SCENARIOS } from "@/lib/profitability";
import type { CeilingWorksKey } from "@/lib/bid-ceiling-engine";
import { parseWorksBreakdown } from "@/lib/works-breakdown";

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
  "consignation",
  "negotiationFeeRatePct",
  "advertisingFees",
  "registrationRatePct",
  "monthlyCharges",
  "annualPropertyTax",
  "financingRatePct",
  "monthlyRent",
  "recoverableCharges",
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
  const worksBreakdown = parseWorksBreakdown(value.worksBreakdown);
  if (worksBreakdown.length) choices.worksBreakdown = worksBreakdown;
  return choices;
}

/** Les choix sans le détail des postes : celui-ci reste dans le navigateur (jamais enregistré ailleurs). */
export function choicesWithoutWorksBreakdown(choices: CeilingUserChoices): CeilingUserChoices {
  const copy = { ...choices };
  delete copy.worksBreakdown;
  return copy;
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

/**
 * Per user and per sale, the choices survive a reload; storage failures are ignored.
 *
 * Starting hypotheses, from the weakest to the strongest source:
 * 1. `profile`: the account's investor profile (n° 93), already turned into choices for this sale;
 * 2. `defaults`: the example page's works level;
 * 3. what the visitor chose on this sale, which always wins (« modifiable par vente »).
 *
 * Nothing is written to the browser until the visitor changes something (`update`, `reset`): looking
 * at a sale must not freeze the profile into it, so a profile edited later still reaches the sales
 * the visitor only looked at. The profile may arrive after the first render (it is read from the
 * account): while the visitor has touched nothing, it is applied as soon as it is there.
 */
export function useCeilingChoices(
  ownerId: string,
  saleId: string,
  defaults: CeilingUserChoices = NO_DEFAULTS,
  profile: CeilingUserChoices = NO_DEFAULTS,
) {
  const key = ceilingStorageKey(ownerId, saleId);
  const profileSignature = JSON.stringify(profile);
  const initialState = (): ChoicesState => ({
    key,
    profileSignature,
    profile,
    touched: false,
    choices: { ...profile, ...defaults, ...readChoices(key) },
  });
  const [state, setState] = useState<ChoicesState>(initialState);
  if (state.key !== key || (state.profileSignature !== profileSignature && !state.touched)) {
    setState(initialState());
  }

  useEffect(() => {
    if (!state.touched) return;
    try {
      window.localStorage.setItem(state.key, JSON.stringify(state.choices));
    } catch {
      /* private window or quota: the choices stay in memory */
    }
  }, [state]);

  const update = useCallback(
    (change: (choices: CeilingUserChoices) => CeilingUserChoices) =>
      setState((current) => ({ ...current, touched: true, choices: change(current.choices) })),
    [],
  );
  const reset = useCallback(
    () =>
      setState((current) => ({
        ...current,
        touched: true,
        // Le budget travaux et son détail sont des saisies de l'utilisateur, pas des hypothèses ; le
        // profil, lui, est l'hypothèse de départ : « réinitialiser » y revient.
        choices: {
          ...current.profile,
          works: current.choices.works,
          ...(current.choices.worksBreakdown
            ? { worksBreakdown: current.choices.worksBreakdown }
            : {}),
        },
      })),
    [],
  );
  return { choices: state.choices, update, reset };
}

type ChoicesState = {
  key: string;
  profileSignature: string;
  /** Le profil à l'origine de ces choix : « réinitialiser » y revient. */
  profile: CeilingUserChoices;
  /** Vrai dès que le visiteur a changé quelque chose sur cette vente : seul cas où l'on écrit. */
  touched: boolean;
  choices: CeilingUserChoices;
};

const NO_DEFAULTS: CeilingUserChoices = {};

function readChoices(key: string): CeilingUserChoices {
  if (typeof window === "undefined") return {};
  try {
    return parseCeilingChoices(JSON.parse(window.localStorage.getItem(key) ?? "null"));
  } catch {
    return {};
  }
}
