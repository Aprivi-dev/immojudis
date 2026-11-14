import { redirect } from "next/navigation";

/** Ancienne adresse : « Inscriptions » est un onglet de la vue Comptes. */
export default function Page() {
  redirect("/admin/comptes?onglet=inscriptions");
}
