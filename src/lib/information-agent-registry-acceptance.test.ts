import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factClaimDecisionsHref } from "./fact-claim-decisions";
import {
  INFORMATION_AGENT_REGISTRY_FACT_FIELDS,
  INFORMATION_AGENT_REGISTRY_HELD_FIELDS,
  informationAgentFactHeldByRegistry,
  REGISTRY_OCCUPANCY_VALUES,
  informationAgentAcceptanceMessage,
  informationAgentFactRegistryField,
  informationAgentOccupancyRefused,
} from "./information-agent-registry-acceptance";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");
const read = (name: string) => readFileSync(join(MIGRATIONS, name), "utf8");

describe("concordance avec la base", () => {
  it("la correspondance clé → champ est celle de la base, dans ses deux copies (fonction et pont)", () => {
    const sql = read("20261119100900_information_agent_acceptance_through_registry.sql");
    const copies = [
      /function app_private\.information_agent_fact_registry_field[\s\S]*?\$\$;/,
      /v_field_key := case new\.fact_key[\s\S]*?end;/,
    ].map((pattern) => pattern.exec(sql)?.[0]);
    for (const body of copies) {
      expect(body).toBeTruthy();
      const pairs = [...body!.matchAll(/when '([a-z0-9_]+)' then '([a-z0-9_.]+)'/g)].map(
        ([, key, field]) => [key, field],
      );
      expect(Object.fromEntries(pairs)).toEqual(INFORMATION_AGENT_REGISTRY_FACT_FIELDS);
      expect(pairs).toHaveLength(Object.keys(INFORMATION_AGENT_REGISTRY_FACT_FIELDS).length);
    }
  });

  it("les champs tenus sont ceux que la base tient (auction_fact_fields.hold_enabled)", () => {
    const sql = read("20261116100000_fact_registry_tables.sql");
    const seed = /insert into public\.auction_fact_fields[\s\S]*?on conflict/.exec(sql)?.[0] ?? "";
    const held = [...seed.matchAll(/\(\s*'([a-z0-9_.]+)',[^()]*?\btrue\s*\)/g)].map(
      ([, field]) => field,
    );
    expect(
      held.filter((field) => Object.values(INFORMATION_AGENT_REGISTRY_FACT_FIELDS).includes(field)),
    ).toEqual([...INFORMATION_AGENT_REGISTRY_HELD_FIELDS]);
    expect(informationAgentFactHeldByRegistry("surface_m2")).toBe(true);
    expect(informationAgentFactHeldByRegistry("starting_price_eur")).toBe(false);
    expect(informationAgentFactHeldByRegistry("document")).toBe(false);
  });

  it("les occupations admises sont celles que le registre peut tenir (sale_field_claim_value)", () => {
    const sql = read("20261116100000_fact_registry_tables.sql");
    const occupancy = /'property\.occupancy_status' then[\s\S]*?in \(([^)]*)\)/.exec(sql)?.[1];
    expect(
      [...(occupancy ?? "").matchAll(/'([a-z_]+)'/g)].map(([, value]) => value).sort(),
    ).toEqual([...REGISTRY_OCCUPANCY_VALUES].sort());
  });
});

describe("règles de l'acceptation", () => {
  it("demande un rattachement au lot pour les faits du registre seulement", () => {
    expect(informationAgentFactRegistryField("surface_m2")).toBe("property.surface_m2");
    expect(informationAgentFactRegistryField("starting_price_eur")).toBe("sale.starting_price_eur");
    expect(informationAgentFactRegistryField("visit_information")).toBeNull();
    expect(informationAgentFactRegistryField("document")).toBeNull();
    expect(informationAgentFactRegistryField("constructor")).toBeNull();
  });

  it("refuse « occupé par le propriétaire » et « squatté », comme le registre", () => {
    expect(informationAgentOccupancyRefused("occupancy_status", "owner_occupied")).toBe(true);
    expect(informationAgentOccupancyRefused("occupancy_status", "squatted")).toBe(true);
    expect(informationAgentOccupancyRefused("occupancy_status", "unknown")).toBe(true);
    for (const value of REGISTRY_OCCUPANCY_VALUES) {
      expect(informationAgentOccupancyRefused("occupancy_status", value)).toBe(false);
    }
    expect(informationAgentOccupancyRefused("rooms_count", 3)).toBe(false);
  });
});

describe("message de l'écran après l'acceptation", () => {
  const saleId = "11111111-1111-4111-8111-111111111111";
  const claimId = "22222222-2222-4222-8222-222222222222";
  const base = { claimId, saleId, error: null };

  it("dit que la valeur est affichée et protégée quand le registre la tient", () => {
    expect(informationAgentAcceptanceMessage({ ...base, state: "held" })).toEqual({
      tone: "success",
      text: "Valeur acceptée : affichée sur la fiche et protégée contre la collecte.",
      href: null,
    });
  });

  it("garde le message d'avant pour un fait hors registre", () => {
    expect(informationAgentAcceptanceMessage(null).tone).toBe("success");
  });

  it("avertit quand la décision n'a pas pu être enregistrée, et dit où la reprendre", () => {
    const message = informationAgentAcceptanceMessage({
      ...base,
      state: null,
      error: "Import en cours sur cette vente, réessayez dans une minute.",
    });
    expect(message.tone).toBe("warning");
    expect(message.text).toBe(
      `Réponse acceptée, mais la valeur n’est pas encore sur la fiche : Import en cours sur cette vente, réessayez dans une minute. Reprenez-la dans « Observations à décider » (vente ${saleId}, observation ${claimId}).`,
    );
    expect(message.href).toBe(factClaimDecisionsHref(saleId));
    expect(message.href).toBe(`?onglet=reponses&vente=${saleId}#observations-a-decider`);
  });

  it("avertit quand la valeur n'est pas affichée (contradiction, refus, lot)", () => {
    for (const state of ["conflicted", "blocked", "pass_through", "released"]) {
      expect(informationAgentAcceptanceMessage({ ...base, state }).tone, state).toBe("warning");
    }
  });
});
