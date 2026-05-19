import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/sales")({
  component: SalesLayout,
});

function SalesLayout() {
  return <Outlet />;
}
