import { describe, expect, it } from "vitest";
import {
  buildLawyerStatementCsv,
  lawyerStatementCsvFilename,
  lawyerStatementMonthLabel,
  lawyerStatementMonthSchema,
  lawyerStatementMonthStart,
  parseLawyerStatement,
  previousLawyerStatementMonth,
} from "./lawyer-statement";

const lawyerA = "c6400000-1000-4000-8000-000000000001";
const lawyerB = "c6400000-1000-4000-8000-000000000002";

const rows = [
  {
    lawyer_id: lawyerA,
    display_name: "Maître Claire Durand",
    firm_name: "Cabinet Durand",
    impressions: 120,
    cta_clicks: 7,
    referral_requests_sent: 2,
  },
  {
    lawyer_id: lawyerB,
    display_name: '=Maître Piégé; "Test"',
    firm_name: null,
    impressions: 30,
    cta_clicks: 0,
    referral_requests_sent: 0,
  },
];

describe("lawyer statement month", () => {
  it("accepts a calendar month and refuses anything else", () => {
    expect(lawyerStatementMonthSchema.safeParse("2026-11").success).toBe(true);
    for (const bad of ["2026-13", "2026-00", "2026-1", "2026-11-01", "novembre", "", null]) {
      expect(lawyerStatementMonthSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("turns the month into the first day expected by the SQL function", () => {
    expect(lawyerStatementMonthStart("2026-11")).toBe("2026-11-01");
    expect(() => lawyerStatementMonthStart("2026-11-15")).toThrow();
  });

  it("proposes the previous month in Paris time, across the new year", () => {
    expect(previousLawyerStatementMonth(new Date("2026-11-20T10:00:00Z"))).toBe("2026-10");
    expect(previousLawyerStatementMonth(new Date("2027-01-05T10:00:00Z"))).toBe("2026-12");
    // 30 November 23:30 UTC is already 1 December in Paris.
    expect(previousLawyerStatementMonth(new Date("2026-11-30T23:30:00Z"))).toBe("2026-11");
  });

  it("labels the month in French", () => {
    expect(lawyerStatementMonthLabel("2026-11")).toBe("novembre 2026");
    expect(lawyerStatementMonthLabel("2027-02")).toBe("février 2027");
  });
});

describe("parseLawyerStatement", () => {
  it("maps the rows and totals the three counts", () => {
    const statement = parseLawyerStatement("2026-11", rows);

    expect(statement.month).toBe("2026-11");
    expect(statement.rows[0]).toEqual({
      lawyerId: lawyerA,
      displayName: "Maître Claire Durand",
      firmName: "Cabinet Durand",
      impressions: 120,
      ctaClicks: 7,
      referralRequestsSent: 2,
    });
    expect(statement.rows[1].firmName).toBeNull();
    expect(statement.totals).toEqual({ impressions: 150, ctaClicks: 7, referralRequestsSent: 2 });
  });

  it("reads an empty statement and refuses rows outside the contract", () => {
    expect(parseLawyerStatement("2026-11", null).rows).toEqual([]);
    expect(parseLawyerStatement("2026-11", []).totals).toEqual({
      impressions: 0,
      ctaClicks: 0,
      referralRequestsSent: 0,
    });
    expect(() => parseLawyerStatement("2026-11", [{ lawyer_id: "x" }])).toThrow();
    expect(() => parseLawyerStatement("2026-11", [{ ...rows[0], impressions: -1 }])).toThrow();
  });

  it("carries no field other than the lawyer identity and the counts", () => {
    const withBuyerData = [{ ...rows[0], requester_email: "buyer@example.test", phone: "06" }];

    const [row] = parseLawyerStatement("2026-11", withBuyerData).rows;

    expect(Object.keys(row).sort()).toEqual([
      "ctaClicks",
      "displayName",
      "firmName",
      "impressions",
      "lawyerId",
      "referralRequestsSent",
    ]);
    expect(JSON.stringify(row)).not.toContain("buyer@example.test");
  });
});

describe("buildLawyerStatementCsv", () => {
  it("writes a header, one line per lawyer and a total, separated by semicolons", () => {
    const csv = buildLawyerStatementCsv(parseLawyerStatement("2026-11", rows));
    const lines = csv.split("\r\n");

    expect(lines[0]).toBe("mois;avocat;cabinet;affichages;clics;demandes_transmises");
    expect(lines[1]).toBe("2026-11;Maître Claire Durand;Cabinet Durand;120;7;2");
    expect(lines.at(-1)).toBe("2026-11;Total;;150;7;2");
    expect(lines).toHaveLength(4);
  });

  it("neutralises spreadsheet formulas and quotes separators", () => {
    const csv = buildLawyerStatementCsv(parseLawyerStatement("2026-11", rows));

    expect(csv).toContain(`"'=Maître Piégé; ""Test"""`);
    expect(csv).not.toMatch(/;=Maître/);
  });

  it("still has its header and total for an empty month", () => {
    const csv = buildLawyerStatementCsv(parseLawyerStatement("2026-11", []));

    expect(csv.split("\r\n")).toEqual([
      "mois;avocat;cabinet;affichages;clics;demandes_transmises",
      "2026-11;Total;;0;0;0",
    ]);
  });

  it("names the file after the month", () => {
    expect(lawyerStatementCsvFilename("2026-11")).toBe("immojudis-releve-avocats-2026-11.csv");
  });
});
