import { describe, expect, it } from "vitest";
import { saleDetailPath } from "./navigation";

describe("saleDetailPath", () => {
  const ID = "005a914d-563c-427b-88a4-740cbf851afb";

  it("adds no ?from= when the way back is the unfiltered catalogue", () => {
    expect(saleDetailPath(ID)).toBe(`/sales/${ID}`);
    expect(saleDetailPath(ID, "/sales")).toBe(`/sales/${ID}`);
    // An empty query string is the same page.
    expect(saleDetailPath(ID, "/sales?")).toBe(`/sales/${ID}`);
  });

  it("keeps the filters of the search the visitor comes from", () => {
    expect(saleDetailPath(ID, "/sales?city=Toulouse&page=2")).toBe(
      `/sales/${ID}?from=%2Fsales%3Fcity%3DToulouse%26page%3D2`,
    );
  });

  it("keeps the listed pages a sale is opened from, as a way back", () => {
    expect(saleDetailPath(ID, "/favoris")).toBe(`/sales/${ID}?from=%2Ffavoris`);
    expect(saleDetailPath(ID, "/alertes")).toBe(`/sales/${ID}?from=%2Falertes`);
    expect(saleDetailPath(ID, "/comparaisons")).toBe(`/sales/${ID}?from=%2Fcomparaisons`);
    expect(saleDetailPath(ID, "/audiences-a-venir")).toBe(`/sales/${ID}?from=%2Faudiences-a-venir`);
    expect(saleDetailPath(ID, "/tribunaux/bordeaux")).toBe(
      `/sales/${ID}?from=%2Ftribunaux%2Fbordeaux`,
    );
  });

  it("ignores a way back that is neither the catalogue nor one of the listed pages", () => {
    for (const origin of [
      "https://evil.example/sales",
      "//evil.example/sales",
      "/favoris?x=1", // no parameter on the pages outside the catalogue
      "/favoris#section",
      "/favoris/autre",
      "/tribunaux", // the index is not a court page
      "/tribunaux/Bordeaux", // a court code is lowercase
      "/tribunaux/bordeaux/autre",
      "/admin",
      "/profil",
      "/login",
    ]) {
      expect(saleDetailPath(ID, origin), origin).toBe(`/sales/${ID}`);
    }
  });
});
