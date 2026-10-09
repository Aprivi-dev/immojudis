import type { Metadata } from "next";
import { validateDirectorySearch } from "@/lib/lawyer-directory-search";
import { LawyerDirectoryPage } from "@/routes/avocats";

export const metadata: Metadata = {
  alternates: { canonical: "/avocats" },
  title: "Annuaire des avocats en droit immobilier",
  description:
    "Trouvez un avocat en droit immobilier par barreau et identifiez clairement les profils partenaires sponsorisés.",
};

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
  return <LawyerDirectoryPage search={search} />;
}
