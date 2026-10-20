// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceSummary } from "@/lib/resource-articles";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span data-testid="image" data-alt={alt} />,
}));

import { ResourceCard } from "./ResourceCard";

afterEach(cleanup);

const article = {
  slug: "frais-encheres",
  href: "/ressources/frais-encheres",
  title: "Les frais d’une vente aux enchères",
  description: "Ce qui s’ajoute au prix d’adjudication.",
  category: "Frais",
  readingMinutes: 6,
  image: "/media/frais.webp",
} as unknown as ResourceSummary;

describe("ResourceCard", () => {
  it("nomme le lien par son contenu : pas d'aria-labelledby réduit au titre", () => {
    render(<ResourceCard article={article} />);
    const link = screen.getByRole("link");
    expect(link.hasAttribute("aria-labelledby")).toBe(false);
    const name = link.textContent ?? "";
    expect(name).toContain("Les frais d’une vente aux enchères");
    expect(name).toContain("Lire l’article");
    expect(screen.getByRole("link", { name: /Lire l’article/ })).toBe(link);
  });
});
