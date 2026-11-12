import { describe, expect, it } from "vitest";
import { CNB_SEARCH_URL } from "@/lib/cnb-directory";
import { GET } from "./route";

describe("GET /api/lawyers/cnb-redirect", () => {
  it("poste le code du barreau trouvé vers l'annuaire du CNB, valeurs échappées", async () => {
    const response = await GET(
      new Request("https://immojudis.com/api/lawyers/cnb-redirect?bar=Agen"),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`action="${CNB_SEARCH_URL}"`);
    expect(html).toContain('<input type="hidden" name="barreau" value="0002">');
  });

  it("renvoie vers l'annuaire sans formulaire pour un barreau inconnu", async () => {
    const response = await GET(
      new Request("https://immojudis.com/api/lawyers/cnb-redirect?bar=%22%3E%3Cscript%3E"),
    );
    expect(response.status).toBe(307);
  });
});
