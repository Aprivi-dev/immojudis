import { redirect } from "next/navigation";

/** Ancienne adresse : « Clients & abonnements » est un onglet de la vue Comptes. */
export default function Page() {
  redirect("/admin/comptes?onglet=clients");
}
