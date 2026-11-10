#!/usr/bin/env node

// Applique les gabarits d'emails d'authentification du dépôt (objets et contenus des six emails de
// Supabase Auth) à la configuration d'authentification du projet de production, par l'API de gestion
// de Supabase (GET et PATCH /v1/projects/{ref}/config/auth).
//
// - Source de vérité : supabase/config.toml (objet et chemin de chaque gabarit) et les fichiers
//   HTML qu'il désigne, générés par src/lib/auth-email-templates.ts. Aucun texte n'est dupliqué ici.
//   Variante `retour-arriere` : les mêmes objets, avec les fichiers de
//   docs/runbooks/emails-authentification/retour-arriere/ (lien {{ .ConfirmationURL }}).
// - Par défaut le script SIMULE : il lit la configuration actuelle (GET), affiche le diff et s'arrête.
//   Il n'écrit (PATCH) qu'avec --apply, après avoir enregistré la configuration actuelle filtrée dans
//   --backup-file (pour le retour arrière).
// - Les emails d'authentification partent de l'adresse « ne pas répondre » (--sender-email=
//   ne-pas-repondre@immojudis.com --sender-name=Immojudis), comme les autres emails automatiques
//   (NOREPLY_EMAIL_FROM) ; leurs gabarits portent la mention « Message automatique, merci de ne pas
//   y répondre ».
// - Il ne modifie que les objets, les contenus, et, si --sender-email / --sender-name sont fournis,
//   smtp_admin_email / smtp_sender_name. Il ne touche jamais à smtp_host, smtp_user, smtp_pass ni
//   smtp_port, et n'affiche ni n'enregistre aucun secret (jeton d'accès, mot de passe SMTP, clés).
//
// Noms des clés : spécification OpenAPI de l'API de gestion de Supabase (UpdateAuthConfigBody),
// vérifiée le 01/11/2026 : mailer_subjects_<type> et mailer_templates_<type>_content pour
// confirmation, recovery, email_change, invite, magic_link et reauthentication.
//
// Usage :
//   SUPABASE_ACCESS_TOKEN=… node scripts/apply-supabase-auth-config.mjs [--variant=retour-arriere]
//     [--sender-email=ne-pas-repondre@immojudis.com] [--sender-name=Immojudis]
//     [--backup-file=chemin.json] [--apply]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PROJECT_REF = "sgpakxtyvenlpeihuucm";
export const API_BASE = "https://api.supabase.com";
export const TEMPLATE_IDS = [
  "confirmation",
  "recovery",
  "email_change",
  "invite",
  "magic_link",
  "reauthentication",
];
export const VARIANTS = ["principal", "retour-arriere"];
export const RETOUR_ARRIERE_DIRECTORY = "docs/runbooks/emails-authentification/retour-arriere";
export const SENDER_DOMAIN = "immojudis.com";
// Origine fixe de la page d'arrivée du lien (EMAIL_SITE_URL dans src/lib/email-brand.ts).
export const CONFIRMATION_PAGE = "https://immojudis.com/auth/confirmer";

// Gabarit sans lien : la réauthentification n'envoie qu'un code ({{ .Token }}).
const CODE_ONLY_TEMPLATES = new Set(["reauthentication"]);

export const subjectKey = (id) => `mailer_subjects_${id}`;
export const contentKey = (id) => `mailer_templates_${id}_content`;

// Les seules clés que le script lit pour le retour arrière et écrit : une liste blanche, jamais une
// liste noire. Tout le reste de la configuration (dont smtp_pass, les clés des fournisseurs et les
// secrets des hooks) est ignoré dès la lecture.
export const MANAGED_KEYS = [
  ...TEMPLATE_IDS.flatMap((id) => [subjectKey(id), contentKey(id)]),
  "smtp_admin_email",
  "smtp_sender_name",
];
const FORBIDDEN_KEYS = new Set(["smtp_host", "smtp_user", "smtp_pass", "smtp_port"]);

const API_TIMEOUT_MS = 30_000;
const MAX_DIFF_LINES_PER_FIELD = 20;
const MAX_DIFF_COLUMNS = 160;

