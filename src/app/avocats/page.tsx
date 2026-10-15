import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { validateDirectorySearch } from "@/lib/lawyer-directory-search";
import { pageMetadata } from "@/lib/page-metadata";
import { LawyerDirectoryPage } from "./lawyer-directory-page";

export const metadata: Metadata = pageMetadata({
  path: "/avocats",
  title: "Annuaire des avocats par barreau",
  description:
    "Trouvez un avocat inscrit au barreau compétent et identifiez clairement les profils bénéficiant d’une mise en avant payante.",
});

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  // Read on the server so the heading and the search form are in the HTML itself.
  const search = validateDirectorySearch(
    Object.fromEntries(
      Object.entries(params).map(([key, value]) => [
        key,
        Array.isArray(value) ? value[value.length - 1] : value,
      ]),
    ),
  );
  return (
    <>
      <BreadcrumbJsonLd trail={[{ name: "Annuaire des avocats", path: "/avocats" }]} />
      <LawyerDirectoryPage search={search} />
    </>
  );
}
