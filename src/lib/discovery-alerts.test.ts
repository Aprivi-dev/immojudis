import { describe, expect, it } from "vitest";
import {
  alertCreationLoginPath,
  alertCreationPath,
  isDiscoveryAlertCompatible,
  publicAlertCriteria,
} from "./discovery-alerts";
import { firstSearchToUrl } from "./onboarding";
import type { UserAlert } from "./types";

const baseAlert: UserAlert = {
  id: "a1",
  user_id: "u1",
  name: "Alerte",
  department: "33",
  city: null,
  property_type: null,
  max_price_eur: null,
  min_surface_m2: null,
  occupancy_status: null,
  min_investment_score: null,
  max_price_per_m2: null,
  min_yield_pct: null,
  min_market_discount_pct: null,
  dpe_classes: [],
  require_house_with_land: false,
  alert_frequency: "weekly",
  last_evaluated_at: null,
  last_match_count: 0,
  advanced_criteria: {},
  is_active: true,
  watched_zone_id: null,
  created_at: "2026-10-19T08:00:00Z",
  updated_at: "2026-10-19T08:00:00Z",
};

describe("isDiscoveryAlertCompatible", () => {
  it("accepte une alerte hebdomadaire aux critères publics", () => {
    expect(isDiscoveryAlertCompatible(baseAlert)).toBe(true);
  });

  it("refuse un critère réservé à Analyse ou une fréquence quotidienne", () => {
    expect(isDiscoveryAlertCompatible({ ...baseAlert, min_yield_pct: 6 })).toBe(false);
    expect(isDiscoveryAlertCompatible({ ...baseAlert, alert_frequency: "daily" })).toBe(false);
    expect(
      isDiscoveryAlertCompatible({ ...baseAlert, advanced_criteria: { query: "Bordeaux" } }),
    ).toBe(false);
  });
});

describe("publicAlertCriteria", () => {
  it("ne garde que les critères publics d'une adresse", () => {
    expect(
      publicAlertCriteria({
        department: "33",
        city: "Bordeaux",
        saleType: "tribunal",
        homeTypes: "house",
        maxPrice: "150000",
        minSqft: "40",
        query: "texte libre",
        minYield: "8",
        dpe: "D,E",
        houseWithLand: "true",
        occupancy: "libre",
        minScore: "70",
        page: "3",
      }),
    ).toEqual({
      department: "33",
      city: "Bordeaux",
      saleType: "tribunal",
      homeTypes: ["house"],
      maxPrice: 150000,
      minSqft: 40,
    });
  });

  it("garde « Seulement les pépites » : un critère public, comme la zone", () => {
    expect(publicAlertCriteria({ department: "33", pepite: "true" })).toEqual({
      department: "33",
      pepite: true,
    });
    expect(publicAlertCriteria({ department: "33", pepite: "peut-être" }).pepite).toBeUndefined();
  });

  it("n'accepte qu'un seul type de bien", () => {
    expect(publicAlertCriteria({ department: "33", homeTypes: "house,apartment" }).homeTypes).toBe(
      undefined,
    );
  });

  it("garde le résultat de la première recherche de l'accueil quand elle vise un département", () => {
    const record = firstSearchToUrl({ area: "33", maxPrice: "200000", homeType: "apartment" });
    expect(publicAlertCriteria(record)).toMatchObject({
      department: "33",
      maxPrice: 200000,
      homeTypes: ["apartment"],
    });
    // Un secteur en texte libre n'est pas un critère public : il est écarté.
    const free = firstSearchToUrl({ area: "Bordeaux", maxPrice: "", homeType: "" });
    expect(publicAlertCriteria(free)).not.toHaveProperty("query", "Bordeaux");
  });
});

describe("chemins de création d'alerte", () => {
  it("mène à la page de confirmation avec les critères dans l'adresse", () => {
    expect(alertCreationPath({ department: "33", maxPrice: 150000 })).toBe(
      "/alertes/creer?department=33&maxPrice=150000",
    );
    expect(alertCreationPath({})).toBe("/alertes/creer");
  });

  it("fait passer un visiteur par la connexion, motif « alerte », puis le ramène à son choix", () => {
    const login = alertCreationLoginPath({ department: "2A" });
    const url = new URL(login, "https://immojudis.test");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("reason")).toBe("alerte");
    expect(url.searchParams.get("mode")).toBe("investor");
    expect(url.searchParams.get("redirect")).toBe("/alertes/creer?department=2A");
  });
});
