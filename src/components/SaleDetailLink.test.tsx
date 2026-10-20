// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SaleDetailLink } from "./SaleDetailLink";

afterEach(cleanup);

describe("SaleDetailLink", () => {
  it("rend l'adresse simple de la fiche dans le HTML du serveur (aucune URL en plus pour les robots)", () => {
    const html = renderToString(
      <SaleDetailLink saleId="abc" returnTo="/tribunaux/bobigny">
        Bobigny
      </SaleDetailLink>,
    );
    expect(html).toContain('href="/sales/abc"');
    expect(html).not.toContain("from=");
  });

  it("ajoute l'origine côté navigateur dès que le lien est approché", () => {
    render(
      <SaleDetailLink saleId="abc" returnTo="/tribunaux/bobigny">
        Bobigny
      </SaleDetailLink>,
    );
    const link = screen.getByRole("link", { name: "Bobigny" });
    expect(link.getAttribute("href")).toBe("/sales/abc");
    fireEvent.pointerEnter(link);
    expect(link.getAttribute("href")).toBe("/sales/abc?from=%2Ftribunaux%2Fbobigny");
  });

  it("garde les gestionnaires passés par l'appelant", () => {
    let focused = 0;
    render(
      <SaleDetailLink saleId="abc" returnTo="/audiences-a-venir" onFocus={() => (focused += 1)}>
        Audience
      </SaleDetailLink>,
    );
    const link = screen.getByRole("link", { name: "Audience" });
    fireEvent.focus(link);
    expect(focused).toBe(1);
    expect(link.getAttribute("href")).toBe("/sales/abc?from=%2Faudiences-a-venir");
  });

  it("ignore une origine refusée par la validation", () => {
    render(
      <SaleDetailLink saleId="abc" returnTo="https://example.com/">
        Fiche
      </SaleDetailLink>,
    );
    const link = screen.getByRole("link", { name: "Fiche" });
    fireEvent.pointerDown(link);
    expect(link.getAttribute("href")).toBe("/sales/abc");
  });
});