// ---------------------------------------------------------------------------------------------
// Contrôles des gabarits. Les expressions reprennent celles de src/lib/auth-email-templates.test.ts
// (français, pas d'anglais, pas de contenu commercial, variables Go prévues) ; le test de ce script
// vérifie qu'elles n'ont pas divergé.
// ---------------------------------------------------------------------------------------------

export const ALLOWED_VARIABLES = new Set([
  "{{ .TokenHash }}",
  "{{ .RedirectTo }}",
  "{{ .RedirectTo | urlquery }}",
  "{{ .ConfirmationURL }}",
  "{{ .Email }}",
  "{{ .NewEmail }}",
  "{{ .Token }}",
]);
export const ENGLISH_WORDS =
  /\b(the|your|click|confirm your|reset your|password reset|hello|thanks|please|sign ?up|log ?in|link|account)\b/i;
export const COMMERCIAL_WORDS =
  /offre|abonnement|promo|gratuit|tarif|prix|remise|découvrez|nouveauté|newsletter/i;

/** Texte visible d'un gabarit (sans style, sans balises, sans lien de repli en clair). */
export function visibleText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<span[^>]*word-break:break-all[^>]*>[\s\S]*?<\/span>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&zwnj;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function proseProblems(label, text) {
  const problems = [];
  if (ENGLISH_WORDS.test(text)) problems.push(`${label} : mot anglais détecté`);
  if (COMMERCIAL_WORDS.test(text.replace("Il ne contient aucune offre commerciale.", ""))) {
    problems.push(`${label} : vocabulaire commercial détecté`);
  }
  if (/\p{L}'\p{L}/u.test(text.replace(/\{\{[^{}]*\}\}/g, ""))) {
    problems.push(`${label} : apostrophe droite (utiliser l’apostrophe typographique)`);
  }
  if (/ImmoJudis|IMMOJUDIS/.test(text)) problems.push(`${label} : « Immojudis » mal orthographié`);
  return problems;
}

/**
 * Contrôles d'un gabarit avant toute application : français, variables Go prévues, lien attendu.
 * @returns {string[]} les problèmes trouvés (vide si le gabarit est acceptable)
 */
export function templateProblems({ id, subject, content }, variant) {
  const problems = [];
  if (typeof subject !== "string" || !subject.trim()) {
    return [`${id} : objet absent de supabase/config.toml`];
  }
  if (typeof content !== "string" || !content.trim()) return [`${id} : contenu vide`];

  if (!content.includes('<html lang="fr">')) problems.push(`${id} : <html lang="fr"> absent`);
  problems.push(...proseProblems(`${id} (objet)`, subject));
  problems.push(...proseProblems(`${id} (contenu)`, visibleText(content)));

  const used = content.match(/\{\{[^{}]*\}\}/g) ?? [];
  for (const variable of used) {
    if (!ALLOWED_VARIABLES.has(variable)) problems.push(`${id} : variable inconnue ${variable}`);
  }
  if (/\{\{|\}\}/.test(content.replace(/\{\{[^{}]*\}\}/g, ""))) {
    problems.push(`${id} : « {{ » ou « }} » mal formé`);
  }

  // `{{ .SiteURL }}` porte une barre finale : il donnait `https://immojudis.com//auth/confirmer`. Les
  // gabarits écrivent l'origine en clair ; ni la variable ni la double barre ne sont acceptées.
  if (content.includes("//auth")) problems.push(`${id} : « //auth » dans le lien (double barre)`);

  if (CODE_ONLY_TEMPLATES.has(id)) {
    if (!content.includes("{{ .Token }}")) problems.push(`${id} : code {{ .Token }} absent`);
    if (content.includes("{{ .ConfirmationURL }}") || content.includes("/auth/confirmer")) {
      problems.push(`${id} : ce gabarit ne doit contenir aucun lien`);
    }
  } else if (variant === "retour-arriere") {
    if (!content.includes("{{ .ConfirmationURL }}")) {
      problems.push(`${id} : lien {{ .ConfirmationURL }} absent`);
    }
    if (content.includes("/auth/confirmer")) {
      problems.push(`${id} : la variante retour-arriere ne doit pas mener à /auth/confirmer`);
    }
  } else {
    if (!content.includes(`${CONFIRMATION_PAGE}?token_hash=`)) {
      problems.push(
        `${id} : lien /auth/confirmer absent (attendu : ${CONFIRMATION_PAGE}?token_hash=…)`,
      );
    }
    if (!content.includes("{{ .TokenHash }}")) problems.push(`${id} : {{ .TokenHash }} absent`);
    if (content.includes("{{ .ConfirmationURL }}")) {
      problems.push(`${id} : la variante principale ne doit pas employer {{ .ConfirmationURL }}`);
    }
  }
  return problems;
}

