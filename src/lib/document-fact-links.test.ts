import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { documentFactLinks } from "./document-fact-links";

const PIECE_URL = "https://example.test/pieces/cahier des conditions.pdf";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const PIECE_KEY = sha(PIECE_URL);

describe("lien vers la pièce", () => {
  const cited = [{ documentKey: PIECE_KEY, page: 12 }];

  it("mène à la page citée d'une pièce que la vue sert déjà", async () => {
    const links = await documentFactLinks([{ url: PIECE_URL, label: "Cahier" }], cited);
    expect(links.get(`${PIECE_KEY}|12`)).toBe(
      "https://example.test/pieces/cahier%20des%20conditions.pdf#page=12",
    );
  });

  it("ne fait aucun lien sans la pièce : fiche publique, offre Découverte, autre pièce", async () => {
    expect((await documentFactLinks(undefined, cited)).size).toBe(0);
    expect((await documentFactLinks([], cited)).size).toBe(0);
    expect((await documentFactLinks([{ url: "https://example.test/autre.pdf" }], cited)).size).toBe(
      0,
    );
    expect(
      (await documentFactLinks([{ url: PIECE_URL }], [{ documentKey: null, page: 12 }])).size,
    ).toBe(0);
  });

  it("ne fait aucun lien vers une adresse que la fiche ne proposerait pas", async () => {
    const script = "javascript:alert(1)";
    const links = await documentFactLinks(
      [{ url: script }, null, "texte"],
      [{ documentKey: sha(script), page: 1 }],
    );
    expect(links.size).toBe(0);
  });
});
