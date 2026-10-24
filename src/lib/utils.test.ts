import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps the theme's caption size next to a text colour", () => {
    expect(cn("text-caption font-medium", "text-warning")).toBe(
      "text-caption font-medium text-warning",
    );
  });

  it("still lets a later size replace the caption size", () => {
    expect(cn("text-caption", "text-sm")).toBe("text-sm");
  });
});
