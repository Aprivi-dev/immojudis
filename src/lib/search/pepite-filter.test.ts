import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PEPITE_IDS_API_PATH,
  fetchPepiteSaleIds,
  pepitesActive,
  resetPepiteSaleIdsCache,
} from "./pepite-filter";

const fetchMock = vi.fn();

function answer(body: unknown, ok = true) {
  fetchMock.mockResolvedValue({ ok, json: async () => body });
}

describe("liste publique des pépites", () => {
  beforeEach(() => {
    resetPepiteSaleIdsCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lit la liste une seule fois pour toute la page, pas une fois par carte", async () => {
    answer({ ids: ["AAA", "bbb"] });
    const lists = await Promise.all(Array.from({ length: 24 }, () => fetchPepiteSaleIds(1_000)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(PEPITE_IDS_API_PATH, expect.anything());
    expect([...lists[0]]).toEqual(["aaa", "bbb"]);
  });

  it("garde la liste 5 minutes, puis la relit", async () => {
    answer({ ids: ["aaa"] });
    await fetchPepiteSaleIds(0);
    await fetchPepiteSaleIds(299_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchPepiteSaleIds(301_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("une erreur (429, 503) est levée et n'est pas gardée : pas de « aucune pépite » en cache sur une panne passagère", async () => {
    answer({}, false);
    await expect(fetchPepiteSaleIds(0)).rejects.toThrow("momentanément indisponible");
    answer({ ids: ["aaa"] });
    expect([...(await fetchPepiteSaleIds(1))]).toEqual(["aaa"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("une panne réseau ou une réponse illisible sont levées aussi, jamais prises pour une liste vide", async () => {
    fetchMock.mockRejectedValue(new Error("réseau"));
    await expect(fetchPepiteSaleIds(0)).rejects.toThrow();
    resetPepiteSaleIdsCache();
    fetchMock.mockResolvedValue({ ok: true, json: async () => "n'importe quoi" });
    await expect(fetchPepiteSaleIds(0)).rejects.toThrow("momentanément indisponible");
    // Une vraie liste vide (mode shadow) reste un succès, gardé 5 minutes.
    resetPepiteSaleIdsCache();
    answer({ ids: [] });
    await expect(fetchPepiteSaleIds(0)).resolves.toEqual(new Set());
    await fetchPepiteSaleIds(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("le filtre n'est proposé que si la liste n'est pas vide", () => {
    expect(pepitesActive(undefined)).toBe(false);
    expect(pepitesActive(new Set())).toBe(false);
    expect(pepitesActive(new Set(["a"]))).toBe(true);
  });
});
