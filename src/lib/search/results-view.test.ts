import { describe, expect, it } from "vitest";
import {
  RESULTS_VIEW_PARAM,
  effectiveResultsView,
  parseResultsView,
  withResultsView,
} from "./results-view";
import {
  salesSearchSignature,
  salesSearchToUrlRecord,
  validateSalesSearch,
} from "./search-url-state";

describe("affichage des résultats (cartes / tableau)", () => {
  it("lit « table » et prend les cartes pour toute autre valeur", () => {
    expect(parseResultsView("table")).toBe("table");
    for (const value of [null, undefined, "", "cards", "TABLE", "list", "grid"]) {
      expect(parseResultsView(value)).toBe("cards");
    }
  });

  it("n'écrit dans l'adresse que le tableau : les cartes sont le défaut", () => {
    const record = { city: "Lyon", sort: "price_asc" };
    expect(withResultsView(record, "table")).toEqual({ ...record, [RESULTS_VIEW_PARAM]: "table" });
    expect(withResultsView(record, "cards")[RESULTS_VIEW_PARAM]).toBeUndefined();
    // Une adresse déjà en tableau repasse aux cartes en effaçant le paramètre.
    expect(withResultsView({ ...record, view: "table" }, "cards").view).toBeUndefined();
  });

  it("ne passe en tableau que sur écran large", () => {
    expect(effectiveResultsView("table", true)).toBe("table");
    expect(effectiveResultsView("table", false)).toBe("cards");
    expect(effectiveResultsView("cards", true)).toBe("cards");
    expect(effectiveResultsView("cards", false)).toBe("cards");
  });

  it("reste hors des critères : même recherche, même signature, même export", () => {
    const withView = validateSalesSearch({ city: "Lyon", view: "table" });
    const without = validateSalesSearch({ city: "Lyon" });
    expect(salesSearchSignature(withView)).toBe(salesSearchSignature(without));
    expect(salesSearchToUrlRecord(withView)).not.toHaveProperty(RESULTS_VIEW_PARAM);
    expect(salesSearchSignature(validateSalesSearch({ view: "table" }))).toBe(
      salesSearchSignature({}),
    );
  });
});
