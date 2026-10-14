/**
 * Lecture minimale de `robots.txt` (RFC 9309) pour la recherche d'adresse sur le site d'un cabinet :
 * le groupe qui nomme notre jeton prime, à défaut le groupe `*` ; la règle la plus longue gagne et
 * `Allow` l'emporte à égalité. Un fichier sans règle applicable autorise tout.
 *
 * Le fichier vient d'un site tiers : l'appariement des motifs est itératif (deux pointeurs, retour
 * sur le dernier `*`), donc en O(n·m) quel que soit le motif, et le fichier est borné (1000 règles,
 * 512 caractères par motif). Un fichier qui dépasse ces bornes est refusé en bloc : ignorer une
 * règle trop longue reviendrait à autoriser ce qu'elle interdit.
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
export const ROBOTS_MAX_RULES = 1000;
export const ROBOTS_MAX_PATTERN_LENGTH = 512;

function parseGroups(text: string): { groups: RobotsGroup[]; oversized: boolean } {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  let rules = 0;
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
      rules += 1;
      if (rules > ROBOTS_MAX_RULES || value.length > ROBOTS_MAX_PATTERN_LENGTH) {
        return { groups: [], oversized: true };
      }
      current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return { groups, oversized: false };
}

/**
 * Le motif (avec `*` et `$` final éventuel) correspond-il au début du chemin ? Sans `$`, le motif est
 * un préfixe ; avec `$`, il doit couvrir le chemin entier. Appariement glob itératif : en cas
 * d'échec, retour au dernier `*` seulement, sans récursion ni retour sur arbre.
 */
export function robotsPatternMatches(rawPattern: string, path: string): boolean {
  const anchored = rawPattern.endsWith("$");
  const pattern = anchored ? rawPattern.slice(0, -1) : rawPattern;
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < path.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = s;
      p += 1;
    } else if (p < pattern.length && pattern[p] === path[s]) {
      p += 1;
      s += 1;
    } else if (p >= pattern.length && !anchored) {
      return true;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      s = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * Évalue `path` (chemin et requête, par exemple `/contact?x=1`) pour le jeton de produit `token`
 * (minuscules, sans version).
 */
export function evaluateRobots(text: string, path: string, token: string): RobotsEvaluation {
  const { groups, oversized } = parseGroups(text);
  if (oversized) return { allowed: false, crawlDelaySeconds: null };
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
    if (!robotsPatternMatches(rule.pattern, path)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return { allowed: best ? best.allow : true, crawlDelaySeconds };
}
