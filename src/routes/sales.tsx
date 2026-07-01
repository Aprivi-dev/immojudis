import { createFileRoute, Outlet } from "@/lib/router-compat";

export const Route = createFileRoute("/sales")({
  component: SalesLayout,
});

function SalesLayout() {
  return <Outlet />;
}
