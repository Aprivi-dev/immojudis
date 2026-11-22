// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TermsRoute from "@/app/conditions-generales/page";
import LegalRoute from "@/app/legal/page";
import PrivacyRoute from "@/app/privacy/page";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

// Le flou d'arrière-plan des panneaux sur les sections très hautes des pages juridiques gèle le
// rendu de WebKit : l'enveloppe .legal-document le retire (src/styles.css). Elle est posée dans
// src/app/…/page.tsx, hors des fichiers soumis à l'empreinte des documents (src/routes/…).
describe.each([
  ["/privacy", PrivacyRoute],
  ["/legal", LegalRoute],
  ["/conditions-generales", TermsRoute],
])("page %s", (_path, Page) => {
  it("rend ses sections dans l'enveloppe .legal-document", () => {
    const { container } = render(<Page />);
    const sections = [...container.querySelectorAll("section.liquid-panel-soft")];
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.closest(".legal-document")).not.toBeNull();
    }
  });
});

describe("règle .legal-document .liquid-panel-soft", () => {
  it("retire le flou d'arrière-plan et le calque forcé, sans changer la mise en page", () => {
    const css = readFileSync(resolve("src/styles.css"), "utf8");
    const rule = /\.legal-document \.liquid-panel-soft \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/(^|\s)backdrop-filter: none;/);
    expect(rule).toContain("-webkit-backdrop-filter: none;");
    expect(rule).toContain("transform: none;");
    expect(/\.legal-document \{([^}]*)\}/.exec(css)?.[1]).toContain("display: contents;");
  });
});
