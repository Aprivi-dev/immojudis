import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALLOWED_VARIABLES,
  API_BASE,
  COMMERCIAL_WORDS,
  ENGLISH_WORDS,
  MANAGED_KEYS,
  PROJECT_REF,
  RETOUR_ARRIERE_DIRECTORY,
  TEMPLATE_IDS,
  buildPatchBody,
  computeChanges,
  contentKey,
  diffLines,
  loadLocalTemplates,
  main,
  parseArgs,
  parseTemplateSections,
  pickManaged,
  senderProblems,
  subjectKey,
  templateProblems,
} from "./apply-supabase-auth-config.mjs";

// Valeurs factices évidentes : aucun vrai secret dans ce fichier.
const FAKE_TOKEN = "FACTICE-FACTICE-FACTICE";
const FAKE_SMTP_PASS = "FACTICE-SMTP-FACTICE";
const FAKE_HOOK_SECRET = "FACTICE-HOOK-FACTICE";
const FAKE_BODY_LEAK = "FACTICE-FUITE-FACTICE";

const root = process.cwd();
const URL_AUTH_CONFIG = `${API_BASE}/v1/projects/${PROJECT_REF}/config/auth`;
const cleanup = [];

afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop(), { recursive: true, force: true });
});

async function scratchDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "auth-config-test-"));
  cleanup.push(directory);
  return directory;
}

/** Configuration « comme Supabase la renvoie » : gabarits anglais par défaut, SMTP Resend, secrets. */
function currentConfig(overrides = {}) {
  const config = {
    site_url: "https://immojudis.com",
    smtp_host: "smtp.example.test",
    smtp_port: "465",
    smtp_user: "resend",
    smtp_pass: FAKE_SMTP_PASS,
    smtp_admin_email: "assistant@immojudis.com",
    smtp_sender_name: "ImmoJudis",
    hook_send_email_secrets: FAKE_HOOK_SECRET,
    external_google_secret: FAKE_HOOK_SECRET,
    rate_limit_email_sent: 30,
  };
  for (const id of TEMPLATE_IDS) {
    config[subjectKey(id)] = `Subject ${id}`;
    config[contentKey(id)] = `<h2>Hello ${id}</h2>\n<p>Click the link</p>\n`;
  }
  return { ...config, ...overrides };
}

function fakeManagementApi(initial = currentConfig(), { onPatch, patchStatus, getStatus } = {}) {
  const state = { config: structuredClone(initial), calls: [] };
  const fetchImpl = vi.fn(async (url, init) => {
    state.calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === "GET") {
      if (getStatus)
        return new Response(JSON.stringify({ message: FAKE_BODY_LEAK }), { status: getStatus });
      return new Response(JSON.stringify(state.config), { status: 200 });
    }
    if (init.method === "PATCH") {
      await onPatch?.(JSON.parse(init.body));
      if (patchStatus)
        return new Response(JSON.stringify({ message: FAKE_BODY_LEAK }), { status: patchStatus });
      Object.assign(state.config, JSON.parse(init.body));
      return new Response(JSON.stringify(state.config), { status: 200 });
    }
    throw new Error(`Méthode inattendue : ${init.method}`);
  });
  return { state, fetchImpl };
}

function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join("") };
}

async function run(argv, { env = { SUPABASE_ACCESS_TOKEN: FAKE_TOKEN }, api, ...deps } = {}) {
  const stdout = sink();
  const stderr = sink();
  const fake = api ?? fakeManagementApi();
  const code = await main(argv, env, {
    fetchImpl: fake.fetchImpl,
    stdout,
    stderr,
    now: () => new Date("2026-11-01T12:00:00Z"),
    ...deps,
  });
  return { code, out: stdout.text(), err: stderr.text(), api: fake };
}

