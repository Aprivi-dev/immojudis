// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PhotoCredit } from "./PhotoCredit";

afterEach(cleanup);

it("affiche « Photo : via [source] » avec un lien sûr vers l'annonce d'origine", () => {
  render(
    <PhotoCredit credit={{ label: "Licitor", href: "https://www.licitor.com/annonce/1.html" }} />,
  );

  expect(screen.getByTestId("photo-credit").textContent).toBe("Photo : via Licitor");
  const link = screen.getByRole("link", { name: "Licitor" });
  expect(link.getAttribute("href")).toBe("https://www.licitor.com/annonce/1.html");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("nofollow noopener noreferrer");
});

it("sans annonce d'origine, le nom de la source seul, sans lien", () => {
  render(<PhotoCredit credit={{ label: "Vench", href: null }} />);

  expect(screen.getByTestId("photo-credit").textContent).toBe("Photo : via Vench");
  expect(screen.queryByRole("link")).toBeNull();
});

it("source inconnue : « Photo : source de l'annonce », sans lien ni hôte", () => {
  render(<PhotoCredit credit={{ label: null, href: null }} />);

  expect(screen.getByTestId("photo-credit").textContent).toBe("Photo : source de l'annonce");
  expect(screen.queryByRole("link")).toBeNull();
});

it("n'affiche rien sans crédit", () => {
  const { container } = render(<PhotoCredit credit={null} />);
  expect(container.innerHTML).toBe("");
});
