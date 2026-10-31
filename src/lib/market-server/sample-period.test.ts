import { describe, expect, it } from "vitest";
import { salesSamplePeriod } from "./sample-period";

describe("salesSamplePeriod", () => {
  it("prend la plus ancienne et la plus récente date de tout l'échantillon", () => {
    expect(salesSamplePeriod(["2024-06-01", "2022-01-15", "2025-03-30", "2023-09-09"])).toEqual({
      from: "2022-01-15",
      to: "2025-03-30",
    });
  });

  it("ignore les dates absentes ou illisibles", () => {
    expect(salesSamplePeriod([null, "n'importe quoi", undefined, "2024-02-02"])).toEqual({
      from: "2024-02-02",
      to: "2024-02-02",
    });
  });

  it("renvoie null sans date exploitable", () => {
    expect(salesSamplePeriod([])).toBeNull();
    expect(salesSamplePeriod([null, "x"])).toBeNull();
  });
});
