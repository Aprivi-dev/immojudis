import { describe, expect, it } from "vitest";
import { HOSTILE_LOCAL_LOOKING_PATHS, VALID_LOCAL_PATHS } from "@/test/open-redirect-cases";
import { sameSitePath } from "./same-site-path";

const SITE_ORIGIN = "https://immojudis.com";

describe("sameSitePath", () => {
  it.each(VALID_LOCAL_PATHS)(
    "garde la page du site %j, en chemin ou en adresse absolue",
    (path) => {
      expect(sameSitePath(path, SITE_ORIGIN)).toBe(path);
      expect(sameSitePath(`${SITE_ORIGIN}${path}`, SITE_ORIGIN)).toBe(path);
    },
  );

  it("rend le chemin reconstruit, points résolus", () => {
    expect(sameSitePath("/tribunaux/../favoris", SITE_ORIGIN)).toBe("/favoris");
    expect(sameSitePath("/sales?x=%", SITE_ORIGIN)).toBe("/sales?x=%");
  });

  it.each(HOSTILE_LOCAL_LOOKING_PATHS)("refuse %j, en chemin ou en adresse absolue", (path) => {
    expect(sameSitePath(path, SITE_ORIGIN)).toBeNull();
    expect(sameSitePath(`${SITE_ORIGIN}${path}`, SITE_ORIGIN)).toBeNull();
  });

  it("refuse des `%25` empilés sans y passer un temps quadratique", () => {
    expect(sameSitePath("/%" + "25".repeat(5000) + "41", SITE_ORIGIN)).toBeNull();
  });

  it("voit un `%2F%2F` en tête même si un `%` mal formé suit", () => {
    expect(sameSitePath("/%2F%2Fevil.example?x=%", SITE_ORIGIN)).toBeNull();
  });

  it.each(["https://evil.example/", "javascript:alert(1)", "http://immojudis.com/sales", "//["])(
    "refuse une autre origine ou une adresse illisible : %j",
    (candidate) => {
      expect(sameSitePath(candidate, SITE_ORIGIN)).toBeNull();
    },
  );

  it("propriété : tout chemin rendu commence par un seul `/` et reste sur le site", () => {
    const pieces = ["/", "\\", ".", "..", "%2e", "%2E", "%2f", "%2F", "%5c", "%5C", "%09", "%0a"];
    const more = ["%25", "\t", "evil.example", "?", "#", "a", "@", ":"];
    const all = [...pieces, ...more];
    let seed = 2026;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 4000; i += 1) {
      let candidate = "/";
      for (let j = 0, length = 1 + (next() % 8); j < length; j += 1) {
        candidate += all[next() % all.length];
      }
      const path = sameSitePath(candidate, SITE_ORIGIN);
      if (path === null) continue;
      // Ni le chemin rendu, ni aucune de ses formes décodées ne mène ailleurs.
      for (let form = path, previous = ""; form !== previous; ) {
        expect(form, candidate).toMatch(/^\/(?![/\\])/);
        expect(new URL(form, SITE_ORIGIN).origin, candidate).toBe(SITE_ORIGIN);
        expect(new URL(form, SITE_ORIGIN).pathname, candidate).toMatch(/^\/(?![/\\])/);
        previous = form;
        form = form.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
      }
    }
  });
});
