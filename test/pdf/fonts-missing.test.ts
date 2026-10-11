import { StandardFonts } from "pdf-lib";
import { expect, test, vi } from "vitest";

// As if scripts/pdfjs.mjs never fetched them: no font files anywhere.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, existsSync: (path: string) => !String(path).endsWith(".ttf") && fs.existsSync(path) };
});

const { chooseFace } = await import("../../src/pdf/fonts");

test("a bundled family without its files falls back to the standard font of its kind", () => {
  expect(chooseFace({ family: "Roboto", bold: true })).toEqual({ key: StandardFonts.HelveticaBold, standard: StandardFonts.HelveticaBold });
  expect(chooseFace({ family: "Lora", italic: true }).standard).toBe(StandardFonts.TimesRomanItalic);
});
