// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBlob } from "./download-blob";

describe("downloadBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("télécharge le fichier sous son nom, puis libère l'adresse et retire le lien", () => {
    const createObjectURL = vi.fn(() => "blob:fichier");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download, attached: this.isConnected });
    });
    const blob = new Blob(["contenu"], { type: "text/plain" });

    downloadBlob(blob, "export.txt");

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ href: "blob:fichier", download: "export.txt", attached: true }]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fichier");
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
