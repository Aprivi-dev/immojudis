import { describe, expect, it } from "vitest";
import { capMapPoints } from "./map-points";

const sales = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: Array<{ id: string }>) => list.map((sale) => sale.id);

describe("capMapPoints", () => {
  it("laisse la liste telle quelle sous le plafond", () => {
    expect(ids(capMapPoints(sales("a", "b", "c"), 5, new Set(["c"])))).toEqual(["a", "b", "c"]);
  });

  it("garde l'ordre de la recherche au plafond quand il n'y a aucune pépite", () => {
    expect(ids(capMapPoints(sales("a", "b", "c", "d"), 2, undefined))).toEqual(["a", "b"]);
    expect(ids(capMapPoints(sales("a", "b", "c", "d"), 2, new Set()))).toEqual(["a", "b"]);
  });

  it("met les pépites avant les autres ventes quand le plafond coupe la liste", () => {
    const cut = capMapPoints(sales("a", "b", "c", "d", "e"), 3, new Set(["d", "e"]));
    expect(ids(cut)).toEqual(["d", "e", "a"]);
  });

  it("reconnaît un identifiant en capitales et plafonne même les pépites", () => {
    const cut = capMapPoints(sales("A1", "B2", "C3"), 2, new Set(["b2", "c3"]));
    expect(ids(cut)).toEqual(["B2", "C3"]);
    expect(capMapPoints(sales("x", "y", "z"), 1, new Set(["y", "z"])).map((s) => s.id)).toEqual([
      "y",
    ]);
  });
});
