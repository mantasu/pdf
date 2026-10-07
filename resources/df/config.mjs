/**
 * Viewer configuration: enables the Adobe-style tool set and seeds the
 * default colors / font size from the host settings.
 */
import { PDFViewerApplicationOptions } from "../pdf.js/web/viewer.mjs";
import { bus, config } from "./util.mjs";

export function configureViewer() {
  const opts = PDFViewerApplicationOptions;
  opts.set("defaultUrl", "");
  opts.set("disablePreferences", true);
  opts.set("defaultZoomValue", config.defaultZoomValue || "auto");
  opts.set("sidebarViewOnLoad", config.sidebarViewOnLoad ?? 0);
  opts.set("sandboxBundleSrc", `${config.pdfJsBuild}pdf.sandbox.mjs`);
  opts.set("cMapUrl", `${config.pdfJsWeb}cmaps/`);
  opts.set("iccUrl", `${config.pdfJsWeb}iccs/`);
  opts.set("standardFontDataUrl", `${config.pdfJsWeb}standard_fonts/`);
  opts.set("wasmUrl", `${config.pdfJsWeb}wasm/`);
  opts.set("imageResourcesPath", `${config.pdfJsWeb}images/`);
  // Enable the full Adobe-style tool set: highlight, ink, free text, image,
  // signature and comments, plus page reorganization from the thumbnails.
  opts.set("annotationEditorMode", config.annotationEditorMode ?? 0);
  opts.set("enableSignatureEditor", true);
  opts.set("enableComment", true);
  opts.set("enableMerge", true);
  // Always override: the pdf.js defaults put a mint green next to a pale cyan
  // (indistinguishable) and a near-white pink. These five are clearly distinct.
  opts.set(
    "highlightEditorColors",
    config.highlightColors ||
      "Yellow=#FFF200,Orange=#FF8A00,Blue=#54C8FF,Pink=#FF6EC7,Red=#FF3B30",
  );
}

const PARAM = { freeTextFontSize: 11, freeTextColor: 12, freeTextFontFamily: 14, inkColor: 21 };

/** Apply the configured tool defaults once the editor manager exists. */
export function seedToolDefaults() {
  for (const key of ["freeTextColor", "freeTextFontSize", "freeTextFontFamily", "inkColor"]) {
    if (config[key] !== undefined && config[key] !== null && config[key] !== "") {
      bus().dispatch("switchannotationeditorparams", { type: PARAM[key], value: config[key] });
    }
  }
}
