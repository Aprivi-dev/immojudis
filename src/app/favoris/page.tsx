import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { FavoriteSales } from "@/components/FavoriteSales";
import { FeeRegimesProvider } from "@/components/FeeRegimesProvider";
import { feeRegimesSettingsFromEnv } from "@/lib/fee-regime.server";

export const metadata: Metadata = {
  title: "Mes favoris",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <FeeRegimesProvider value={feeRegimesSettingsFromEnv()}>
        <FavoriteSales />
      </FeeRegimesProvider>
    </AuthGate>
  );
}
