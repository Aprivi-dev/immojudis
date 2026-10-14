// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page, { metadata } from "./page";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_NAME", "Immojudis SAS");
  vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS", "1 rue de la Paix, 75002 Paris");
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("page publique de l'outil de recherche d'adresses", () => {
  it("dit qui l'exploite, à quoi il sert, ses limites et comment s'y opposer", () => {
    const { container } = render(<Page />);
    const text = (container.textContent ?? "").replace(/\s+/g, " ");

    expect(metadata.alternates?.canonical).toBe("/agent-information");
    expect(text).toContain("Immojudis SAS, situé à 1 rue de la Paix, 75002 Paris");
    expect(text).toContain("pour une vente précise");
    expect(text).toContain("Il cherche un seul professionnel à la fois");
    expect(text).toContain("aucune copie d’annuaire");
    expect(text).toContain("fichier robots.txt");
    expect(text).toContain("aucune offre commerciale");
    expect(text).toContain("Vous pouvez vous opposer à tout moment, sans motif");
    expect(text).toContain("contact@immojudis.example");
    expect(text).toContain("vous ne serez plus sollicité sous une autre adresse");
    expect(container.querySelector('a[href="/privacy"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://www.cnil.fr/fr/plaintes"]')).not.toBeNull();
  });
});
