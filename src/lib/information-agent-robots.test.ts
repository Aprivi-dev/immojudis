import { describe, expect, it } from "vitest";
import {
  evaluateRobots,
  ROBOTS_MAX_PATTERN_LENGTH,
  ROBOTS_MAX_RULES,
  robotsPatternMatches,
} from "@/lib/information-agent/robots";
import { INFORMATION_AGENT_ROBOTS_TOKEN } from "@/lib/information-agent/firm-site-search";

const TOKEN = INFORMATION_AGENT_ROBOTS_TOKEN;
const allowed = (text: string, path: string) => evaluateRobots(text, path, TOKEN).allowed;

describe("lecture de robots.txt", () => {
  it("autorise tout quand aucune règle ne s'applique", () => {
    expect(allowed("", "/contact")).toBe(true);
    expect(allowed("User-agent: *\nDisallow:", "/contact")).toBe(true);
    expect(allowed("User-agent: googlebot\nDisallow: /", "/contact")).toBe(true);
  });

  it("applique le groupe `*` et refuse un chemin interdit", () => {
    const robots = "User-agent: *\nDisallow: /contact\nDisallow: /admin/";
    expect(allowed(robots, "/contact")).toBe(false);
    expect(allowed(robots, "/contact/formulaire")).toBe(false);
    expect(allowed(robots, "/admin/x")).toBe(false);
    expect(allowed(robots, "/mentions-legales")).toBe(true);
  });

  it("le groupe qui nomme notre jeton prime sur `*`", () => {
    const robots = [
      "User-agent: *",
      "Disallow:",
      "",
      "User-agent: ImmojudisAdresses",
      "Disallow: /",
    ].join("\n");
    expect(allowed(robots, "/")).toBe(false);
    expect(allowed(robots, "/contact")).toBe(false);
    // L'inverse : `*` interdit tout, mais le site nous autorise nommément.
    const open = "User-agent: *\nDisallow: /\n\nUser-agent: immojudisadresses\nAllow: /";
    expect(allowed(open, "/contact")).toBe(true);
  });

  it("la règle la plus longue gagne, Allow l'emporte à égalité", () => {
    const robots = "User-agent: *\nDisallow: /cabinet\nAllow: /cabinet/contact";
    expect(allowed(robots, "/cabinet/equipe")).toBe(false);
    expect(allowed(robots, "/cabinet/contact")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /a\nAllow: /a", "/a")).toBe(true);
  });

  it("gère les jokers `*` et la fin de chaîne `$`", () => {
    const robots = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?session=";
    expect(allowed(robots, "/doc/plaquette.pdf")).toBe(false);
    expect(allowed(robots, "/doc/plaquette.pdf.html")).toBe(true);
    expect(allowed(robots, "/contact?session=1")).toBe(false);
    expect(allowed(robots, "/contact")).toBe(true);
  });

  it("ignore les commentaires et partage les règles entre agents consécutifs", () => {
    const robots = [
      "# fichier de test",
      "User-agent: bingbot",
      "User-agent: ImmojudisAdresses # nous",
      "Disallow: /prive # interdit",
    ].join("\r\n");
    expect(allowed(robots, "/prive/x")).toBe(false);
    expect(allowed(robots, "/contact")).toBe(true);
  });

  it("rend le Crawl-delay du groupe applicable", () => {
    const robots = "User-agent: *\nCrawl-delay: 4\nDisallow: /x";
    expect(evaluateRobots(robots, "/contact", TOKEN)).toEqual({
      allowed: true,
      crawlDelaySeconds: 4,
    });
  });

  describe("robustesse face à un fichier hostile", () => {
    it("30 jokers contre un chemin de 200 caractères restent quasi instantanés", () => {
      const pattern = `/${"*a".repeat(30)}b`;
      const path = `/${"a".repeat(200)}`;
      const started = performance.now();
      for (let i = 0; i < 200; i += 1) expect(robotsPatternMatches(pattern, path)).toBe(false);
      expect(performance.now() - started).toBeLessThan(50);
      const text = `User-agent: *\nDisallow: ${pattern}`;
      const single = performance.now();
      expect(allowed(text, path)).toBe(true);
      expect(performance.now() - single).toBeLessThan(50);
    });

    it("apparie comme la spécification les cas limites de jokers", () => {
      expect(robotsPatternMatches("/a*b*c", "/aXXbYYc")).toBe(true);
      expect(robotsPatternMatches("/a*b*c", "/aXXbYY")).toBe(false);
      expect(robotsPatternMatches("/*", "/")).toBe(true);
      expect(robotsPatternMatches("/fish*", "/fish")).toBe(true);
      expect(robotsPatternMatches("/fish", "/fi")).toBe(false);
      expect(robotsPatternMatches("/*.php$", "/x.php")).toBe(true);
      expect(robotsPatternMatches("/*.php$", "/x.php?a=1")).toBe(false);
      expect(robotsPatternMatches("/a$", "/a/")).toBe(false);
      expect(robotsPatternMatches("/**//", "/a//")).toBe(true);
    });

    it("refuse en bloc un fichier de plus de 1000 règles ou à motif de plus de 512 caractères", () => {
      const many = Array.from({ length: ROBOTS_MAX_RULES + 1 }, (_, i) => `Disallow: /x${i}`);
      expect(allowed(`User-agent: *\n${many.join("\n")}`, "/contact")).toBe(false);
      const atLimit = Array.from({ length: ROBOTS_MAX_RULES }, (_, i) => `Disallow: /x${i}`);
      expect(allowed(`User-agent: *\n${atLimit.join("\n")}`, "/contact")).toBe(true);
      const longPattern = `/${"a".repeat(ROBOTS_MAX_PATTERN_LENGTH)}`;
      expect(allowed(`User-agent: *\nDisallow: ${longPattern}`, "/contact")).toBe(false);
      const fits = `/${"a".repeat(ROBOTS_MAX_PATTERN_LENGTH - 1)}`;
      expect(allowed(`User-agent: *\nDisallow: ${fits}`, "/contact")).toBe(true);
    });
  });
});