/** L'adresse expéditrice doit être en @immojudis.com ; le nom ne doit pas casser l'en-tête From. */
export function senderProblems({ senderEmail, senderName }) {
  const problems = [];
  if (senderEmail !== undefined) {
    const pattern = new RegExp(`^[A-Za-z0-9._%+-]+@${SENDER_DOMAIN.replace(".", "\\.")}$`, "i");
    if (!pattern.test(senderEmail)) {
      problems.push(`--sender-email doit être une adresse en @${SENDER_DOMAIN}`);
    }
  }
  if (senderName !== undefined) {
    if (!senderName.trim() || senderName.length > 100 || /[\p{Cc}<>"\\]/u.test(senderName)) {
      problems.push(
        '--sender-name doit faire de 1 à 100 caractères, sans < > " \\ ni saut de ligne',
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Lecture des gabarits depuis le dépôt.
// ---------------------------------------------------------------------------------------------

/** Lit [auth.email.template.<id>] de supabase/config.toml : { id: { subject, contentPath } }. */
export function parseTemplateSections(configText) {
  const sections = {};
  let current = null;
  for (const line of configText.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      const match = /^auth\.email\.template\.([a-z_]+)$/.exec(header[1].trim());
      current = match ? (sections[match[1]] = {}) : null;
      continue;
    }
    if (!current) continue;
    const entry = /^\s*(subject|content_path)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(line);
    if (!entry) continue;
    // Les chaînes TOML simples et JSON partagent les mêmes échappements pour ces textes.
    const value = JSON.parse(entry[2]);
    if (entry[1] === "subject") current.subject = value;
    else current.contentPath = value;
  }
  return sections;
}

/**
 * Les six gabarits du dépôt : objet de config.toml, contenu du fichier désigné (ou son équivalent
 * du dossier de retour arrière).
 */
export async function loadLocalTemplates({ root = repoRoot, variant = "principal" } = {}) {
  const configText = await readFile(path.join(root, "supabase/config.toml"), "utf8");
  const sections = parseTemplateSections(configText);
  const templates = [];
  for (const id of TEMPLATE_IDS) {
    const section = sections[id];
    if (!section?.subject || !section?.contentPath) {
      throw new Error(
        `supabase/config.toml : [auth.email.template.${id}] sans subject ou content_path.`,
      );
    }
    const relative =
      variant === "retour-arriere"
        ? path.posix.join(RETOUR_ARRIERE_DIRECTORY, path.posix.basename(section.contentPath))
        : path.posix.normalize(section.contentPath);
    const absolute = path.resolve(root, relative);
    if (path.relative(root, absolute).startsWith("..")) {
      throw new Error(`${id} : le chemin ${section.contentPath} sort du dépôt.`);
    }
    templates.push({
      id,
      subject: section.subject,
      content: await readFile(absolute, "utf8"),
      source: path.relative(root, absolute).split(path.sep).join("/"),
    });
  }
  return templates;
}

// ---------------------------------------------------------------------------------------------
// Configuration voulue, configuration actuelle, diff.
// ---------------------------------------------------------------------------------------------

export function buildDesiredConfig({ templates, senderEmail, senderName }) {
  const desired = {};
  for (const template of templates) {
    desired[subjectKey(template.id)] = template.subject;
    desired[contentKey(template.id)] = template.content;
  }
  if (senderEmail !== undefined) desired.smtp_admin_email = senderEmail;
  if (senderName !== undefined) desired.smtp_sender_name = senderName;
  return desired;
}

/** Ne garde de la configuration actuelle que les clés gérées (liste blanche, aucun secret). */
export function pickManaged(config) {
  const picked = {};
  if (!config || typeof config !== "object") return picked;
  for (const key of MANAGED_KEYS) {
    if (key in config) picked[key] = typeof config[key] === "string" ? config[key] : null;
  }
  return picked;
}

// Fins de ligne et saut final ne comptent pas : le tableau de bord peut les normaliser.
const normalize = (value) =>
  typeof value === "string" ? value.replace(/\r\n/g, "\n").trimEnd() : null;

/** Les champs dont la valeur actuelle diffère de la valeur voulue : [{ key, before, after }]. */
export function computeChanges(current, desired) {
  const changes = [];
  for (const [key, after] of Object.entries(desired)) {
    const before = key in current ? current[key] : null;
    if (normalize(before) !== normalize(after)) changes.push({ key, before, after });
  }
  return changes;
}

/** Corps du PATCH : uniquement des clés gérées, jamais smtp_host, smtp_user, smtp_pass ni smtp_port. */
export function buildPatchBody(changes) {
  const body = {};
  for (const { key, after } of changes) {
    if (FORBIDDEN_KEYS.has(key) || !MANAGED_KEYS.includes(key)) {
      throw new Error(`Clé interdite dans la requête : ${key}`);
    }
    body[key] = after;
  }
  return body;
}

/** Diff de lignes (plus longue sous-suite commune) : [{ type: " " | "-" | "+", text }]. */
export function diffLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 250_000) {
    return [...a.map((text) => ({ type: "-", text })), ...b.map((text) => ({ type: "+", text }))];
  }
  const lengths = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const result = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ type: " ", text: a[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      result.push({ type: "-", text: a[i] });
      i += 1;
    } else {
      result.push({ type: "+", text: b[j] });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) result.push({ type: "-", text: a[i] });
  for (; j < b.length; j += 1) result.push({ type: "+", text: b[j] });
  return result;
}

const clip = (text) =>
  text.length > MAX_DIFF_COLUMNS
    ? `${text.slice(0, MAX_DIFF_COLUMNS)}… (${text.length} car.)`
    : text;

function describeField(change) {
  const { key, before, after } = change;
  const lines = [];
  const isContent = key.endsWith("_content");
  if (before === null) {
    lines.push(
      `    ${key} : ${isContent ? "absent (gabarit par défaut de Supabase)" : "absent"} -> défini`,
    );
  } else {
    lines.push(`    ${key} : modifié`);
  }
  if (!isContent) {
    lines.push(`      - ${before === null ? "(absent)" : clip(before)}`);
    lines.push(`      + ${clip(after)}`);
    return lines;
  }
  const changed = diffLines(normalize(before) ?? "", normalize(after)).filter(
    (line) => line.type !== " ",
  );
  const removed = changed.filter((line) => line.type === "-").length;
  const added = changed.length - removed;
  lines.push(
    `      ${removed} ligne(s) retirée(s), ${added} ligne(s) ajoutée(s) (lignes inchangées omises)`,
  );
  for (const line of changed.slice(0, MAX_DIFF_LINES_PER_FIELD)) {
    lines.push(`      ${line.type} ${clip(line.text)}`);
  }
  if (changed.length > MAX_DIFF_LINES_PER_FIELD) {
    lines.push(`      … ${changed.length - MAX_DIFF_LINES_PER_FIELD} ligne(s) de plus`);
  }
  return lines;
}

/** Rapport lisible : ce qui change, champ par champ, et ce qui reste identique. */
export function renderDiff({ desired, changes }) {
  const byKey = new Map(changes.map((change) => [change.key, change]));
  const lines = [];
  for (const id of TEMPLATE_IDS) {
    const keys = [subjectKey(id), contentKey(id)];
    const pending = keys.filter((key) => byKey.has(key));
    lines.push(`  ${id} : ${pending.length ? "à modifier" : "déjà conforme"}`);
    for (const key of pending) lines.push(...describeField(byKey.get(key)));
  }
  const smtp = ["smtp_admin_email", "smtp_sender_name"].filter((key) => key in desired);
  if (smtp.length === 0) {
    lines.push("  expéditeur : non modifié (ni --sender-email ni --sender-name)");
  } else {
    for (const key of smtp) {
      if (byKey.has(key)) lines.push(...describeField(byKey.get(key)).map((line) => line.slice(2)));
      else lines.push(`  ${key} : déjà conforme`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// API de gestion de Supabase.
// ---------------------------------------------------------------------------------------------

const HTTP_HINTS = {
  401: "jeton refusé : vérifier le secret SUPABASE_ACCESS_TOKEN (valeur, expiration)",
  403: "jeton sans droit sur ce projet",
  404: "projet introuvable",
  429: "trop de requêtes : réessayer plus tard",
};

async function managementRequest({ fetchImpl, token, method, body }) {
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/v1/projects/${PROJECT_REF}/config/auth`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `${method} config/auth : l'API de gestion Supabase est injoignable (${error?.name ?? "erreur"}).`,
    );
  }
  if (!response.ok) {
    // Ni le corps de la réponse ni les en-têtes ne sont repris : ils pourraient porter des secrets.
    const hint = HTTP_HINTS[response.status];
    throw new Error(
      `${method} config/auth : l'API de gestion Supabase a répondu ${response.status}${hint ? ` (${hint})` : ""}.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${method} config/auth : réponse illisible de l'API de gestion Supabase.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Ligne de commande.
// ---------------------------------------------------------------------------------------------

const VALUE_OPTIONS = {
  "--variant": "variant",
  "--sender-email": "senderEmail",
  "--sender-name": "senderName",
  "--backup-file": "backupFile",
};

export function parseArgs(argv) {
  const options = { apply: false, variant: "principal" };
  const errors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    const match = /^(--[a-z-]+)(?:=([\s\S]*))?$/.exec(arg);
    const property = match && VALUE_OPTIONS[match[1]];
    if (!property) {
      errors.push(`Option inconnue : ${arg.split("=")[0]}`);
      continue;
    }
    let value = match[2];
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value.trim() === "") {
      errors.push(`${match[1]} demande une valeur non vide.`);
      continue;
    }
    options[property] = value;
  }
  if (!VARIANTS.includes(options.variant)) {
    errors.push(`--variant doit valoir ${VARIANTS.join(" ou ")}.`);
  }
  return { options, errors };
}

export function normalizeToken(raw) {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token) return { error: "SUPABASE_ACCESS_TOKEN est absent ou vide." };
  if (/\s/.test(token))
    return { error: "SUPABASE_ACCESS_TOKEN contient des espaces ou des sauts de ligne." };
  return { token };
}

function createReporter({ env, stdout, stderr, secrets }) {
  const annotate = env.GITHUB_ACTIONS === "true";
  const redact = (text) =>
    secrets.reduce(
      (value, secret) => (secret.length >= 8 ? value.split(secret).join("***") : value),
      String(text),
    );
  return {
    log: (line = "") => stdout.write(`${redact(line)}\n`),
    error: (title, message) => {
      stderr.write(`${annotate ? `::error title=${title}::` : "Erreur : "}${redact(message)}\n`);
    },
  };
}

/**
 * @param {string[]} argv arguments (sans node ni le chemin du script)
 * @param {Record<string, string | undefined>} env
 * @param {{ fetchImpl?: typeof fetch, stdout?: {write(s: string): unknown}, stderr?: {write(s: string): unknown},
 *   root?: string, now?: () => Date }} deps
 * @returns {Promise<number>} le code de sortie
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const {
    fetchImpl = fetch,
    stdout = process.stdout,
    stderr = process.stderr,
    root = repoRoot,
    now = () => new Date(),
  } = deps;
  const tokenCheck = normalizeToken(env.SUPABASE_ACCESS_TOKEN);
  const { log, error } = createReporter({
    env,
    stdout,
    stderr,
    secrets: tokenCheck.token ? [tokenCheck.token] : [],
  });

  const { options, errors } = parseArgs(argv);
  errors.push(...senderProblems(options));
  if (errors.length) {
    for (const message of errors) error("Options invalides", message);
    return 1;
  }
  if (tokenCheck.error) {
    error(
      "Secret SUPABASE_ACCESS_TOKEN manquant",
      `${tokenCheck.error} Créer un jeton d'accès personnel Supabase puis le secret GitHub Actions du même nom (docs/runbooks/emails-authentification.md).`,
    );
    return 1;
  }
  if (options.apply && !options.backupFile) {
    error(
      "Options invalides",
      "--apply exige --backup-file (sauvegarde de la configuration actuelle).",
    );
    return 1;
  }

  let templates;
  try {
    templates = await loadLocalTemplates({ root, variant: options.variant });
  } catch (cause) {
    error("Gabarits illisibles", cause.message);
    return 1;
  }
  const problems = templates.flatMap((template) => templateProblems(template, options.variant));
  if (problems.length) {
    error("Gabarits refusés", `Contrôles locaux en échec :\n- ${problems.join("\n- ")}`);
    return 1;
  }

  const desired = buildDesiredConfig({
    templates,
    senderEmail: options.senderEmail,
    senderName: options.senderName,
  });
  const token = tokenCheck.token;

  log(`Projet Supabase : ${PROJECT_REF}`);
  log(`Mode : ${options.apply ? "APPLICATION" : "simulation (aucune écriture)"}`);
  log(`Variante : ${options.variant}`);
  log(`Gabarits lus : ${templates.length} fichiers de ${path.posix.dirname(templates[0].source)}/`);
  log("Contrôles locaux : français, variables, lien attendu, expéditeur : OK");
  log("");

  try {
    const current = pickManaged(await managementRequest({ fetchImpl, token, method: "GET" }));
    const changes = computeChanges(current, desired);

    log("Différences avec la configuration actuelle :");
    for (const line of renderDiff({ desired, changes })) log(line);
    log("");
    log(`${changes.length} champ(s) à modifier sur ${Object.keys(desired).length} contrôlé(s).`);
    log("Non touchés : smtp_host, smtp_user, smtp_pass, smtp_port.");

    if (options.backupFile) {
      const file = path.resolve(options.backupFile);
      await mkdir(path.dirname(file), { recursive: true });
      const backup = {
        project_ref: PROJECT_REF,
        captured_at: now().toISOString(),
        note: "Configuration d'authentification AVANT application (objets, gabarits, expéditeur). Aucun secret. Restauration : docs/runbooks/emails-authentification.md, section Retour arrière.",
        config: current,
      };
      if (Object.keys(backup.config).some((key) => !MANAGED_KEYS.includes(key))) {
        throw new Error("La sauvegarde contiendrait une clé non prévue : abandon.");
      }
      await writeFile(file, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
      log(`Sauvegarde de la configuration actuelle : ${file}`);
    }

    if (!options.apply) {
      log("");
      log("Simulation terminée : rien n'a été écrit. Relancer avec --apply pour appliquer.");
      return 0;
    }
    if (changes.length === 0) {
      log("");
      log("Rien à appliquer : la configuration est déjà conforme.");
      return 0;
    }

    await managementRequest({ fetchImpl, token, method: "PATCH", body: buildPatchBody(changes) });
    const after = pickManaged(await managementRequest({ fetchImpl, token, method: "GET" }));
    const mismatched = computeChanges(
      after,
      Object.fromEntries(changes.map((c) => [c.key, c.after])),
    );
    if (mismatched.length) {
      error(
        "Application non confirmée",
        `Relecture différente de ce qui a été envoyé pour : ${mismatched.map((c) => c.key).join(", ")}. Vérifier dans Supabase > Authentication > Emails.`,
      );
      return 1;
    }
    log("");
    log(`Appliqué et relu : ${changes.length} champ(s) à jour.`);
    return 0;
  } catch (cause) {
    error("Échec", cause.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