describe("lecture des gabarits du dépôt", () => {
  it("lit les six objets de supabase/config.toml, sans les dupliquer", async () => {
    const sections = parseTemplateSections(
      await readFile(path.join(root, "supabase/config.toml"), "utf8"),
    );
    expect(Object.keys(sections).sort()).toEqual([...TEMPLATE_IDS].sort());
    expect(sections.confirmation.subject).toBe(
      "Confirmez votre adresse email pour accéder à Immojudis",
    );
    expect(sections.reauthentication.contentPath).toBe(
      "./supabase/templates/reauthentication.html",
    );
  });

  it("variante principale : les fichiers de supabase/templates ; retour-arriere : ceux du runbook", async () => {
    const principal = await loadLocalTemplates({ root, variant: "principal" });
    const retour = await loadLocalTemplates({ root, variant: "retour-arriere" });
    expect(principal.map((template) => template.id)).toEqual(TEMPLATE_IDS);
    for (const [index, template] of principal.entries()) {
      expect(template.source).toBe(`supabase/templates/${template.id}.html`);
      expect(template.content).toBe(await readFile(path.join(root, template.source), "utf8"));
      expect(retour[index].source).toBe(`${RETOUR_ARRIERE_DIRECTORY}/${template.id}.html`);
      expect(retour[index].subject).toBe(template.subject);
    }
  });

  it("les gabarits réels du dépôt passent tous les contrôles, dans les deux variantes", async () => {
    for (const variant of ["principal", "retour-arriere"]) {
      const templates = await loadLocalTemplates({ root, variant });
      expect(templates.flatMap((template) => templateProblems(template, variant))).toEqual([]);
    }
  });

  it("garde les mêmes contrôles que src/lib/auth-email-templates.test.ts", async () => {
    const source = await readFile(path.join(root, "src/lib/auth-email-templates.test.ts"), "utf8");
    expect(source).toContain(ENGLISH_WORDS.source);
    expect(source).toContain(COMMERCIAL_WORDS.source);
    for (const variable of ALLOWED_VARIABLES) expect(source).toContain(`"${variable}"`);
  });
});

describe("contrôles des gabarits", () => {
  const good = async (id = "confirmation", variant = "principal") =>
    (await loadLocalTemplates({ root, variant })).find((template) => template.id === id);

  it("refuse un gabarit en anglais ou commercial", async () => {
    const template = await good();
    const english = {
      ...template,
      content: template.content.replace("Cordialement", "Please click here, your account"),
    };
    expect(templateProblems(english, "principal").join("\n")).toContain("mot anglais");
    const commercial = { ...template, subject: "Découvrez notre offre Immojudis" };
    expect(templateProblems(commercial, "principal").join("\n")).toContain(
      "vocabulaire commercial",
    );
  });

  it("refuse un gabarit sans lang=fr, avec une variable inconnue ou mal formé", async () => {
    const template = await good();
    expect(
      templateProblems(
        { ...template, content: template.content.replace('lang="fr"', 'lang="en"') },
        "principal",
      ).join(),
    ).toContain('<html lang="fr"> absent');
    expect(
      templateProblems(
        { ...template, content: `${template.content}{{ .Secret }}` },
        "principal",
      ).join(),
    ).toContain("variable inconnue {{ .Secret }}");
    expect(
      templateProblems({ ...template, content: `${template.content} }}` }, "principal").join(),
    ).toContain("mal formé");
  });

  it("exige le lien attendu selon la variante", async () => {
    const principal = await good("recovery", "principal");
    const retour = await good("recovery", "retour-arriere");
    expect(templateProblems(retour, "principal").join("\n")).toContain(
      "lien /auth/confirmer absent",
    );
    expect(templateProblems(retour, "principal").join("\n")).toContain("{{ .ConfirmationURL }}");
    expect(templateProblems(principal, "retour-arriere").join("\n")).toContain(
      "{{ .ConfirmationURL }} absent",
    );
    expect(templateProblems(principal, "retour-arriere").join("\n")).toContain(
      "ne doit pas mener à /auth/confirmer",
    );
  });

  it("la réauthentification n'a pas de lien mais exige le code", async () => {
    const template = await good("reauthentication");
    expect(templateProblems(template, "principal")).toEqual([]);
    expect(
      templateProblems(
        { ...template, content: template.content.replaceAll("{{ .Token }}", "000000") },
        "principal",
      ).join(),
    ).toContain("code {{ .Token }} absent");
  });

  it("l'adresse expéditrice doit être en @immojudis.com", () => {
    expect(
      senderProblems({ senderEmail: "compte@immojudis.com", senderName: "Immojudis" }),
    ).toEqual([]);
    expect(senderProblems({})).toEqual([]);
    for (const email of [
      "compte@gmail.com",
      "compte@reponses.immojudis.com",
      "compte@immojudis.com.example.test",
      "compte@immojudis.fr",
      "Immojudis <compte@immojudis.com>",
      "a@b@immojudis.com",
    ]) {
      expect(senderProblems({ senderEmail: email }), email).toHaveLength(1);
    }
    expect(senderProblems({ senderName: 'Immo"Judis' })).toHaveLength(1);
    expect(senderProblems({ senderName: "Immo\nJudis" })).toHaveLength(1);
  });
});

