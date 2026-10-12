import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { FavoriteSales } from "@/components/FavoriteSales";

export const metadata: Metadata = {
  title: "Mes favoris",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <FavoriteSales />
    </AuthGate>
  );
}
