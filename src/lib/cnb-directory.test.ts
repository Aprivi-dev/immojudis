import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/lawyers/cnb-redirect/route";
import { CNB_DIRECTORY_URL, findCnbBarAssociation } from "@/lib/cnb-directory";

describe("CNB directory routing", () => {
  it("résout les principaux barreaux et les noms de tribunaux", () => {
    expect(findCnbBarAssociation("Barreau de Paris")?.code).toBe("0131");
    expect(findCnbBarAssociation("Lyon")?.code).toBe("0101");
    expect(findCnbBarAssociation("Bobigny")?.code).toBe("0033");
    expect(findCnbBarAssociation("Bourg-en-Bresse")?.code).toBe("0037");
    expect(findCnbBarAssociation("ville inconnue")).toBeNull();
  });

  it("génère une soumission CNB filtrée par barreau et droit immobilier", async () => {
    const response = await GET(
      new Request("https://immojudis.fr/api/lawyers/cnb-redirect?bar=Paris"),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('action="https://annuaire.avocat.fr/eAnnuaire/resultats"');
    expect(html).toContain('name="barreau" value="0131"');
    expect(html).toContain('name="mentions" value="29"');
  });

  it("revient à l'annuaire général si le barreau n'est pas reconnu", async () => {
    const response = await GET(
      new Request("https://immojudis.fr/api/lawyers/cnb-redirect?bar=ville-inconnue"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(CNB_DIRECTORY_URL);
  });
});
