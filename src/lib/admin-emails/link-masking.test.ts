import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { MASKED_LINK, maskActionLinks, toInertEmailDocument } from "./link-masking";

const ACTION_LINKS = [
  // Désinscription signée et clic suivi des emails d'alerte.
  "https://immojudis.test/api/notification-preferences/unsubscribe?token=abc.def",
  "https://immojudis.test/api/email/click?token=FACTICE",
  // Opposition et dépôt de l'agent.
  "https://immojudis.test/api/information-agent/opt-out?e=bWFpdHJl&t=0a1b2c",
  "https://immojudis.test/depot/3f2a9c1e7b4d4e0f9a6b5c4d3e2f1a0b",
  // Authentification : confirmation d'adresse, lien magique, réinitialisation.
  "https://projet.supabase.co/auth/v1/verify?token=pkce_abc&type=signup&redirect_to=https://immojudis.test",
  "https://immojudis.test/auth/confirm?token_hash=abcdef&type=recovery",
  "https://immojudis.test/reinitialiser-mot-de-passe#access_token=abc",
  // Partage de rapport.
  "https://immojudis.test/partage/rapport/AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  // Sans schéma, avec parenthèses.
  "//immojudis.test/api/x?t=1",
  "/api/unsubscribe?t=1",
  "https://immojudis.test/x/(a)?t=SECRETFACTICE",
];

/** Corps du document reconstruit (sans l'enveloppe posée par nous). */
function bodyOf(html: string): string {
  const document = toInertEmailDocument(html);
  expect(document).not.toBeNull();
  return (document as string)
    .replace(/^<!doctype html><meta[^>]*><meta[^>]*><body>/, "")
    .replace(/<\/body>$/, "");
}

describe("maskActionLinks", () => {
  it.each(ACTION_LINKS)("masque %s", (url) => {
    const masked = maskActionLinks(`Cliquez ici : ${url} merci`);
    expect(masked).toBe(`Cliquez ici : ${MASKED_LINK} merci`);
    expect(masked).not.toMatch(/token|SECRET|api/);
  });

  it("masque aussi une URL illisible, dans le doute", () => {
    expect(maskActionLinks("http://[::1")).toContain(MASKED_LINK);
  });

  it("masque une URL coupée par un retour à la ligne", () => {
    const masked = maskActionLinks("https://immojudis.test/reinitialiser?\ntoken=FACTICE\nmerci");
    expect(masked).not.toContain("FACTICE");
    expect(masked).toContain(MASKED_LINK);
  });

  it("laisse une page publique ordinaire", () => {
    const text = "Voir https://immojudis.test/tribunaux/paris et https://immojudis.test/";
    expect(maskActionLinks(text)).toBe(text);
  });
});

