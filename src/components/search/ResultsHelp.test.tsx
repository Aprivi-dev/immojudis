// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { ResultsHelp, SALE_TYPES_HELP_PATH } from "./ResultsHelp";

afterEach(cleanup);

it("réunit les trois liens d'aide dans une seule région", () => {
  render(<ResultsHelp />);
  const help = screen.getByRole("region", { name: "Aide à la lecture des résultats" });
  expect(
    within(help)
      .getByRole("link", { name: "Quelle différence entre les types de vente ?" })
      .getAttribute("href"),
  ).toBe(SALE_TYPES_HELP_PATH);
  expect(
    within(help).getByRole("link", { name: "Audiences de la semaine" }).getAttribute("href"),
  ).toBe("/audiences-a-venir");
  expect(within(help).getByText("Comment sont classées les annonces ?")).toBeTruthy();
});

it("transmet les options du classement (score d'investissement, pépites)", () => {
  render(<ResultsHelp investmentScore pepites />);
  screen.getByText("Comment sont classées les annonces ?").click();
  expect(document.body.textContent).toContain("Score d’investissement");
  expect(document.body.textContent).toContain("Le repère « Pépite » ne change ni l’ordre");
});

it("figure dans le HTML du serveur : de simples liens, sans JavaScript", () => {
  const html = renderToString(<ResultsHelp />);
  expect(html).toContain('href="/audiences-a-venir"');
  expect(html).toContain('href="/ventes-immobilieres-judiciaires#differences"');
});
