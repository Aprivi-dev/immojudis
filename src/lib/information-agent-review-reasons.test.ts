import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_DISPLAYED_REVIEW_REASONS,
  REVIEW_REASON_CODES,
  REVIEW_REASON_LABELS,
  reviewReasonLabels,
} from "./information-agent-review-reasons";

const PYTHON_MODULE = join(
  process.cwd(),
  "services/data-pipeline/src/information_agent_review_signals.py",
);

function pythonReviewReasons(): Record<string, string> {
  const source = readFileSync(PYTHON_MODULE, "utf8");
  const block = /REVIEW_REASON_LABELS: dict\[str, str\] = \{([\s\S]*?)\n\}/u.exec(source)?.[1];
  if (!block) throw new Error("REVIEW_REASON_LABELS introuvable dans le module Python");
  return Object.fromEntries(
    [...block.matchAll(/^\s*"([a-z_]+)":\s*"([^"]+)",?$/gmu)].map((match) => [match[1], match[2]]),
  );
}

describe("motifs de relecture : une seule liste", () => {
  it("mêmes codes et mêmes libellés côté TypeScript, côté Python et dans l'onglet Réponses", () => {
    expect(pythonReviewReasons()).toEqual(REVIEW_REASON_LABELS);
    const panel = readFileSync(
      join(process.cwd(), "src/components/admin/AdminInformationAgentReviewPanel.tsx"),
      "utf8",
    );
    // L'onglet Réponses lit la liste commune, il n'en garde pas une copie.
    expect(panel).toContain('from "@/lib/information-agent-review-reasons"');
    for (const code of REVIEW_REASON_CODES) expect(panel).not.toContain(`${code}:`);
  });

  it("affiche « motif non reconnu » pour un code inconnu et borne le nombre de motifs", () => {
    expect(reviewReasonLabels({ review_reasons: ["value_range", "<script>"] })).toEqual([
      "fourchette de valeurs",
      "motif non reconnu",
    ]);
    const many = reviewReasonLabels({ review_reasons: REVIEW_REASON_CODES });
    expect(many).toHaveLength(MAX_DISPLAYED_REVIEW_REASONS + 1);
    expect(many.at(-1)).toBe(
      `et ${REVIEW_REASON_CODES.length - MAX_DISPLAYED_REVIEW_REASONS} autres motifs`,
    );
    expect(reviewReasonLabels(null)).toEqual([]);
    expect(reviewReasonLabels({ review_reasons: "value_range" })).toEqual([]);
  });
});
