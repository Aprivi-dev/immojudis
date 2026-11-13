import { describe, expect, it } from "vitest";
import { byEvaluationDate, recordBatchFailure } from "@/lib/batch-pass";

describe("bilan d'une passe planifiée", () => {
  it("compte chaque échec et ne garde que les cinq premiers messages", () => {
    const result = { failed: 0, errors: [] as string[] };
    for (let index = 0; index < 7; index += 1) {
      recordBatchFailure(result, 2, new Error(`panne ${index}`));
    }
    expect(result.failed).toBe(14);
    expect(result.errors).toEqual(["panne 0", "panne 1", "panne 2", "panne 3", "panne 4"]);
  });

  it("reprend d'abord l'évaluation la plus ancienne, l'identifiant départage", () => {
    const rows = [
      { id: "b", evaluatedAt: 2 },
      { id: "c", evaluatedAt: 1 },
      { id: "a", evaluatedAt: 2 },
    ];
    expect(rows.sort(byEvaluationDate).map((row) => row.id)).toEqual(["c", "a", "b"]);
  });
});
