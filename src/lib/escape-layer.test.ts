// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { escapeBelongsToAnotherLayer } from "./escape-layer";

afterEach(() => {
  document.body.innerHTML = "";
});

function escapeEvent(options: { prevented?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  if (options.prevented) event.preventDefault();
  return event;
}

describe("escapeBelongsToAnotherLayer", () => {
  it("laisse la bulle se fermer quand aucun dialogue n'est ouvert", () => {
    document.body.innerHTML = "<button id='own'>pastille</button>";
    expect(escapeBelongsToAnotherLayer(escapeEvent(), document.getElementById("own"))).toBe(false);
  });

  it("laisse un dialogue qui a déjà traité Échap à lui seul", () => {
    document.body.innerHTML = "<button id='own'>pastille</button>";
    expect(
      escapeBelongsToAnotherLayer(escapeEvent({ prevented: true }), document.getElementById("own")),
    ).toBe(true);
  });

  it("ne ferme pas la bulle sous un dialogue ouvert qui ne la contient pas", () => {
    document.body.innerHTML =
      "<button id='own'>pastille</button><div role='dialog' data-state='open'>fenêtre</div>";
    expect(escapeBelongsToAnotherLayer(escapeEvent(), document.getElementById("own"))).toBe(true);
  });

  it("reconnaît un dialogue modal et un <dialog> natif ouvert", () => {
    document.body.innerHTML =
      "<button id='own'>pastille</button><div role='dialog' aria-modal='true'>fenêtre</div>";
    expect(escapeBelongsToAnotherLayer(escapeEvent(), document.getElementById("own"))).toBe(true);
    document.body.innerHTML = "<button id='own'>pastille</button><dialog open>fenêtre</dialog>";
    expect(escapeBelongsToAnotherLayer(escapeEvent(), document.getElementById("own"))).toBe(true);
  });

  it("ferme la bulle qui se trouve dans le dialogue ouvert : c'est la couche du dessus", () => {
    document.body.innerHTML =
      "<div role='dialog' data-state='open'><button id='own'>pastille</button></div>";
    expect(escapeBelongsToAnotherLayer(escapeEvent(), document.getElementById("own"))).toBe(false);
  });

  it("ignore un dialogue fermé ou non modal", () => {
    document.body.innerHTML =
      "<button id='own'>pastille</button><div role='dialog' data-state='closed'>bandeau</div>";
    expect(escapeBelongsToAnotherLayer(escapeEvent(), document.getElementById("own"))).toBe(false);
  });
});