describe("options", () => {
  it("lit --option=valeur et --option valeur, refuse l'inconnu, le vide et les variantes inconnues", () => {
    expect(parseArgs([])).toEqual({ options: { apply: false, variant: "principal" }, errors: [] });
    expect(
      parseArgs([
        "--apply",
        "--variant=retour-arriere",
        "--sender-email",
        "compte@immojudis.com",
        "--sender-name=Immojudis",
      ]),
    ).toEqual({
      options: {
        apply: true,
        variant: "retour-arriere",
        senderEmail: "compte@immojudis.com",
        senderName: "Immojudis",
      },
      errors: [],
    });
    expect(parseArgs(["--smtp-host=x"]).errors).toEqual(["Option inconnue : --smtp-host"]);
    expect(parseArgs(["--smtp-pass=x"]).errors).toHaveLength(1);
    expect(parseArgs(["--sender-email="]).errors).toHaveLength(1);
    expect(parseArgs(["--variant=autre"]).errors).toHaveLength(1);
  });
});

describe("comparaison", () => {
  it("ignore les fins de ligne et le saut final, voit les vraies différences", () => {
    expect(computeChanges({ a: "x\r\ny\r\n" }, { a: "x\ny" })).toEqual([]);
    expect(computeChanges({ a: "x" }, { a: "y" })).toEqual([{ key: "a", before: "x", after: "y" }]);
    expect(computeChanges({}, { a: "y" })).toEqual([{ key: "a", before: null, after: "y" }]);
    expect(computeChanges({ a: null }, { a: "y" })).toHaveLength(1);
  });

  it("diff de lignes", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { type: " ", text: "a" },
      { type: "-", text: "b" },
      { type: "+", text: "x" },
      { type: " ", text: "c" },
    ]);
  });

  it("pickManaged ne garde que la liste blanche, buildPatchBody refuse smtp_host/user/pass/port", () => {
    const picked = pickManaged(currentConfig());
    expect(Object.keys(picked).sort()).toEqual([...MANAGED_KEYS].sort());
    expect(JSON.stringify(picked)).not.toContain(FAKE_SMTP_PASS);
    expect(JSON.stringify(picked)).not.toContain(FAKE_HOOK_SECRET);
    for (const key of ["smtp_host", "smtp_user", "smtp_pass", "smtp_port", "site_url"]) {
      expect(() => buildPatchBody([{ key, before: null, after: "x" }]), key).toThrow(/interdite/);
    }
  });
});

