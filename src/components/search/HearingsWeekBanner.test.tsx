// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { HearingsWeekBanner } from "./HearingsWeekBanner";

afterEach(cleanup);

it("renvoie, discrètement, vers les audiences de la semaine", () => {
  render(<HearingsWeekBanner />);
  expect(screen.getByRole("link", { name: "Audiences de la semaine" }).getAttribute("href")).toBe(
    "/audiences-a-venir",
  );
});

it("figure dans le HTML du serveur : un simple lien, sans JavaScript", () => {
  expect(renderToString(<HearingsWeekBanner />)).toContain('href="/audiences-a-venir"');
});