describe("toInertEmailDocument : document reconstruit", () => {
  const hostile = `
    <html><head><title>x</title><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test">
    <link rel="stylesheet" href="https://evil.test/a.css"><style>.t { color: rgb(1, 2, 3); background: url(https://evil.test/p.png) } @import "x";</style></head>
    <body onload="alert(1)">
      <script>fetch("https://immojudis.test/api/email/click?token=FACTICE")</script>
      <a href="https://immojudis.test/api/notification-preferences/unsubscribe?token=FACTICE" ping="https://evil.test">Se désinscrire</a>
      <a href="javascript:alert(1)">piège</a>
      <img src="https://immojudis.test/pixel.gif" alt="Logo Immojudis">
      <form action="https://evil.test"><input name="x"><button>OK</button></form>
      <iframe src="https://evil.test"></iframe>
      <p class="t" style="color: red; background-image: url(//evil.test/x)">Bonjour</p>
    </body></html>`;
  const body = bodyOf(hostile);

  it("n'émet aucun lien, aucune ressource, aucune balise active", () => {
    expect(violations(body)).toEqual([]);
    expect(body).not.toMatch(/FACTICE|evil\.test|javascript:/i);
  });

  it("garde le texte, les styles inoffensifs, remplace img par son texte alt et a par un span", () => {
    expect(body).toContain("Se désinscrire");
    expect(body).toContain('<span style="text-decoration:underline">Se désinscrire</span>');
    expect(body).toContain("[Logo Immojudis]");
    expect(body).toContain("Bonjour");
    expect(body).toContain("color: rgb(1, 2, 3)");
    expect(body).not.toMatch(/url\s*\(|@import/i);
  });

  it("interdit toute requête par une politique de sécurité du contenu", () => {
    const document = toInertEmailDocument(hostile) as string;
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("img-src 'none'");
    expect(document).toContain("navigate-to 'none'");
  });

  it("rend null quand il ne reste aucun texte", () => {
    expect(toInertEmailDocument("<script>alert(1)</script><img src=x>")).toBeNull();
    expect(toInertEmailDocument("")).toBeNull();
  });
});

const BYPASSES: Array<[string, string]> = [
  [
    "balise meta reformée",
    '<me<meta>ta http-equiv="refresh" content="0;url=//immojudis.test/api/x?t=AAA">',
  ],
  ["script reformé", "<scr<script>ipt>alert(1)</scr<script>ipt>"],
  ["script coupé par un script vide", "<scr<script></script>ipt>alert(1)</script>"],
  ["scripts imbriqués", "<<script>script>alert(1)<</script>/script>"],
  ["base reformée", '<ba<base>se href="//evil.example/">'],
  ["input reformé", '<fo<input>rm action="//immojudis.test/api/x?t=1"><button>go</button>'],
  ["iframe imbriquée", "<ifr<iframe></iframe>ame src=x></iframe>"],
  ["gestionnaire imbriqué", '<a oonclick=x nclick="y">lien</a>'],
  ["gestionnaire reformé", '<img oonnclick="x"nclick="alert(1)" alt="x">'],
  ["href après une barre", '<a/href="//immojudis.test/api/confirm?t=AAA">x</a>'],
  ["href collé à un attribut", '<a title="x"href="//immojudis.test/api/confirm?t=AAA">x</a>'],
  ["href en majuscules", '<A HREF="//immojudis.test/api/x">x</A>'],
  ["href après un retour à la ligne", '<a\nhref="//immojudis.test/api/x">x</a>'],
  ["ping", '<a href="https://immojudis.test/" ping="https://immojudis.test/api/x?t=1">x</a>'],
  ["area", '<map><area href="//immojudis.test/api/x" shape=default></map>'],
  [
    "srcset et style",
    '<img srcset="//immojudis.test/api/x?t=1 1x"><div style="background:url(//immojudis.test/api/x?t=1)">x</div>',
  ],
  ["style reformé", '<div style="background:uurl(rl(//evil.test/x)">x</div>'],
  ["svg", '<svg><a xlink:href="//immojudis.test/api/x"><text>x</text></a></svg>'],
  ["schéma data", '<a href="data:text/html,<script>alert(1)</script>">piège</a>'],
  ["schéma data en texte", "data:text/html;base64,PHNjcmlwdD4="],
  ["schéma vbscript", '<a href="vbscript:msgbox(1)">piège</a>'],
  ["schéma javascript espacé", '<a href="JaVaScRiPt :alert(1)">piège</a>'],
  ["entité deux-points", '<a href="https&colon;//immojudis.test/api/x?t=AAA">x</a>'],
  ["entité numérique", '<a href="https&#58;//immojudis.test/api/x?t=AAA">x</a>'],
  ["entité dans le texte", "https&#58;//immojudis.test/api/x?t=SECRETFACTICE"],
  ["URL coupée par une balise", "https://immojudis.test/<wbr>api/x?t=SECRETFACTICE"],
  ["URL coupée par une balise en ligne", "https://immojudis.test/reset?t=SEC<b></b>RETFACTICE"],
  ["parenthèses", "Voir https://immojudis.test/x/(a)?t=SECRETFACTICE"],
  ["sans schéma", "Voir //immojudis.test/api/x?t=SECRETFACTICE ou /api/y?t=SECRETFACTICE"],
];

describe("toInertEmailDocument : contournements connus", () => {
  it.each(BYPASSES)("%s", (_name, html) => {
    const document = toInertEmailDocument(`${html} texte`);
    expect(document).not.toBeNull();
    const body = (document as string).replace(/^<!doctype html><meta[^>]*><meta[^>]*><body>/, "");
    expect(violations(body)).toEqual([]);
    expect(body).not.toMatch(/SECRETFACTICE|t=AAA/);
  });
});

/** Analyse la sortie : aucune balise ni attribut hors liste blanche, quoi qu'on lui donne. */
function violations(document: string): string[] {
  const found: string[] = [];
  const allowedTags = new Set([
    "body",
    "meta",
    "style",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "p",
    "div",
    "span",
    "h1",
    "h2",
    "h3",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "br",
    "hr",
    "ul",
    "ol",
    "li",
    "center",
    "font",
    "small",
    "sup",
    "sub",
    "blockquote",
    "pre",
    "code",
  ]);
  const allowedAttributes = new Set([
    "style",
    "class",
    "width",
    "height",
    "align",
    "valign",
    "bgcolor",
    "border",
    "cellpadding",
    "cellspacing",
    "colspan",
    "rowspan",
    "role",
    "dir",
    "lang",
    "http-equiv",
    "content",
    "name",
  ]);
  const parser = new Parser({
    onopentag(name, attributes) {
      if (!allowedTags.has(name)) found.push(`balise ${name}`);
      for (const attribute of Object.keys(attributes)) {
        if (!allowedAttributes.has(attribute)) found.push(`attribut ${attribute}`);
        if (
          /(?:javascript|vbscript|data)\s*:\s*(?:text|alert|msgbox)/i.test(attributes[attribute]) &&
          attribute !== "content"
        ) {
          found.push(`schéma actif dans ${attribute}`);
        }
      }
    },
  });
  parser.end(document);
  return found;
}

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const FRAGMENTS = [
  "<",
  ">",
  "</",
  "/>",
  "=",
  '"',
  "'",
  " ",
  "\n",
  "&",
  "&#58;",
  "&colon;",
  "&lt;",
  ";",
  ":",
  "//",
  "/api/",
  "https://",
  "immojudis.test",
  "?t=",
  "token",
  "FACTICE",
  "script",
  "iframe",
  "meta",
  "base",
  "form",
  "input",
  "area",
  "a",
  "img",
  "svg",
  "style",
  "href",
  "src",
  "action",
  "ping",
  "srcset",
  "onclick",
  "onerror",
  "on",
  "javascript:",
  "vbscript:",
  "data:",
  "url(",
  "@import",
  "<a href=",
  "<img src=",
  "<script>",
  "</script>",
  "<scr",
  "ipt>",
  "<me",
  "ta ",
  "<style>",
  "</style>",
  "<div style=",
  "alt=",
  "<p>",
  "</p>",
  "<b>",
  "x",
  "é",
];

function randomHtml(next: () => number): string {
  const count = 1 + Math.floor(next() * 40);
  let html = "";
  for (let index = 0; index < count; index += 1) {
    html += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
  }
  return html;
}

describe("toInertEmailDocument : propriétés sur des entrées aléatoires", () => {
  const next = seeded(20261101);
  const inputs = Array.from({ length: 1500 }, () => `${randomHtml(next)} texte`);

  it("n'émet jamais de balise ni d'attribut hors liste blanche", () => {
    for (const input of inputs) {
      const document = toInertEmailDocument(input);
      if (document === null) continue;
      const body = document.replace(/^<!doctype html><meta[^>]*><meta[^>]*>/, "");
      expect(violations(body), input).toEqual([]);
    }
  });

  it("est idempotent : toInert(toInert(x)) === toInert(x)", () => {
    let rebuilt = 0;
    for (const input of inputs) {
      const once = toInertEmailDocument(input);
      if (once === null) continue;
      rebuilt += 1;
      expect(toInertEmailDocument(once), input).toBe(once);
    }
    // Le test ne vaut que si la plupart des entrées produisent un document.
    expect(rebuilt).toBeGreaterThan(inputs.length * 0.8);
  });
});

describe("toInertEmailDocument : coût", () => {
  it("traite 50 000 balises <form non fermées en moins de 100 ms", () => {
    const started = performance.now();
    toInertEmailDocument("<form ".repeat(50_000));
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("traite 20 000 balises imbriquées sans s'emballer", () => {
    const started = performance.now();
    expect(toInertEmailDocument("<div>".repeat(20_000) + "texte")).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