describe("simulation (mode par défaut)", () => {
  it("lit la configuration (GET), affiche le diff et n'écrit rien", async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.api.state.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(result.api.state.calls[0].url).toBe(URL_AUTH_CONFIG);
    expect(result.api.state.calls[0].headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(result.api.state.config).toEqual(currentConfig());
    expect(result.out).toContain("simulation (aucune écriture)");
    expect(result.out).toContain("confirmation : à modifier");
    expect(result.out).toContain("- Subject confirmation");
    expect(result.out).toContain("+ Confirmez votre adresse email pour accéder à Immojudis");
    expect(result.out).toContain("12 champ(s) à modifier sur 12 contrôlé(s).");
    expect(result.out).toContain("expéditeur : non modifié");
    expect(result.out).toContain("Simulation terminée : rien n'a été écrit.");
  });

  it("n'affiche jamais le jeton ni un champ secret de la configuration", async () => {
    const result = await run(["--sender-email=compte@immojudis.com", "--sender-name=Immojudis"]);
    const everything = `${result.out}\n${result.err}`;
    for (const secret of [FAKE_TOKEN, FAKE_SMTP_PASS, FAKE_HOOK_SECRET]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain("smtp_pass :");
  });

  it("montre le changement d'expéditeur seulement s'il est demandé, et dit si tout est déjà conforme", async () => {
    const templates = await loadLocalTemplates({ root });
    const conforming = currentConfig({
      smtp_admin_email: "compte@immojudis.com",
      smtp_sender_name: "Immojudis",
    });
    for (const template of templates) {
      conforming[subjectKey(template.id)] = template.subject;
      conforming[contentKey(template.id)] = template.content.replace(/\n$/, "\r\n");
    }
    const same = await run(["--sender-email=compte@immojudis.com", "--sender-name=Immojudis"], {
      api: fakeManagementApi(conforming),
    });
    expect(same.code).toBe(0);
    expect(same.out).toContain("0 champ(s) à modifier sur 14 contrôlé(s).");
    expect(same.out).toContain("smtp_admin_email : déjà conforme");

    const changed = await run(["--sender-email=compte@immojudis.com"], {
      api: fakeManagementApi(currentConfig()),
    });
    expect(changed.out).toContain("smtp_admin_email : modifié");
    expect(changed.out).toContain("- assistant@immojudis.com");
    expect(changed.out).toContain("+ compte@immojudis.com");
    expect(changed.out).not.toContain("smtp_sender_name");
  });
});

describe("application (--apply)", () => {
  it("écrit la sauvegarde filtrée AVANT le PATCH, puis relit la configuration", async () => {
    const directory = await scratchDirectory();
    const backupFile = path.join(directory, "sous-dossier", "sauvegarde.json");
    let backupExistedAtPatch = false;
    const api = fakeManagementApi(currentConfig(), {
      onPatch: () => {
        backupExistedAtPatch = existsSync(backupFile);
      },
    });
    const result = await run(
      [
        "--apply",
        `--backup-file=${backupFile}`,
        "--sender-email=compte@immojudis.com",
        "--sender-name=Immojudis",
      ],
      { api },
    );
    expect(result.code, result.err).toBe(0);
    expect(backupExistedAtPatch).toBe(true);
    expect(api.state.calls.map((call) => call.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(api.state.calls[1].headers["Content-Type"]).toBe("application/json");

    const saved = JSON.parse(await readFile(backupFile, "utf8"));
    expect(saved.project_ref).toBe(PROJECT_REF);
    expect(saved.captured_at).toBe("2026-11-01T12:00:00.000Z");
    expect(Object.keys(saved.config).sort()).toEqual([...MANAGED_KEYS].sort());
    expect(saved.config.smtp_admin_email).toBe("assistant@immojudis.com");
    expect(saved.config.mailer_subjects_recovery).toBe("Subject recovery");
    const raw = JSON.stringify(saved);
    for (const secret of [
      FAKE_TOKEN,
      FAKE_SMTP_PASS,
      FAKE_HOOK_SECRET,
      "smtp_host",
      "smtp_user",
      "smtp_pass",
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(result.out).toContain("Appliqué et relu : 14 champ(s) à jour.");
  });

  it("n'envoie que des clés gérées, jamais smtp_host, smtp_user, smtp_pass ni smtp_port", async () => {
    const directory = await scratchDirectory();
    const api = fakeManagementApi();
    await run(
      [
        "--apply",
        `--backup-file=${path.join(directory, "b.json")}`,
        "--sender-email=compte@immojudis.com",
      ],
      {
        api,
      },
    );
    const body = JSON.parse(api.state.calls[1].body);
    expect(Object.keys(body).sort()).toEqual(
      [
        ...TEMPLATE_IDS.flatMap((id) => [subjectKey(id), contentKey(id)]),
        "smtp_admin_email",
      ].sort(),
    );
    expect(body.smtp_admin_email).toBe("compte@immojudis.com");
    expect(body).not.toHaveProperty("smtp_sender_name");
    for (const key of ["smtp_host", "smtp_user", "smtp_pass", "smtp_port"]) {
      expect(body).not.toHaveProperty(key);
      expect(api.state.config[key]).toBe(currentConfig()[key]);
    }
  });

  it("sans --sender-email ni --sender-name, le SMTP n'est pas touché du tout", async () => {
    const directory = await scratchDirectory();
    const api = fakeManagementApi();
    await run(["--apply", `--backup-file=${path.join(directory, "b.json")}`], { api });
    const body = JSON.parse(api.state.calls[1].body);
    expect(Object.keys(body).filter((key) => key.startsWith("smtp_"))).toEqual([]);
    expect(api.state.config.smtp_admin_email).toBe("assistant@immojudis.com");
    expect(api.state.config.smtp_sender_name).toBe("ImmoJudis");
  });

  it("est idempotent : une seconde application ne renvoie rien", async () => {
    const directory = await scratchDirectory();
    const api = fakeManagementApi();
    const argv = ["--apply", `--backup-file=${path.join(directory, "b.json")}`];
    expect((await run(argv, { api })).code).toBe(0);
    api.state.calls.length = 0;
    const second = await run(argv, { api });
    expect(second.code).toBe(0);
    expect(api.state.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(second.out).toContain("Rien à appliquer");
    expect(existsSync(path.join(directory, "b.json"))).toBe(true);
  });

  it("variante retour-arriere : mêmes objets, gabarits {{ .ConfirmationURL }}", async () => {
    const directory = await scratchDirectory();
    const api = fakeManagementApi();
    const result = await run(
      ["--apply", "--variant=retour-arriere", `--backup-file=${path.join(directory, "b.json")}`],
      {
        api,
      },
    );
    expect(result.code, result.err).toBe(0);
    const body = JSON.parse(api.state.calls[1].body);
    const retour = await loadLocalTemplates({ root, variant: "retour-arriere" });
    const principal = await loadLocalTemplates({ root, variant: "principal" });
    for (const [index, template] of retour.entries()) {
      expect(body[contentKey(template.id)]).toBe(template.content);
      expect(body[subjectKey(template.id)]).toBe(principal[index].subject);
    }
    expect(body[contentKey("recovery")]).toContain("{{ .ConfirmationURL }}");
    expect(body[contentKey("recovery")]).not.toContain("/auth/confirmer");
  });

  it("exige --backup-file avec --apply, sans appeler l'API", async () => {
    const result = await run(["--apply"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--backup-file");
    expect(result.api.fetchImpl).not.toHaveBeenCalled();
  });

  it("échoue si la relecture ne montre pas les valeurs envoyées", async () => {
    const directory = await scratchDirectory();
    const api = fakeManagementApi();
    api.fetchImpl.mockImplementation(async (_url, init) => {
      api.state.calls.push({ method: init.method });
      return new Response(JSON.stringify(api.state.config), { status: 200 });
    });
    const result = await run(["--apply", `--backup-file=${path.join(directory, "b.json")}`], {
      api,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("Relecture différente de ce qui a été envoyé");
  });
});

describe("échecs", () => {
  it("secret absent, vide ou mal formé : échec clair avant tout appel", async () => {
    for (const token of [undefined, "", "   ", "FACTICE FACTICE"]) {
      const result = await run([], { env: { SUPABASE_ACCESS_TOKEN: token } });
      expect(result.code).toBe(1);
      expect(result.err).toContain("SUPABASE_ACCESS_TOKEN");
      expect(result.api.fetchImpl).not.toHaveBeenCalled();
    }
    const annotated = await run([], { env: { GITHUB_ACTIONS: "true" } });
    expect(annotated.err).toMatch(/^::error title=Secret SUPABASE_ACCESS_TOKEN manquant::/);
  });

  it("adresse expéditrice hors @immojudis.com : refus avant tout appel", async () => {
    const result = await run(["--sender-email=compte@gmail.com"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("@immojudis.com");
    expect(result.api.fetchImpl).not.toHaveBeenCalled();
  });

  it("gabarit invalide dans le dépôt : refus avant tout appel", async () => {
    const directory = await scratchDirectory();
    await cp(path.join(root, "supabase"), path.join(directory, "supabase"), {
      recursive: true,
      filter: (source) => !source.includes("migrations") && !source.includes("functions"),
    });
    const file = path.join(directory, "supabase/templates/recovery.html");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("</body>", "<p>Please reset your password</p></body>"),
    );
    const result = await run([], { root: directory });
    expect(result.code).toBe(1);
    expect(result.err).toContain("recovery (contenu) : mot anglais");
    expect(result.api.fetchImpl).not.toHaveBeenCalled();
  });

  it("réponse d'erreur de l'API : code HTTP seulement, ni corps, ni jeton", async () => {
    for (const [status, hint] of [
      [401, "SUPABASE_ACCESS_TOKEN"],
      [403, "sans droit"],
      [500, "500"],
    ]) {
      const result = await run([], {
        api: fakeManagementApi(currentConfig(), { getStatus: status }),
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain(String(status));
      expect(result.err).toContain(hint);
      expect(`${result.out}${result.err}`).not.toContain(FAKE_BODY_LEAK);
      expect(`${result.out}${result.err}`).not.toContain(FAKE_TOKEN);
    }
  });

  it("PATCH refusé : échec, la sauvegarde existe déjà", async () => {
    const directory = await scratchDirectory();
    const backupFile = path.join(directory, "b.json");
    const result = await run(["--apply", `--backup-file=${backupFile}`], {
      api: fakeManagementApi(currentConfig(), { patchStatus: 400 }),
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("PATCH config/auth");
    expect(result.err).toContain("400");
    expect(existsSync(backupFile)).toBe(true);
    expect(`${result.out}${result.err}`).not.toContain(FAKE_BODY_LEAK);
  });

  it("masque le jeton même s'il se glissait dans un message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error(`boom ${FAKE_TOKEN}`), { name: "TypeError" });
    });
    const result = await run([], { api: { fetchImpl, state: { calls: [] } } });
    expect(result.code).toBe(1);
    expect(result.err).toContain("injoignable");
    expect(`${result.out}${result.err}`).not.toContain(FAKE_TOKEN);
  });
});
