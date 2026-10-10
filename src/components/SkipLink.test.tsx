// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkipLink } from "./SkipLink";

afterEach(cleanup);

describe("lien « Aller au contenu »", () => {
  it("pointe vers #contenu et place le focus sur le contenu principal", () => {
    render(
      <>
        <SkipLink />
        <main>
          <h1>Titre</h1>
        </main>
      </>,
    );
    const link = screen.getByRole("link", { name: "Aller au contenu" });
    expect(link.getAttribute("href")).toBe("#contenu");
    fireEvent.click(link);
    const main = document.querySelector("main")!;
    expect(main.id).toBe("contenu");
    expect(document.activeElement).toBe(main);
  });
});

describe("contenu principal", () => {
  const ROOT = process.cwd();
  // Pages à contenu figé : le lien d'évitement leur attribue l'identifiant au clic.
  const FROZEN = [
    /routes\/(legal|conditions-generales|privacy)\.tsx$/,
    /global-error\.tsx$/,
    /SkipLink\.tsx$/,
  ];

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
    });
  }

  it('chaque <main> porte id="contenu"', () => {
    const offenders = files(join(ROOT, "src"))
      .filter((path) => !FROZEN.some((pattern) => pattern.test(path)))
      .filter((path) =>
        [...readFileSync(path, "utf8").matchAll(/<main(?=[\s>])[^>]*>/g)].some(
          (match) => !/\bid=/.test(match[0]),
        ),
      )
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });

  it("le gabarit racine affiche le lien d'évitement", () => {
    expect(readFileSync(join(ROOT, "src/app/layout.tsx"), "utf8")).toContain("<SkipLink />");
  });
});
