import { redirect } from "next/navigation";

/** Ancienne adresse : « Pépites » est un onglet de la vue Qualité des données. */
export default function Page() {
  redirect("/admin/quality?onglet=pepites");
}
