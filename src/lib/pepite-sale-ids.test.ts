import { describe, expect, it, vi } from "vitest";
import { isMissingPepiteFunction, listPepiteSaleIds } from "./pepite-sale-ids";

const client = (result: { data: unknown; error: unknown }) => ({
  rpc: vi.fn().mockResolvedValue(result),
});

describe("lecture de la liste des pépites", () => {
  it("rend les identifiants en minuscules", async () => {
    const rpc = client({ data: ["ABC", "def"], error: null });
    await expect(listPepiteSaleIds(rpc)).resolves.toEqual(["abc", "def"]);
    expect(rpc.rpc).toHaveBeenCalledWith("list_public_pepite_sale_ids");
  });

  it.each(["PGRST202", "42883"])("une fonction absente (%s) vaut aucune pépite", async (code) => {
    expect(isMissingPepiteFunction({ code })).toBe(true);
    await expect(listPepiteSaleIds(client({ data: null, error: { code } }))).resolves.toEqual([]);
  });

  it("lève toute autre erreur : une panne n'est jamais prise pour « aucune pépite » en cache", async () => {
    const failure = { code: "57014" };
    await expect(listPepiteSaleIds(client({ data: null, error: failure }))).rejects.toBe(failure);
  });

  it("ignore une réponse hors contrat", async () => {
    await expect(listPepiteSaleIds(client({ data: { ids: [] }, error: null }))).resolves.toEqual(
      [],
    );
  });
});
