// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  GUIDE_LAST_UPDATED,
  GUIDE_READING_MINUTES,
  READING_WORDS_PER_MINUTE,
  ResourcesPage,
  formatGuideDate,
  lexiqueAnchor,
  lexiqueSlug,
} from "./resources-guide";

/** Espaces insécables (fine ou non) ramenées à une espace ordinaire, pour comparer des textes. */
const plain = (text: string) =>
  text
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

afterEach(cleanup);

describe("guide des ventes immobilières judiciaires", () => {
  it("renvoie la section frais vers le simulateur de frais", () => {
    const { container } = render(<ResourcesPage />);
    const section = container.querySelector("#frais");
    expect(section).not.toBeNull();
    const link = Array.from(section!.querySelectorAll("a")).find(
      (anchor) => anchor.getAttribute("href") === "/simulateur-frais-encheres",
    );
    expect(link?.textContent).toBe("simulateur de frais d’enchères");
    expect(screen.getAllByRole("link", { name: "simulateur de frais d’enchères" })).toHaveLength(1);
  });

  it("a un plan de titres sans saut de niveau : un h1, puis jamais plus d'un niveau d'écart", () => {
    const { container } = render(<ResourcesPage />);
    const levels = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((heading) =>
      Number(heading.tagName.slice(1)),
    );
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    // The first heading after the h1 is an h2 (it used to be an h3 in the intro cards).
    expect(levels[1]).toBe(2);
    levels.forEach((level, index) => {
      if (index > 0) expect(level - levels[index - 1]).toBeLessThanOrEqual(1);
    });
  });

  describe("lexique", () => {
    it.each([
      ["Mise à prix", "lexique-mise-a-prix"],
      ["Adjudication", "lexique-adjudication"],
      ["Surenchère", "lexique-surenchere"],
      ["Consignation du prix", "lexique-consignation-du-prix"],
      ["Enchère plafond", "lexique-enchere-plafond"],
      ["Droit de préemption", "lexique-droit-de-preemption"],
    ])("donne au terme « %s » l'ancre %s", (term, anchor) => {
      expect(lexiqueAnchor(term)).toBe(anchor);
      const { container } = render(<ResourcesPage />);
      const target = container.querySelector(`#${anchor}`);
      expect(target).not.toBeNull();
      expect(target!.closest("#lexique")).not.toBeNull();
      expect(target!.tagName).toBe("DT");
      expect(plain(target!.textContent ?? "")).toBe(term);
    });

    it("fabrique des slugs sans accents, avec des tirets pour les espaces et les apostrophes", () => {
      expect(lexiqueSlug("Réitération des enchères")).toBe("reiteration-des-encheres");
      expect(lexiqueSlug("Vente à l’amiable d'un bien")).toBe("vente-a-l-amiable-d-un-bien");
    });

    it("n'a pas deux termes avec la même ancre", () => {
      const { container } = render(<ResourcesPage />);
      const ids = Array.from(container.querySelectorAll("#lexique dt")).map((dt) => dt.id);
      expect(ids.length).toBeGreaterThan(5);
      expect(new Set(ids).size).toBe(ids.length);
      ids.forEach((id) => expect(id).toMatch(/^lexique-[a-z0-9]+(-[a-z0-9]+)*$/));
    });

    it("a un index A–Z accessible qui renvoie à la première entrée de chaque lettre", () => {
      const { container } = render(<ResourcesPage />);
      const nav = screen.getByRole("navigation", { name: "Index alphabétique du lexique" });
      expect(container.querySelector("#lexique")!.contains(nav)).toBe(true);
      const links = Array.from(nav.querySelectorAll("a"));
      const letters = links.map((link) => link.textContent);
      expect(letters).toEqual([...letters].sort());
      expect(new Set(letters).size).toBe(letters.length);
      const terms = Array.from(container.querySelectorAll("#lexique dt"));
      for (const link of links) {
        const targetId = link.getAttribute("href")!.slice(1);
        const target = container.querySelector(`#${targetId}`)!;
        expect(target).not.toBeNull();
        // The target is the first entry that starts with this letter.
        const first = terms.find(
          (dt) => lexiqueSlug(dt.textContent ?? "")[0] === link.textContent!.toLowerCase(),
        );
        expect(first).toBe(target);
      }
      // Every letter that starts a term is in the index.
      const present = new Set(
        terms.map((dt) => lexiqueSlug(dt.textContent ?? "")[0].toUpperCase()),
      );
      expect(new Set(letters)).toEqual(present);
    });

    it("laisse la place d'un en-tête fixe au-dessus des ancres", () => {
      const { container } = render(<ResourcesPage />);
      expect(container.querySelector("#lexique-mise-a-prix")!.className).toContain("scroll-mt-");
      expect(container.querySelector("#lexique")!.className).toContain("scroll-mt-");
    });
  });

  describe("date de mise à jour", () => {
    it("affiche la même date que le dateModified des données structurées", () => {
      const { container } = render(<ResourcesPage />);
      const time = container.querySelector("time");
      expect(time).not.toBeNull();
      const script = container.querySelector('script[type="application/ld+json"]');
      const structured = JSON.parse(script!.textContent ?? "{}") as { dateModified?: string };
      expect(structured.dateModified).toBe(GUIDE_LAST_UPDATED);
      expect(time!.getAttribute("datetime")).toBe(structured.dateModified);
      expect(time!.textContent).toBe(formatGuideDate(structured.dateModified!));
      expect(time!.textContent).toBe("26/10/2026");
    });

    it("est une date AAAA-MM-JJ valide, pas postérieure à aujourd'hui", () => {
      expect(GUIDE_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const date = new Date(`${GUIDE_LAST_UPDATED}T00:00:00Z`);
      expect(date.toISOString().slice(0, 10)).toBe(GUIDE_LAST_UPDATED);
      expect(date.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("nombres", () => {
    it("n'a pas de nombre séparé de son unité (% ou €) par une espace ordinaire", () => {
      const { container } = render(<ResourcesPage />);
      const text = container.textContent ?? "";
      expect(text).not.toMatch(/\d [%€]/);
      expect(text).not.toMatch(/\d \d{3}[\u00a0\u202f ]?€/);
      expect(text).toContain("3\u202f000\u00a0€");
    });
  });

  describe("frise de la procédure", () => {
    it("est une liste ordonnée de 5 étapes, dans l'ordre de la procédure", () => {
      render(<ResourcesPage />);
      const section = screen.getByRole("region", {
        name: "La vente à la barre du tribunal en 5 étapes",
      });
      const list = section.querySelector("ol");
      expect(list).not.toBeNull();
      const items = Array.from(list!.querySelectorAll(":scope > li"));
      expect(items.map((item) => plain(item.querySelector("a")!.textContent ?? ""))).toEqual([
        "Visiter",
        "Remettre la garantie",
        "Enchérir",
        "Surenchère possible (10 jours)",
        "Payer",
      ]);
    });

    it("décrit la garantie de la 2e étape sans la confondre avec la consignation du prix", () => {
      const { container } = render(<ResourcesPage />);
      const item = container.querySelectorAll(
        'section[aria-labelledby="frise-procedure"] ol li',
      )[1];
      expect(plain(item.querySelector("a")!.textContent ?? "")).toBe("Remettre la garantie");
      const step = plain(item.querySelector("p")!.textContent ?? "");
      expect(step).toBe(
        "Remettre à l’avocat, avant les enchères, la garantie (chèque de banque ou caution bancaire irrévocable) : 10 % de la mise à prix, avec un minimum de 3 000 € en saisie immobilière (art. R. 322-41). Elle est restituée si vous ne gagnez pas.",
      );
      expect(step).not.toMatch(/consign/i);
    });

    it("annonce son périmètre (saisie au tribunal) et renvoie vers #differences", () => {
      const { container } = render(<ResourcesPage />);
      const section = container.querySelector('section[aria-labelledby="frise-procedure"]')!;
      expect(plain(section.querySelector("h2")!.textContent ?? "")).toBe(
        "La vente à la barre du tribunal en 5 étapes",
      );
      expect(plain(section.querySelector(":scope > p")!.textContent ?? "")).toBe(
        "Cette frise décrit une saisie immobilière jugée au tribunal. Chez un notaire ou pour une vente de l’État, les règles diffèrent : voir « Tribunal, notaire ou État : quelle différence ? ».",
      );
      const link = section.querySelector(':scope > p a[href="#differences"]');
      expect(link).not.toBeNull();
      expect(container.querySelector("#differences")).not.toBeNull();
    });

    it("renvoie l'étape « Payer » vers la section d'après l'adjudication, pas vers les frais", () => {
      const { container } = render(<ResourcesPage />);
      const pay = container.querySelectorAll('section[aria-labelledby="frise-procedure"] ol li')[4];
      expect(pay.querySelector("a")!.getAttribute("href")).toBe("#apres-adjudication");
    });

    it("renvoie chaque étape vers une section qui existe", () => {
      const { container } = render(<ResourcesPage />);
      const links = Array.from(
        container.querySelectorAll('section[aria-labelledby="frise-procedure"] ol a'),
      );
      expect(links).toHaveLength(5);
      for (const link of links) {
        const href = link.getAttribute("href")!;
        expect(href).toMatch(/^#/);
        expect(container.querySelector(href)).not.toBeNull();
      }
    });

    it("reprend la formulation du guide pour la surenchère", () => {
      const { container } = render(<ResourcesPage />);
      const step = plain(
        container.querySelectorAll('section[aria-labelledby="frise-procedure"] ol li')[3]
          .textContent ?? "",
      );
      const body = plain(container.querySelector("#deroulement")!.textContent ?? "");
      const phrase =
        "une surenchère d’au moins un dixième du prix principal peut être formée dans les 10 jours qui suivent l’adjudication";
      expect(step).toContain(phrase);
      expect(body).toContain(phrase);
    });
  });

  describe("encadrés « À retenir »", () => {
    it.each(["deroulement", "frais", "risques"])("%s : 3 à 4 lignes en tête de partie", (id) => {
      const { container } = render(<ResourcesPage />);
      const section = container.querySelector(`#${id}`)!;
      const note = section.querySelector('[role="note"]');
      expect(note).not.toBeNull();
      expect(note!.textContent).toContain("À retenir");
      const lines = note!.querySelectorAll("li");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines.length).toBeLessThanOrEqual(4);
      // Placed before any other paragraph of the part, except the first one for « déroulement ».
      const paragraphs = section.querySelectorAll("p");
      expect(
        note!.compareDocumentPosition(paragraphs[paragraphs.length - 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("reprend des règles déjà présentes plus bas dans le guide", () => {
      const { container } = render(<ResourcesPage />);
      const note = plain(container.querySelector("#deroulement [role='note']")!.textContent ?? "");
      const rest = plain(
        Array.from(container.querySelectorAll("#deroulement > div > :not([role='note'])"))
          .map((node) => node.textContent ?? "")
          .join(" "),
      );
      for (const phrase of [
        "une garantie de 10 % de la mise à prix, avec un minimum de 3 000 €",
        "une surenchère d’au moins un dixième du prix principal peut être formée dans les 10 jours qui suivent l’adjudication (délai reporté au premier jour ouvrable suivant s’il expire un samedi, un dimanche ou un jour férié) : l’adjudication n’est définitive qu’à l’expiration de ce délai",
        "acheteur ne porte pas lui-même les enchères",
      ]) {
        expect(note).toContain(phrase);
        expect(rest).toContain(phrase);
      }
    });
  });

  describe("articles associés", () => {
    it("renvoie vers les articles sur la saisie, la licitation et l'avocat obligatoire", () => {
      const { container } = render(<ResourcesPage />);
      const hrefs = Array.from(container.querySelectorAll("#articles-associes li a")).map((link) =>
        link.getAttribute("href"),
      );
      for (const slug of [
        "saisie-immobiliere-etapes-vente-forcee-acheteur",
        "licitation-vente-bien-indivis-encheres-acheteur",
        "avocat-obligatoire-encherir-tribunal-choisir-mandat-cout",
        "analyser-opportunite-encheres",
        "immeuble-rapport-encheres",
        "droit-de-preemption-encheres-commune-acheteur",
        "garantie-10-pourcent-cheque-banque-caution-encheres",
        "copropriete-encheres-charges-assemblees",
      ]) {
        expect(hrefs).toContain(`/ressources/${slug}`);
      }
      expect(new Set(hrefs).size).toBe(hrefs.length);
    });
  });

  describe("définitivité de l'adjudication", () => {
    it("parle d'adjudication définitive, pas d'achat définitif", () => {
      const { container } = render(<ResourcesPage />);
      const text = plain(container.querySelector("#deroulement")!.textContent ?? "");
      expect(text).not.toContain("achat n’est définitif");
      const phrase = "l’adjudication n’est définitive qu’à l’expiration de ce délai";
      // Once in the « À retenir » box, once in the checklist « Ce qui vous engage ».
      expect(text.split(phrase)).toHaveLength(3);
    });
  });

  describe("délai de surenchère", () => {
    it("dit que le dixième jour férié ou de week-end est reporté au premier jour ouvrable (art. 641 et 642 CPC)", () => {
      const { container } = render(<ResourcesPage />);
      const body = plain(
        container.querySelector("#apres-adjudication")!.parentElement!.textContent ?? "",
      );
      expect(body).toContain(
        "prorogé jusqu’au premier jour ouvrable suivant (art. 642 du même code)",
      );
      expect(body).toContain("Le jour de l’adjudication ne compte pas");
      expect(body).toContain("(art. 641 du Code de procédure civile)");
      // L'exemple chiffré : jeudi 8 octobre 2026 + 10 jours = dimanche 18, donc lundi 19.
      expect(new Date(Date.UTC(2026, 9, 8)).getUTCDay()).toBe(4);
      expect(new Date(Date.UTC(2026, 9, 18)).getUTCDay()).toBe(0);
      expect(body).toContain("le délai est prorogé jusqu’au lundi 19 octobre 2026.");
      expect(body).toContain("votre avocat vous indiquera l’heure limite de dépôt");
      expect(body).not.toContain("minuit");
    });

    it("reprend le report dans la FAQ visible et dans le JSON-LD", () => {
      const { container } = render(<ResourcesPage />);
      const script = container.querySelector('script[type="application/ld+json"]');
      const structured = JSON.parse(script!.textContent ?? "{}") as {
        mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
      };
      const question = structured.mainEntity.find((item) => item.name.includes("surenchère"));
      expect(question).toBeDefined();
      const answer = plain(question!.acceptedAnswer.text);
      expect(answer).toContain("dans les dix jours qui suivent l’adjudication");
      expect(answer).toContain(
        "le délai est prorogé jusqu’au premier jour ouvrable suivant (art. 641 et 642 du Code de procédure civile)",
      );
      const visible = plain(container.textContent ?? "");
      expect(visible).toContain(answer.slice(0, 200));
    });
  });

  describe("surenchère hors saisie : créanciers inscrits et caution du dixième", () => {
    const expected = [
      "nous n’avons identifié dans la loi que la surenchère des créanciers inscrits : lorsque l’acquéreur purge les hypothèques, tout créancier inscrit dispose de quarante jours à compter de la notification pour requérir la remise aux enchères en surenchérissant du dixième avec caution (art. 2464 et 2465 du Code civil) ; ce délai ne part pas de l’adjudication",
      "distincte de la clause de 10 % en 10 jours que seul le cahier des charges peut prévoir",
      "caution bancaire irrévocable ou un chèque de banque du dixième du prix principal (art. R. 322-51)",
    ];

    it("le dit dans le corps du guide", () => {
      const { container } = render(<ResourcesPage />);
      const body = plain(
        container.querySelector("#apres-adjudication")!.parentElement!.textContent ?? "",
      );
      for (const sentence of expected) expect(body).toContain(sentence);
      expect(body).not.toMatch(/art\. 2480|2480 à 2482/);
    });

    it("le dit dans la FAQ et le JSON-LD", () => {
      const { container } = render(<ResourcesPage />);
      const script = container.querySelector('script[type="application/ld+json"]');
      const structured = JSON.parse(script!.textContent ?? "{}") as {
        mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
      };
      const question = structured.mainEntity.find((item) => item.name.includes("surenchère"));
      const answer = plain(question!.acceptedAnswer.text);
      for (const sentence of expected) expect(answer).toContain(sentence);
    });
  });

  describe("temps de lecture", () => {
    it("correspond au nombre de mots du guide à 230 mots par minute (à une minute près)", () => {
      const { container } = render(<ResourcesPage />);
      const text = Array.from(container.querySelectorAll("article section"))
        .map((section) => section.textContent ?? "")
        .join(" ");
      const words = plain(text).split(" ").filter(Boolean).length;
      expect(READING_WORDS_PER_MINUTE).toBe(230);
      expect(
        Math.abs(words / READING_WORDS_PER_MINUTE - GUIDE_READING_MINUTES),
      ).toBeLessThanOrEqual(1);
      expect(container.querySelector("[data-reading-time]")!.textContent).toBe(
        `Temps de lecture : environ ${GUIDE_READING_MINUTES} min`,
      );
    });
  });
});
