// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TermsPage } from "./conditions-generales";
import { LegalPage } from "./legal";
import { PrivacyPage } from "./privacy";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

// Le flou d'arrière-plan (.liquid-panel-soft) sur les sections très hautes des pages juridiques
// gèle le rendu de WebKit (src/styles.css, .liquid-panel-flat).
describe.each([
  ["/privacy", () => <PrivacyPage />],
  ["/legal", () => <LegalPage />],
  ["/conditions-generales", () => <TermsPage />],
])("sections de %s", (_path, page) => {
  it("n'utilisent pas le panneau à flou d'arrière-plan", () => {
    const { container } = render(page());
    const sections = [...container.querySelectorAll("section")];
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.classList.contains("liquid-panel-soft")).toBe(false);
    }
    expect(container.querySelectorAll("section.liquid-panel-flat").length).toBeGreaterThan(0);
  });
});
