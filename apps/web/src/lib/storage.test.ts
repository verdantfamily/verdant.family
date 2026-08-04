/**
 * The upload path's two jobs: believe the bytes rather than the caller, and put the same
 * picture at the same address every time.
 */
import { describe, expect, it } from "vitest";

import { extensionFormat, sniffFormat } from "./storage";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);

describe("sniffing an upload", () => {
  it("reads the format out of the bytes", () => {
    expect(sniffFormat(PNG)).toBe("image/png");
    expect(sniffFormat(JPEG)).toBe("image/jpeg");
    expect(sniffFormat(WEBP)).toBe("image/webp");
    expect(sniffFormat(GIF)).toBe("image/gif");
  });

  it("refuses anything that is not one of those four", () => {
    // The first is the case the check exists for: a document that would be served back
    // under an image URL if the declared content type were believed.
    expect(sniffFormat(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffFormat(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(sniffFormat(new Uint8Array([]))).toBeNull();
    expect(sniffFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("serving the development store back", () => {
  it("maps a stored name to the type it will be served as", () => {
    expect(extensionFormat("abc.png")).toBe("image/png");
    expect(extensionFormat("abc.webp")).toBe("image/webp");
    expect(extensionFormat("abc.jpg")).toBe("image/jpeg");
    expect(extensionFormat("abc.gif")).toBe("image/gif");
  });

  it("has no answer for anything else", () => {
    expect(extensionFormat("abc.svg")).toBeNull();
    expect(extensionFormat("abc.html")).toBeNull();
    expect(extensionFormat("abc")).toBeNull();
  });
});
