import { describe, expect, it } from "vitest";
import { reportShareNotice } from "./share-notice";

describe("reportShareNotice", () => {
  it("gives the end date, the end of access and what the recipient sees", () => {
    const notice = reportShareNotice("2026-11-20T10:00:00.000Z");
    expect(notice).toContain("jusqu’au");
    expect(notice).toContain("20");
    expect(notice).toContain("fin de votre accès aux rapports");
    expect(notice).toContain("le titre du rapport et vos choix de scénario");
  });

  it("still warns about visibility without an end date", () => {
    expect(reportShareNotice(null)).toContain("tant que vous gardez l’accès aux rapports");
    expect(reportShareNotice(undefined)).toContain("le titre du rapport");
  });
});
