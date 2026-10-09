// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SiteFooter, showsSiteFooter } from "./SiteFooter";

const pathname = vi.hoisted(() => ({ current: "/sales" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

beforeEach(() => {
  pathname.current = "/sales";
});
afterEach(cleanup);

it("gives every public page access to the legal documents", () => {
  render(<SiteFooter />);
  const legal = within(screen.getByRole("navigation", { name: "Informations légales" }));
  expect(legal.getByRole("link", { name: "Mentions légales" }).getAttribute("href")).toBe("/legal");
  expect(legal.getByRole("link", { name: "Conditions générales" }).getAttribute("href")).toBe(
    "/conditions-generales",
  );
  expect(legal.getByRole("link", { name: "Confidentialité" }).getAttribute("href")).toBe(
    "/privacy",
  );
  expect(legal.getByRole("link", { name: "Mes droits" }).getAttribute("href")).toBe("/mes-droits");
});

it("stays out of the admin console", () => {
  expect(showsSiteFooter("/admin")).toBe(false);
  expect(showsSiteFooter("/admin/operations")).toBe(false);
  expect(showsSiteFooter("/administration-publique")).toBe(true);
  pathname.current = "/admin/quality";
  const { container } = render(<SiteFooter />);
  expect(container.querySelector("footer")).toBeNull();
});
