import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { pageMetadata } from "@/lib/page-metadata";
import { LawyerDirectoryPage } from "./lawyer-directory-page";

export const metadata: Metadata = pageMetadata({
  path: "/avocats",
  title: "Annuaire des avocats par barreau",
  description:
    "Trouvez un avocat inscrit au barreau compétent et identifiez clairement les profils bénéficiant d’une mise en avant payante.",
});

// Static page: the filters of the URL are read in the browser (see `LawyerDirectoryPage`), so
// the page does not depend on the request and is served by the CDN like the other content pages.
export default function Page() {
  return (
    <>
      <BreadcrumbJsonLd trail={[{ name: "Annuaire des avocats", path: "/avocats" }]} />
      <LawyerDirectoryPage />
    </>
  );
}
