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

  it("ne rapproche que des mots entiers et connaît les sièges sans barreau homonyme", () => {
    // « bains » contient « ain » : Thonon ne doit pas tomber sur le barreau de l'Ain.
    expect(findCnbBarAssociation("Thonon-les-Bains")?.code).toBe("0169");
    expect(findCnbBarAssociation("Digne-les-Bains")?.code).toBe("0067");
    expect(findCnbBarAssociation("Le Mans")?.code).toBe("0091");
    expect(findCnbBarAssociation("Mans")?.code).toBe("0091");
    expect(findCnbBarAssociation("Évry-Courcouronnes")?.code).toBe("0076");
    expect(findCnbBarAssociation("Perpignan")?.code).toBe("0135");
    expect(findCnbBarAssociation("St Gaudens")?.code).toBe("0152");
    expect(findCnbBarAssociation("Saint-Pierre")?.code).toBe("0156");
    expect(findCnbBarAssociation("Saint-Pierre-et-Miquelon")?.code).toBe("0183");
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
