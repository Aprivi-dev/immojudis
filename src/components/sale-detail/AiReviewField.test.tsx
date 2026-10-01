// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import { AiReviewField } from "./AiReviewField";

afterEach(cleanup);

const blocked: AiReviewProjectionReadModel = {
  auction_sale_id: "sale-1",
  field_key: "property.property_type",
  review_state: "unverified",
  citation_status: "unverified",
  is_publishable: false,
  source_name: "AGRASC",
  source_url: "https://agrasc.gouv.fr/vente/1",
};

describe("AiReviewField", () => {
  it("suppresses the raw value and keeps a safe source link when blocked", () => {
    render(
      <AiReviewField fieldKey="property.property_type" projections={[blocked]}>
        Appartement
      </AiReviewField>,
    );

    expect(screen.queryByText("Appartement")).toBeNull();
    expect(screen.getByText("À confirmer")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Source : AGRASC/ }).getAttribute("href")).toBe(
      "https://agrasc.gouv.fr/vente/1",
    );
  });

  it("retains the value when the projection is publishable", () => {
    render(
      <AiReviewField
        fieldKey="property.property_type"
        projections={[
          {
            ...blocked,
            review_state: "resolved",
            citation_status: "verified",
            is_publishable: true,
          },
        ]}
      >
        Appartement
      </AiReviewField>,
    );

    expect(screen.getByText("Appartement")).toBeTruthy();
    expect(screen.queryByText("À confirmer")).toBeNull();
  });

  it("does not create a nested link in a card and still shows provenance text", () => {
    render(
      <AiReviewField
        fieldKey="property.property_type"
        projections={[blocked]}
        showSourceLink={false}
      >
        Appartement
      </AiReviewField>,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Source : AGRASC/)).toBeTruthy();
  });

  it.each(["loading", "error"] as const)(
    "fails closed when the authenticated review request is %s",
    (reviewStatus) => {
      render(
        <AiReviewField
          fieldKey="property.property_type"
          projections={[blocked]}
          reviewStatus={reviewStatus}
          sourceName="AGRASC"
          sourceUrl="https://agrasc.gouv.fr/vente/1"
        >
          Appartement
        </AiReviewField>,
      );

      expect(screen.queryByText("Appartement")).toBeNull();
      expect(screen.getByText("À confirmer")).toBeTruthy();
      expect(screen.getByText(/Source : AGRASC/)).toBeTruthy();
    },
  );

  it.each(["loading", "error"] as const)(
    "keeps an unsampled canonical value visible when the review request is %s",
    (reviewStatus) => {
      render(
        <AiReviewField fieldKey="property.property_type" reviewStatus={reviewStatus}>
          Appartement
        </AiReviewField>,
      );

      expect(screen.getByText("Appartement")).toBeTruthy();
      expect(screen.queryByText("À confirmer")).toBeNull();
    },
  );
});
