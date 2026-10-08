// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DocumentsList } from "./DocumentsList";

afterEach(cleanup);

it("shows extraction limits beside each original document link", () => {
  render(
    <DocumentsList
      documents={[
        {
          url: "https://www.info-encheres.com/upload/partial.pdf",
          label: "Grand dossier",
          extraction_status: "incomplete",
          text_chars: 500_000,
        },
        {
          url: "https://www.info-encheres.com/upload/pending.pdf",
          label: "Annexe",
          extraction_status: "pending",
        },
        {
          url: "https://www.info-encheres.com/upload/read.pdf",
          label: "Diagnostic",
          extraction_status: "extracted",
          text_chars: 1800,
        },
      ]}
    />,
  );
  expect(screen.getByText("Extraction partielle · certaines pages restent à lire.")).toBeTruthy();
  expect(screen.getByText("Texte en attente d’extraction.")).toBeTruthy();
  expect(
    screen.getByText("Texte récupéré · informations à vérifier dans la pièce originale."),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: /Grand dossier/ }).getAttribute("href")).toBe(
    "https://www.info-encheres.com/upload/partial.pdf",
  );
});
