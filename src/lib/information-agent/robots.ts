/**
 * Lecture minimale de `robots.txt` (RFC 9309) pour la recherche d'adresse sur le site d'un cabinet :
 * le groupe qui nomme notre jeton prime, à défaut le groupe `*` ; la règle la plus longue gagne et
 * `Allow` l'emporte à égalité. Un fichier sans règle applicable autorise tout.
 */

type RobotsRule = { allow: boolean; pattern: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[]; crawlDelaySeconds: number | null };

export type RobotsEvaluation = {
  allowed: boolean;
  /** `Crawl-delay` du groupe applicable, en secondes. */
  crawlDelaySeconds: number | null;
};

/** Au-delà, un fichier est tronqué (RFC 9309, section 2.5). */
const MAX_ROBOTS_BYTES = 500 * 1024;

function parseGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.slice(0, MAX_ROBOTS_BYTES).split(/\r?\n|\r/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return groups;
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/**
 * Évalue `path` (chemin et requête, par exemple `/contact?x=1`) pour le jeton de produit `token`
 * (minuscules, sans version).
 */
export function evaluateRobots(text: string, path: string, token: string): RobotsEvaluation {
  const groups = parseGroups(text);
  const own = groups.filter((group) => group.agents.includes(token.toLowerCase()));
  const applicable = own.length ? own : groups.filter((group) => group.agents.includes("*"));
  if (!applicable.length) return { allowed: true, crawlDelaySeconds: null };

  const delays = applicable
    .map((group) => group.crawlDelaySeconds)
    .filter((value): value is number => value !== null);
  const crawlDelaySeconds = delays.length ? Math.max(...delays) : null;

  let best: { allow: boolean; length: number } | null = null;
  for (const rule of applicable.flatMap((group) => group.rules)) {
    // `Disallow:` vide = tout autorisé ; `Allow:` vide n'ajoute rien.
    if (!rule.pattern) continue;
    if (!patternToRegExp(rule.pattern).test(path)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return { allowed: best ? best.allow : true, crawlDelaySeconds };
}
