import { describe, expect, it } from "vitest";
import {
  aiReviewDisplayValue,
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
} from "./ai-review-guard";

const row = (
  overrides: Partial<AiReviewProjectionReadModel> = {},
): AiReviewProjectionReadModel => ({
  auction_sale_id: "sale-1",
  field_key: "property.property_type",
  review_state: "resolved",
  citation_status: "verified",
  is_publishable: true,
  source_name: "avoventes",
  source_url: "https://source.example/vente-1",
  ...overrides,
});

describe("getAiReviewFieldResult", () => {
  it("leaves a field untouched when no AI projection row is provided", () => {
    const result = getAiReviewFieldResult([], "property.property_type");

    expect(result).toMatchObject({ status: "not_reviewed", blocked: false });
  });

  it.each([
    ["unresolved", "La relecture IA n’a pas permis de trancher."],
    ["unverified", "La citation de la relecture IA n’est pas vérifiée dans la capture source."],
  ] as const)("blocks an explicitly %s field and keeps provenance", (reviewState, reason) => {
    const result = getAiReviewFieldResult(
      [row({ review_state: reviewState, citation_status: "unverified", is_publishable: false })],
      "property.property_type",
    );

    expect(result).toMatchObject({
      status: "blocked",
      blocked: true,
      label: "À confirmer",
      reason,
      sourceName: "avoventes",
      sourceUrl: "https://source.example/vente-1",
    });
    expect(aiReviewDisplayValue("Appartement", result, "À confirmer")).toBe("À confirmer");
  });

  it("fails closed for a non-publishable absent or unknown row", () => {
    const result = getAiReviewFieldResult(
      [row({ review_state: "unknown", is_publishable: false })],
      "property.property_type",
    );

    expect(result.blocked).toBe(true);
    expect(result.label).toBe("À confirmer");
  });

  it("keeps publishable unknown rows visible without calling them verified", () => {
    const result = getAiReviewFieldResult(
      [row({ review_state: "unknown", is_publishable: true })],
      "property.property_type",
    );

    expect(result).toMatchObject({ status: "not_reviewed", blocked: false, label: null });
  });

  it("blocks the field when one of several projections is blocked", () => {
    const result = getAiReviewFieldResult(
      [row(), row({ review_state: "unresolved", is_publishable: false })],
      "property.property_type",
    );

    expect(result.status).toBe("blocked");
  });

  it("blocks a server-detected canonical value drift without showing a verified label", () => {
    const result = getAiReviewFieldResult(
      [row({ canonical_value_matches: false })],
      "property.property_type",
    );

    expect(result).toMatchObject({
      status: "blocked",
      blocked: true,
      label: "À confirmer",
      reason: "La valeur relue ne correspond plus à la valeur canonique actuelle.",
    });
  });

  it("blocks a sale that disappeared from the current catalogue view", () => {
    const result = getAiReviewFieldResult(
      [
        row({
          review_state: "unresolved",
          citation_status: "not_required",
          is_publishable: false,
          sale_unavailable: true,
          source_name: null,
          source_url: null,
        }),
      ],
      "property.property_type",
    );

    expect(result).toMatchObject({
      status: "blocked",
      blocked: true,
      label: "À confirmer",
      reason: "Cette annonce n’est plus disponible dans le catalogue actuel.",
      sourceName: null,
      sourceUrl: null,
    });
  });

  it("does not treat a different field as evidence for this field", () => {
    const result = getAiReviewFieldResult(
      [
        row({
          field_key: "property.rooms_count",
          review_state: "unresolved",
          is_publishable: false,
        }),
      ],
      "property.property_type",
    );

    expect(result.status).toBe("not_reviewed");
    expect(aiReviewDisplayValue("Appartement", result, "À confirmer")).toBe("Appartement");
  });

  it.each(["loading", "error"] as const)(
    "keeps an unsampled field visible when the review request is %s and has no scoped row",
    (requestStatus) => {
      const result = getAiReviewFieldResult([], "property.property_type", requestStatus);

      expect(result).toMatchObject({ status: "not_reviewed", blocked: false, label: null });
    },
  );

  it.each(["loading", "error"] as const)(
    "blocks a known scoped row while the review request is %s",
    (requestStatus) => {
      const result = getAiReviewFieldResult(
        [row({ review_state: "unresolved", is_publishable: false })],
        "property.property_type",
        requestStatus,
      );

      expect(result).toMatchObject({ status: "blocked", blocked: true, label: "À confirmer" });
    },
  );
});
