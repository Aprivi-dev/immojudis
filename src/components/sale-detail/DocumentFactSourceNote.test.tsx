// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import {
  DOCUMENT_ROOMS_LABEL,
  DOCUMENT_SURFACE_LABEL,
  type DocumentFactSource,
} from "@/lib/document-fact-sources";
import { DocumentFactSourceNote } from "./DocumentFactSourceNote";

const PIECE_URL = "https://example.test/pieces/cahier.pdf";
const PIECE_KEY = createHash("sha256").update(PIECE_URL, "utf8").digest("hex");
const surface: DocumentFactSource = {
  key: "app_surface_m2",
  documentType: "cahier_conditions_vente",
  page: 12,
  documentKey: PIECE_KEY,
};
const MENTION = "Surface relevée automatiquement dans la pièce « Cahier des conditions », page 12.";

afterEach(cleanup);

describe("mention « relevée automatiquement » d'une valeur de la fiche", () => {
  it("dit la valeur, la pièce et la page en texte, sans lien quand la fiche ne sert pas la pièce", () => {
    render(<DocumentFactSourceNote items={[{ label: DOCUMENT_SURFACE_LABEL, source: surface }]} />);
    const mention = screen.getByTestId("document-fact-source");
    expect(mention.textContent).toBe(MENTION);
    expect(within(mention).queryByRole("link")).toBeNull();
  });

  it("fait de la pièce un lien vers sa page quand la vue sert déjà la pièce (offre, déblocage)", async () => {
    render(
      <DocumentFactSourceNote
        items={[{ label: DOCUMENT_SURFACE_LABEL, source: surface }]}
        documents={{ documents_rich: [{ url: PIECE_URL, label: "Cahier" }] }}
      />,
    );
    const link = await screen.findByRole("link");
    expect(link.textContent).toBe("la pièce « Cahier des conditions », page 12 (nouvel onglet)");
    expect(link.getAttribute("href")).toBe(`${PIECE_URL}#page=12`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByTestId("document-fact-source").textContent).toBe(
      "Surface relevée automatiquement dans la pièce « Cahier des conditions », page 12 (nouvel onglet).",
    );
  });

  it("ne fait pas de lien vers une pièce que la vue ne sert pas", async () => {
    render(
      <DocumentFactSourceNote
        items={[{ label: DOCUMENT_SURFACE_LABEL, source: surface }]}
        documents={{ documents_rich: [{ url: "https://example.test/pieces/autre.pdf" }] }}
      />,
    );
    // Laisse au calcul des empreintes le temps de finir.
    await waitFor(() => expect(screen.getByTestId("document-fact-source")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("réunit deux valeurs de la même page, et ne dit rien sans valeur relevée", () => {
    const { rerender } = render(
      <DocumentFactSourceNote
        items={[
          { label: DOCUMENT_SURFACE_LABEL, source: surface },
          { label: DOCUMENT_ROOMS_LABEL, source: { ...surface, key: "rooms_count" } },
        ]}
      />,
    );
    expect(screen.getByTestId("document-fact-source").textContent).toBe(
      "Surface et nombre de pièces relevés automatiquement dans la pièce « Cahier des conditions », page 12.",
    );
    rerender(<DocumentFactSourceNote items={[{ label: DOCUMENT_SURFACE_LABEL, source: null }]} />);
    expect(screen.queryByTestId("document-fact-source")).toBeNull();
  });

  it("reste accessible, lien compris", async () => {
    const { container } = render(
      <p>
        62,4 m²
        <DocumentFactSourceNote
          items={[{ label: DOCUMENT_SURFACE_LABEL, source: surface }]}
          documents={{ documents_rich: [{ url: PIECE_URL }] }}
        />
      </p>,
    );
    await screen.findByRole("link");
    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });
});
