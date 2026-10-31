import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicTribunalActivity } from "@/lib/public-tribunal-activity";
import { tribunalPages } from "@/lib/tribunal-pages";

const mocks = vi.hoisted(() => ({ directory: vi.fn() }));
vi.mock("@/lib/public-tribunal-directory.server", () => ({
  tryLoadPublicTribunalDirectory: mocks.directory,
}));

import { loadAmbiguousTribunalCodes } from "./tribunal-ambiguity.server";

function activity(code: string, searchName: string): PublicTribunalActivity {
  return {
    code,
    name: searchName.replace(/^TJ /, ""),
    searchName,
    city: null,
    department: "974",
    upcomingCount: 5,
    nextSaleDate: null,
    medianStartingPriceEur: null,
    houseCount: 0,
    apartmentCount: 0,
    otherCount: 0,
  };
}

const entry = (code: string, searchName: string) => ({
  code,
  name: searchName.replace(/^TJ /, ""),
  searchName,
  city: null,
  department: null,
});

describe("loadAmbiguousTribunalCodes", () => {
  beforeEach(() => mocks.directory.mockReset());

  it("révèle l'homonyme d'un tribunal sans vente : le lien de la liste reste l'adresse par code", async () => {
    const items = [activity("justice_tj_1_97", "TJ Saint-Pierre")];
    mocks.directory.mockResolvedValue({
      status: "ok",
      items: [
        entry("justice_tj_1_97", "TJ Saint-Pierre"),
        entry("justice_tj_1_50", "TJ Saint-Pierre"),
      ],
    });
    const ambiguous = await loadAmbiguousTribunalCodes(items);
    expect([...ambiguous].sort()).toEqual(["justice_tj_1_50", "justice_tj_1_97"]);
    expect(tribunalPages(items, ambiguous)[0].path).toBe("/tribunaux/justice-tj-1-97");
    // Sans le calcul d'ambiguïté, le lien serait une adresse lisible qui répond 404.
    expect(tribunalPages(items)[0].path).toBe("/tribunaux/tribunal-judiciaire-saint-pierre");
  });

  it("garde les homonymes des tribunaux à ventes quand le référentiel est en panne", async () => {
    mocks.directory.mockResolvedValue({ status: "error" });
    const items = [activity("a", "TJ Saint-Pierre"), activity("b", "TJ Saint-Pierre")];
    expect([...(await loadAmbiguousTribunalCodes(items))].sort()).toEqual(["a", "b"]);
    expect((await loadAmbiguousTribunalCodes([items[0]])).size).toBe(0);
  });
});
