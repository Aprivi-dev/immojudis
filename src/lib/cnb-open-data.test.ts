import { describe, expect, it } from "vitest";
import {
  decodeCnbCsv,
  normalizeBarKey,
  parseCnbRealEstateLawyers,
  selectLatestCnbDatasetResource,
} from "@/lib/cnb-open-data";

const resource = {
  id: "resource-20260615",
  title: "annuaire-avocats-20260615.csv",
  url: "https://static.data.gouv.fr/resources/cnb/annuaire-avocats-20260615.csv",
  publishedAt: "2026-06-15T12:57:04.692Z",
};

describe("CNB open data", () => {
  it("sélectionne l'export portant la date la plus récente", () => {
    expect(
      selectLatestCnbDatasetResource([
        {
          id: "older",
          title: "annuaire-avocats-20260515.csv",
          url: "https://static.data.gouv.fr/resources/cnb/older.csv",
          format: "csv",
          type: "main",
          last_modified: "2026-07-01T00:00:00Z",
        },
        {
          id: resource.id,
          title: resource.title,
          url: resource.url,
          format: "csv",
          type: "main",
          last_modified: resource.publishedAt,
        },
      ]).id,
    ).toBe(resource.id);
  });

  it("ne conserve que les spécialistes en droit immobilier", () => {
    const csv = [
      "Export national du Conseil national des barreaux",
      "NomBarreau;avNom;avPrenom;cbRaisonSociale;cbSiretSiren;cbAdresse1;cbAdresse2;cbCp;cbVille;spLibelle1;spLibelle2;spLibelle3;acDateSerment;avLang;",
      'PARIS;DUPONT;Élise;"Cabinet Dupont; Associés";123456789;10 rue de Rivoli;;75001;PARIS;Droit immobilier;Droit public;;20120314;Français, Anglais;',
      "PARIS;MARTIN;Louis;Martin Avocat;987654321;12 rue de Lyon;;75012;PARIS;Droit fiscal;;;20190502;Français;",
    ].join("\r\n");

    const result = parseCnbRealEstateLawyers(csv, resource, new Date("2026-07-14T12:00:00Z"));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bar_association: "PARIS",
      bar_key: "paris",
      display_name: "Élise DUPONT",
      firm_name: "Cabinet Dupont; Associés",
      oath_date: "2012-03-14",
      languages: ["Français", "Anglais"],
      specializations: ["Droit immobilier", "Droit public"],
    });
    expect(result[0]?.source_key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepte les colonnes renommées dans l'export CNB de juillet 2026", () => {
    const csv = [
      "civilit;acSalarie;Barreau;BarreauId;avCnbfCode;avLANG;avNom;avPrenom;avBarEntree;cbAdresse1;cbAdresse2;cbCp;cbVille;cbTel;cbFax;cbSiretSiren;cbSiretNic;cbRaisonSociale;acDateEntree;cbFormJuri;acdateentree;avMelOrdre;spLibelle1;spLibelle2;spLibelle3;acDateSerment;avDateExer;avInscription;",
      "F;0;PARIS;0075;300730;Français, Anglais;DUPONT;Élise;20190101;10 rue de Rivoli;;75001;PARIS;;;123456789;;Cabinet Dupont;20200101;CABI;20200101;contact@example.test;Droit immobilier;;;20120314;20190101;1;",
    ].join("\n");

    const result = parseCnbRealEstateLawyers(csv, resource, new Date("2026-07-27T12:00:00Z"));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bar_association: "PARIS",
      display_name: "Élise DUPONT",
      languages: ["Français", "Anglais"],
      specializations: ["Droit immobilier"],
    });
  });

  it("décode aussi les anciens exports Windows-1252", () => {
    const bytes = Uint8Array.from([0x41, 0x76, 0x6f, 0x63, 0x61, 0x74, 0x20, 0xe9]);
    expect(decodeCnbCsv(bytes)).toBe("Avocat é");
  });

  it("normalise les libellés de barreau", () => {
    expect(normalizeBarKey("Barreau d’Aix-en-Provence ")).toBe("aix en provence");
  });
});
