import { describe, expect, it } from "vitest";
import { ALERT_DETAIL_COLUMNS, ALERT_EVALUATION_COLUMNS, SALE_LIST_COLUMNS } from "./sale-views";

describe("colonnes lues par les alertes", () => {
  const evaluation = ALERT_EVALUATION_COLUMNS.split(",");

  it("laissent de côté les colonnes lourdes de la vue", () => {
    for (const column of [
      "source_blocks",
      "source_blocks_by_source",
      "documents",
      "documents_rich",
      "media",
      "description",
      "llm_display_description",
    ]) {
      expect(evaluation).not.toContain(column);
    }
  });

  it("gardent les critères d'une alerte et le résumé d'une correspondance", () => {
    for (const column of [
      "id",
      "department",
      "city",
      "postal_code",
      "property_type",
      "starting_price_eur",
      "sale_date",
      "app_surface_m2",
      "land_surface_m2",
      "occupancy_status",
      "investment_score",
      "latitude",
      "longitude",
      "sale_venue_type",
      "updated_at",
    ]) {
      expect(evaluation).toContain(column);
    }
  });

  it("relisent à part les blocs des sources et les pièces, toutes présentes dans la liste", () => {
    expect(ALERT_DETAIL_COLUMNS).toBe("id,source_blocks,documents,documents_rich");
    const list = SALE_LIST_COLUMNS.split(",");
    for (const column of [...evaluation, ...ALERT_DETAIL_COLUMNS.split(",")]) {
      expect(list).toContain(column);
    }
  });
});
