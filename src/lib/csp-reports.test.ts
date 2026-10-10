import { describe, expect, it } from "vitest";
import { summarizeCspReports } from "./csp-reports";

describe("CSP report parsing", () => {
  it("reads the legacy report-uri format and strips query strings", () => {
    const [report] = summarizeCspReports(
      JSON.stringify({
        "csp-report": {
          "document-uri": "https://immojudis.com/sales?token=secret",
          "violated-directive": "script-src-elem",
          "effective-directive": "script-src-elem",
          "blocked-uri": "inline",
          disposition: "report",
          "line-number": 12,
        },
      }),
    );
    expect(report).toMatchObject({
      directive: "script-src-elem",
      documentUri: "https://immojudis.com/sales",
      blockedUri: "inline",
      disposition: "report",
      line: 12,
    });
  });

  it("reads the Reporting API format", () => {
    const reports = summarizeCspReports(
      JSON.stringify([
        {
          type: "csp-violation",
          body: {
            effectiveDirective: "frame-src",
            blockedURL: "https://docs.example.test/a.pdf?x=1",
            documentURL: "https://immojudis.com/sales/1",
            disposition: "report",
          },
        },
        { type: "deprecation", body: {} },
      ]),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      directive: "frame-src",
      blockedUri: "https://docs.example.test/a.pdf",
    });
  });

  it("ignores malformed payloads", () => {
    expect(summarizeCspReports("not json")).toEqual([]);
    expect(summarizeCspReports("42")).toEqual([]);
    expect(summarizeCspReports("[null, 1, {}]")).toEqual([]);
  });
});
