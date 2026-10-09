import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disableMapboxTelemetry } from "./mapbox";
import { saleVerificationExplanation, saleVerificationLabel } from "./sale-procedure";

const ROOT = process.cwd();

describe("télémétrie Mapbox", () => {
  it("remplace l'accesseur EVENTS_URL en lecture seule par une valeur nulle", () => {
    const config = {
      get EVENTS_URL() {
        return "https://events.mapbox.com/events/v2";
      },
    };
    disableMapboxTelemetry({ config });
    expect(config.EVENTS_URL).toBeNull();
  });

  it("ne plante pas sans configuration", () => {
    expect(() => disableMapboxTelemetry(null)).not.toThrow();
    expect(() => disableMapboxTelemetry({})).not.toThrow();
  });

  it("est appelée à chaque chargement de Mapbox", () => {
    for (const file of [
      "src/components/search/MapPanel.tsx",
      "src/components/MapboxPreviewButton.tsx",
      "src/components/sale-detail/CadastralNeighborhoodMap.tsx",
    ]) {
      expect(readFileSync(join(ROOT, file), "utf8")).toContain("disableMapboxTelemetry(");
    }
  });
});

describe("badges de vérification", () => {
  const statuses = ["verified", "cross_checked", "pending", "conflict"] as const;

  it("donnent une explication différente, qui commence par leur libellé", () => {
    const explanations = statuses.map((status) => saleVerificationExplanation(status));
    expect(new Set(explanations).size).toBe(4);
    statuses.forEach((status, index) => {
      expect(explanations[index].startsWith(saleVerificationLabel(status))).toBe(true);
    });
  });
});

describe("icônes et manifeste", () => {
  it("fournit le favicon, l'icône Apple 180×180 et le manifeste", () => {
    expect(statSync(join(ROOT, "public/favicon.ico")).size).toBeGreaterThan(100);
    const apple = readFileSync(join(ROOT, "public/apple-touch-icon.png"));
    expect(apple.subarray(1, 4).toString()).toBe("PNG");
    expect(apple.readUInt32BE(16)).toBe(180);
    expect(apple.readUInt32BE(20)).toBe(180);

    const manifest = JSON.parse(readFileSync(join(ROOT, "public/manifest.webmanifest"), "utf8"));
    expect(manifest.name).toBe("Immojudis");
    expect(manifest.lang).toBe("fr");
    for (const icon of manifest.icons as { src: string }[]) {
      expect(existsSync(join(ROOT, "public", icon.src))).toBe(true);
    }
  });

  it("le gabarit racine déclare ces icônes et le manifeste", () => {
    const layout = readFileSync(join(ROOT, "src/app/layout.tsx"), "utf8");
    expect(layout).toContain("/favicon.ico");
    expect(layout).toContain("/apple-touch-icon.png");
    expect(layout).toContain("/manifest.webmanifest");
  });
});

describe("plan cadastral", () => {
  it("n'appelle plus la couche WMTS de data.geopf.fr (404) : flux WMS uniquement", () => {
    const source = readFileSync(
      join(ROOT, "src/components/sale-detail/CadastralNeighborhoodMap.tsx"),
      "utf8",
    );
    expect(source).not.toContain("data.geopf.fr/wmts");
    expect(source).toContain("data.geopf.fr/wms-r/wms");
  });
});
