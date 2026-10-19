import type { MetadataRoute } from "next";
import { DEPARTMENT_PAGES_PATH, indexableDepartments } from "@/lib/department-pages";
import { tryLoadDepartmentCatalogue } from "@/lib/department-pages.server";
import {
  isPublicAdjudicationPricesEnabled,
  PUBLIC_ADJUDICATION_PRICES_PATH,
} from "@/lib/public-adjudication-prices";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";
import { GUIDE_LAST_UPDATED } from "@/lib/guide-dates";
import { resolveSiteOrigin } from "@/lib/site-url";

// `/sitemap.xml` lists the static pages only. The articles have `/ressources/sitemap.xml`
// (app/ressources/sitemap.ts) and the sales `/sales/sitemap/0.xml`, `1.xml`… (app/sales/sitemap.ts);
// robots.txt lists the three. Rebuilt on request from the data cache (refreshed every hour), never
// frozen at build time.
export const dynamic = "force-dynamic";

// The departments are read in full when the data cache is empty (up to 100 database calls): same
// duration as the department pages (DEPARTMENT_PAGES_MAX_DURATION_SECONDS, a test checks it).
export const maxDuration = 60;

/**
 * Last real content change of each static page (not "now": a date that moves on
 * every request teaches crawlers to ignore it). Update the date when the page's
 * content changes materially.
 *
 * Every path must answer 200 itself: the test of this file checks that none of them is the
 * source of a redirect of `next.config.ts` (the offers page lives at `/offres`).
 */
const PUBLIC_ROUTES = [
  ["", "2026-10-08"],
  // No `lastmod`: the page lists a ranking of the whole catalogue, which changes with any new, changed
  // or withdrawn sale. No reliable date exists for it (the newest `updated_at` of a sale moves with
  // every collection run, and `content_changed_at` is null for a new sale), and a missing date
  // is better than a false one.
  ["/sales", null],
  ["/avocats", "2026-10-08"],
  ["/offres", "2026-10-14"],
  ["/comment-ca-marche", "2026-10-13"],
  ["/ressources", "2026-10-19"],
  ["/tribunaux", "2026-10-13"],
  ["/annonce-exemple", "2026-10-15"],
  ["/ventes-immobilieres-judiciaires", GUIDE_LAST_UPDATED], // same date as the guide page
  ["/simulateur-frais-encheres", "2026-10-13"],
  [PUBLIC_ADJUDICATION_PRICES_PATH, null], // listed only while PUBLIC_ADJUDICATION_PRICES_ENABLED is "true"
  ["/a-propos", "2026-10-13"],
  ["/contact", "2026-10-08"],
  ["/classement-des-annonces", "2026-10-14"],
  ["/methode-ecart-marche", "2026-10-15"],
  ["/legal", "2026-10-08"],
  ["/conditions-generales", "2026-10-14"],
  ["/privacy", "2026-10-14"],
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;

  // `loadPublicTribunalActivity` reports an unavailable database as an error result, and
  // `/tribunaux` then stays listed (only a successful read that finds no court removes it).
  // The departments follow the same rule as the courts: a read error leaves the index listed and
  // adds no department page (a passing outage must not remove them for good, nor invent them).
  const [tribunals, departments] = await Promise.all([
    loadPublicTribunalActivity(),
    tryLoadDepartmentCatalogue(),
  ]);
  const indexable = departments.status === "ok" ? indexableDepartments(departments.catalogue) : [];

  const pages = PUBLIC_ROUTES
    // The courts page has nothing to list (and is not indexed) while no court is listed.
    // A read error is not "no court": the page stays in the sitemap.
    .filter(
      ([path]) =>
        path !== "/tribunaux" || tribunals.status === "error" || tribunals.items.length > 0,
    )
    .filter(
      ([path]) => path !== PUBLIC_ADJUDICATION_PRICES_PATH || isPublicAdjudicationPricesEnabled(),
    )
    .map(([path, lastModified]) => ({
      url: `${origin}${path}`,
      ...(lastModified ? { lastModified } : {}),
    }));

  // The departments index is noindex while no department page qualifies (same predicate as the
  // page); a department page is listed from DEPARTMENT_PAGE_MIN_SALES upcoming sales. No
  // `lastModified`: the figures are rebuilt every hour, which is not a content change.
  const departmentPages =
    departments.status === "ok" && indexable.length === 0
      ? []
      : [{ url: `${origin}${DEPARTMENT_PAGES_PATH}` }];
  return [
    ...pages,
    ...departmentPages,
    ...indexable.map((department) => ({ url: `${origin}${department.path}` })),
  ];
}
