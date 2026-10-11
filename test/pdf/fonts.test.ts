import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { FONT_FAMILIES, chooseFace, daTag, embedFace, faceWorks, familyNamed } from "../../src/pdf/fonts";

describe("text-box fonts", () => {
  test("font names map to our families, else to the standard font of their kind", () => {
    expect(familyNamed("Roboto")).toBe("Roboto");
    expect(familyNamed("'Roboto-Bold', sans-serif")).toBe("Roboto");
    expect(familyNamed("Lora-Italic")).toBe("Lora");
    expect(familyNamed('"Comic Neue"')).toBe("Comic Neue");
    expect(familyNamed("Courier New")).toBe("Courier");
    expect(familyNamed("Times New Roman")).toBe("Times");
    expect(familyNamed("TiRo")).toBe("Times");
    expect(familyNamed("DejaVu Sans")).toBe("Helvetica");
    expect(familyNamed("")).toBe("Helvetica");
    expect(FONT_FAMILIES).toEqual(["Helvetica", "Times", "Courier", "Roboto", "Lora", "Comic Neue"]);
  });

  test("/DA names the standard font of the family's kind", () => {
    expect(["Roboto", "Lora", "Comic Neue", "Times", "Courier"].map((family) => daTag(family as never))).toEqual(["Helv", "TiRo", "Helv", "TiRo", "Cour"]);
  });

  test("bundled families draw with their own files; standard families and standardOnly with the 14 fonts", () => {
    expect(chooseFace({ family: "Lora", bold: true, italic: true }).file).toMatch(/resources[/\\]fonts[/\\]Lora-BoldItalic\.ttf$/u);
    expect(chooseFace({ family: "Lora", italic: true }, true)).toEqual({ key: StandardFonts.TimesRomanItalic, standard: StandardFonts.TimesRomanItalic });
    expect(chooseFace({ family: "Times", bold: true })).toEqual({ key: StandardFonts.TimesRomanBold, standard: StandardFonts.TimesRomanBold });
    expect(chooseFace({ family: "Unheard Of" as never }).standard).toBe(StandardFonts.Helvetica);
  });

  test("faceWorks tries the text in a scratch document first", async () => {
    expect(await faceWorks(chooseFace({ family: "Roboto" }), "Hello → world")).toBe(true);
    expect(await faceWorks(chooseFace({ family: "Times" }), "x")).toBe(true); // standard fonts need no trial
    expect(await faceWorks({ key: "broken", file: __filename }, "x")).toBe(false); // not a font at all
  });

  test("embedFace embeds each face once per document", async () => {
    const doc = await PDFDocument.create();
    const cache = new Map();
    const roboto = chooseFace({ family: "Roboto" });
    const first = await embedFace(doc, cache, roboto);
    expect(await embedFace(doc, cache, roboto)).toBe(first);
    expect((await embedFace(doc, cache, chooseFace({ family: "Courier" }))).name).toBe("Courier");
    expect(cache.size).toBe(2);
  });
});
