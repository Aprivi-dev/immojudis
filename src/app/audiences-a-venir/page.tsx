import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { pageMetadata } from "@/lib/page-metadata";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";
import { parisDateKey } from "@/lib/sale-countdown";
import { tribunalPages } from "@/lib/tribunal-pages";
import {
  HEARINGS_PATH,
  dedupeHearings,
  hearingsPageDescription,
  isHearingsPageIndexable,
  windowHearings,
} from "@/lib/upcoming-hearings";
import {
  mustFailOnHearingsReadError,
  tryLoadUpcomingHearings,
} from "@/lib/upcoming-hearings.server";
import { HearingsView } from "./hearings-view";

// Comme la fiche d'une vente et les pages département : page rendue à l'avance, servie depuis le
// cache et rafraîchie au plus toutes les heures (Next.js veut un littéral ici ; il doit rester égal
// à PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS, un test le vérifie). Une régénération qui ne peut
// pas lire la base lève une erreur : la dernière bonne page reste servie (voir
// `mustFailOnHearingsReadError`).
export const revalidate = 3600;

/** Les audiences, ou `null` quand la lecture a échoué pendant le build (page produite sans liste). */
async function loadWindows() {
  const read = await tryLoadUpcomingHearings();
  if (read.status === "error") {
    if (mustFailOnHearingsReadError()) throw new Error("Audiences à venir indisponibles.");
    return null;
  }
  const now = new Date();
  return {
    now,
    today: parisDateKey(now),
    windows: windowHearings(dedupeHearings(read.hearings), now),
    truncated: read.totalCount > read.hearings.length,
  };
}

export async function generateMetadata(): Promise<Metadata> {
  const data = await loadWindows();
  const weekCount = data?.windows.weekCount ?? 0;
  const laterCount = data?.windows.laterCount ?? 0;
  return {
    ...pageMetadata({
      path: HEARINGS_PATH,
      title: "Audiences de ventes judiciaires à venir",
      description: hearingsPageDescription(weekCount, laterCount),
    }),
    // Trop peu d'audiences (ou lecture impossible au build) : page consultable, mais sans intérêt
    // pour un moteur de recherche. Elle reste hors du sitemap (même seuil) et ses liens sont suivis.
    ...(isHearingsPageIndexable(weekCount + laterCount)
      ? {}
      : { robots: { index: false, follow: true } }),
  };
}

export default async function Page() {
  const [data, activity] = await Promise.all([loadWindows(), loadPublicTribunalActivity()]);
  // Sans l'activité des tribunaux, les tribunaux restent nommés, sans lien vers leur page.
  const tribunalPaths = new Map(
    activity.status === "ok"
      ? tribunalPages(activity.items).map((page) => [page.activity.code, page.path] as const)
      : [],
  );
  const now = data?.now ?? new Date();
  return (
    <>
      <BreadcrumbJsonLd
        trail={[
          { name: "Tribunaux", path: "/tribunaux" },
          { name: "Audiences à venir", path: HEARINGS_PATH },
        ]}
      />
      <HearingsView
        windows={data?.windows ?? { week: [], weekCount: 0, later: [], laterCount: 0 }}
        today={data?.today ?? parisDateKey(now)}
        tribunalPaths={tribunalPaths}
        truncated={data?.truncated ?? false}
        unavailable={data === null}
        generatedAt={now}
      />
    </>
  );
}
