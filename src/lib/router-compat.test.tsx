// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileRoute, Link, useNavigate } from "./router-compat";
import { validateSalesSearch } from "./search/search-url-state";

const mocks = vi.hoisted(() => ({
  search: "city=Bordeaux",
  router: {
    push: vi.fn(),
    replace: vi.fn(),
  },
}));

vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  useParams: () => ({}),
  usePathname: () => "/sales",
  useRouter: () => mocks.router,
  useSearchParams: () => ({ toString: () => mocks.search }),
}));

function NavigationTrigger({
  options,
}: {
  options: Parameters<ReturnType<typeof useNavigate>>[0];
}) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(options)}>Navigate</button>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.search = "city=Bordeaux";
  window.history.replaceState(null, "", "/");
});

describe("same-route shallow navigation", () => {
  it("preserves geographic zeroes while route validators parse numeric filters", () => {
    mocks.search = "q=06000&department=01&page=2&maxPrice=150000";
    const route = createFileRoute("/sales")({ validateSearch: validateSalesSearch });
    function SearchValues() {
      return <output>{JSON.stringify(route.useSearch())}</output>;
    }
    const view = render(<SearchValues />);
    expect(JSON.parse(view.getByRole("status").textContent!)).toMatchObject({
      query: "06000",
      department: "01",
      page: 2,
      maxPrice: 150000,
    });
  });

  it("keeps anchors when constructing links with search parameters", () => {
    const view = render(
      <Link to="/#exemples" search={{ source: "demo" }}>
        Exemple
      </Link>,
    );
    expect(view.getByRole("link").getAttribute("href")).toBe("/?source=demo#exemples");
  });

  it("uses native replaceState for same-route query updates", () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const view = render(
      <NavigationTrigger options={{ search: { city: "Paris" }, replace: true, shallow: true }} />,
    );

    fireEvent.click(view.getByRole("button", { name: "Navigate" }));

    expect(replaceState).toHaveBeenCalledWith(null, "", "/sales?city=Paris");
    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/sales");
    expect(window.location.search).toBe("?city=Paris");
  });

  it("keeps native history scoped to same-route replacements", () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const view = render(
      <NavigationTrigger options={{ to: "/login", replace: true, shallow: true }} />,
    );

    fireEvent.click(view.getByRole("button", { name: "Navigate" }));

    expect(replaceState).not.toHaveBeenCalled();
    expect(mocks.router.replace).toHaveBeenCalledWith("/login");
  });

  it("keeps push navigation on the Next router even when shallow is requested", () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const view = render(<NavigationTrigger options={{ search: { page: 2 }, shallow: true }} />);

    fireEvent.click(view.getByRole("button", { name: "Navigate" }));

    expect(replaceState).not.toHaveBeenCalled();
    expect(mocks.router.push).toHaveBeenCalledWith("/sales?page=2");
  });
});
