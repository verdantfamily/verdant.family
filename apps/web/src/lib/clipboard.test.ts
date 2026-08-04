/**
 * The copy path's tests.
 *
 * These exist because this is the one piece of behaviour on the market page that cannot be
 * confirmed by looking at it. A headless browser refuses clipboard access, so an automated
 * check of the button cannot tell "the copy is broken" from "the copy was correctly
 * refused and said so by doing nothing" — both look like a label that did not change. The
 * branch that matters, the fall through to the legacy command, is therefore only ever
 * exercised here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./clipboard";

/** The smallest textarea the fallback can drive, plus a record of what it was asked. */
function fakeDocument(execCommand: () => boolean) {
  const holder = {
    value: "",
    readOnly: false,
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };

  return {
    holder,
    document: {
      createElement: vi.fn(() => holder),
      body: { appendChild: vi.fn() },
      execCommand: vi.fn(execCommand),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("uses the async clipboard when it is there and does not touch the DOM", async () => {
    const writeText = vi.fn(async () => undefined);
    const { document } = fakeDocument(() => true);

    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("document", document);

    expect(await copyText("0xabc")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("0xabc");
    // The fallback builds and destroys an element; on the happy path it must not run.
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it("falls back when the clipboard is refused", async () => {
    // What a denied permission looks like: the promise rejects. Before the fallback
    // existed this returned nothing and the button silently did nothing.
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    const { document, holder } = fakeDocument(() => true);

    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("document", document);

    expect(await copyText("0xabc")).toBe(true);
    expect(holder.value).toBe("0xabc");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    // Removed whether or not the command worked, so a page is not left with a growing
    // pile of off-screen textareas.
    expect(holder.remove).toHaveBeenCalled();
  });

  it("falls back on an insecure origin, where the API exists but is inert", async () => {
    const writeText = vi.fn(async () => undefined);
    const { document } = fakeDocument(() => true);

    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("document", document);

    expect(await copyText("0xabc")).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalled();
  });

  it("reports failure rather than claiming a copy that did not happen", async () => {
    const { document, holder } = fakeDocument(() => false);

    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("document", document);

    // The caller shows "Copied" only on `true`, so this is what stops the button lying.
    expect(await copyText("0xabc")).toBe(false);
    expect(holder.remove).toHaveBeenCalled();
  });

  it("survives a fallback that throws", async () => {
    const { document } = fakeDocument(() => {
      throw new Error("execCommand is not a function");
    });

    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("document", document);

    expect(await copyText("0xabc")).toBe(false);
  });
});
