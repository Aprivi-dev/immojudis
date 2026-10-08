// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { DateFilter } from "./DateFilter";
import { emptySearchDraft } from "./search-page-state";

afterEach(cleanup);

function Harness() {
  const [draft, setDraft] = useState(emptySearchDraft);
  return <DateFilter draft={draft} setDraft={setDraft} />;
}

it("focuses the first date input and restores the trigger on Escape", () => {
  render(<Harness />);

  const trigger = screen.getByRole("button", { name: /Date de vente/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("aria-controls")).toBeTruthy();

  fireEvent.click(trigger);

  const dialog = screen.getByRole("dialog", { name: "Date de vente" });
  const firstInput = screen.getByLabelText("Date de vente minimum");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(dialog.getAttribute("id")).toBe(trigger.getAttribute("aria-controls"));
  expect(document.activeElement).toBe(firstInput);

  fireEvent.keyDown(firstInput, { key: "Escape" });

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
