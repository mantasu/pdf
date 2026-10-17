/**
 * Entry point of the webview. Configures the unmodified pdf.js viewer, opens what the host sends,
 * answers its requests, routes the keyboard and starts the other modules. pdf.js draws the page content;
 * annotations are drawn by this viewer, and the host removes them from the copy pdf.js receives.
 */
import { PDFViewerApplication, PDFViewerApplicationOptions } from "../pdf.js/web/viewer.mjs";
import { deleteThread, hideSelectionBar, setupBars } from "./commands.mjs";
import { closeCopilot, copilotOpen, onCopilotReply, pdfContext, setupCopilot } from "./copilot.mjs";
import * as model from "./annotations.mjs";
import { cardId, closeCard, flushCard, hidePeek, setupCard } from "./card.mjs";
import { config, h, hostCommand, isTextInput, pdfApp, pdfViewer, pref, reportError, setPref, toHost } from "./core.mjs";
import { commitTextBox } from "./insert.mjs";
import { TEXT_LAYER_FONTS, attachAllLayers, attachLayers, clearLayers, installFonts, redrawAll } from "./layers.mjs";
import { setupPointer } from "./pointer.mjs";
import { setupToolbar } from "./toolbar.mjs";
import { activeTool, backToSelect, chooseTool } from "./tools.mjs";
import { closeMenu, menuOpen, setupTooltips } from "./ui.mjs";

// --- pdf.js set-up ---------------------------------------------------------------

const pdfOptions = {
  defaultUrl: "",
  disablePreferences: true,
  disableHistory: true,
  defaultZoomValue: config.defaultZoomValue || "auto",
  sidebarViewOnLoad: config.sidebarViewOnLoad ?? 0,
  // The layout last picked in pdf.js's ">>" menu (two-page spreads and the like); -1 leaves it to the PDF.
  scrollModeOnLoad: pref("scrollMode", -1),
  spreadModeOnLoad: pref("spreadMode", -1),
  // AnnotationEditorType.DISABLE (-1): this viewer has its own editing, so pdf.js's editors and their toolbar stay off.
  annotationEditorMode: -1,
  enableComment: false,
  enableHighlightFloatingButton: false,
  enableSignatureEditor: false,
  enableMerge: false,
  enableSplitMerge: false,
  enableScripting: false,
  // On a machine without a GPU, opening would hang waiting for a WebGPU adapter; pdf.js only wants it for gradients.
  enableWebGPU: false,
  docBaseUrl: config.documentUrl,
  cMapUrl: `${config.pdfJsWeb}cmaps/`,
  iccUrl: `${config.pdfJsWeb}iccs/`,
  standardFontDataUrl: `${config.pdfJsWeb}standard_fonts/`,
  wasmUrl: `${config.pdfJsWeb}wasm/`,
  imageResourcesPath: `${config.pdfJsWeb}images/`,
};
for (const [name, value] of Object.entries(pdfOptions)) {
  PDFViewerApplicationOptions.set(name, value);
}

// pdf.js colors come from CSS light-dark(), i.e. the root's color-scheme, which would track the OS;
// follow the theme class VS Code puts (and updates) on <body> instead.
function matchVsCodeTheme() {
  const theme = /\bvscode-(light|dark|high-contrast-light|high-contrast)\b/u.exec(document.body.className)?.[1];
  if (theme) {
    document.documentElement.style.colorScheme = theme === "dark" || theme === "high-contrast" ? "dark" : "light";
  }
}
matchVsCodeTheme();
new MutationObserver(matchVsCodeTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// A webview can neither print nor download, so Print and Save go to the host. pdf.js only looks
// these methods up while starting, which happens after this module has run.
PDFViewerApplication.triggerPrinting = () => hostCommand("pdf-editor.print");
// pdf.js handles Ctrl/Cmd+P by calling window.print() directly, which does nothing in a webview.
window.print = () => hostCommand("pdf-editor.print");
PDFViewerApplication.downloadOrSave = async () => hostCommand("workbench.action.files.save");

// --- Host messages ---------------------------------------------------------------

window.addEventListener("message", async (event) => {
  const message = event.data;
  try {
    switch (message?.type) {
      case "load":
        await queueLoad(message);
        break;
      case "annotations":
        model.restore(message.annotations);
        break;
      case "request-snapshot":
        toHost({ type: "snapshot", requestId: message.requestId, snapshot: await takeSnapshot(message.flush) });
        break;
      case "request-context":
        toHost({ type: "context", requestId: message.requestId, context: await pdfContext() });
        break;
      case "copilot-text":
      case "copilot-done":
        onCopilotReply(message);
        break;
    }
  } catch (error) {
    reportError(error);
  }
});

// --- Start-up --------------------------------------------------------------------

PDFViewerApplication.initializedPromise.then(start).catch(reportError);

function start() {
  installFonts();
  setupToolbar();
  setupCard();
  setupBars();
  setupCopilot();
  setupTooltips();
  setupPointer();
  window.addEventListener("keydown", routeKey, true);
  wireDocumentEvents();
  const bus = PDFViewerApplication.eventBus;
  // When some page is wider than the viewer (a rotated one, say), pdf.js scrolls sideways on
  // opening or fitting; bring the current page back to the horizontal middle, as Acrobat does.
  bus.on("scalechanging", ({ presetValue }) => {
    if (typeof presetValue === "string") {
      requestAnimationFrame(centerCurrentPage);
    }
  });
  // Likewise on reaching another page: a rotated page can be wider than the view and would show only its left part.
  bus.on("pagechanging", () => requestAnimationFrame(centerCurrentPage));
  // Only pdf.js's menu fires these, so a layout the PDF asks for is not remembered. Setting the
  // option too keeps the layout when the document reopens this session (undoing a page operation does).
  for (const [eventName, prefKey] of [["switchscrollmode", "scrollMode"], ["switchspreadmode", "spreadMode"]]) {
    bus.on(eventName, ({ mode }) => {
      PDFViewerApplicationOptions.set(`${prefKey}OnLoad`, mode);
      if (pref(prefKey) !== mode) {
        setPref(prefKey, mode);
      }
    });
  }
  // pdf.js measures (and caches) each text-layer font's ascent when it first lays out text, so the fonts must be loaded before a document is.
  const { TextLayer } = globalThis.pdfjsLib;
  for (const [generic, [name]] of Object.entries(TEXT_LAYER_FONTS)) {
    TextLayer.fontFamilyMap.set(generic, `"${name}", ${generic}`);
  }
  Promise.all(Object.values(TEXT_LAYER_FONTS).map(([name]) => document.fonts.load(`16px "${name}"`)))
    .catch(() => undefined)
    .finally(() => toHost({ type: "ready" }));
}

function centerCurrentPage() {
  const scroller = document.getElementById("viewerContainer");
  const pageBox = PDFViewerApplication.pdfViewer.getPageView(PDFViewerApplication.page - 1)?.div.getBoundingClientRect();
  if (pageBox) {
    scroller.scrollLeft += pageBox.left + pageBox.width / 2 - (scroller.getBoundingClientRect().left + scroller.clientWidth / 2);
  }
}

// --- Document lifecycle ----------------------------------------------------------

/** Reading position from pdf.js's last "updateviewarea", restored when the document is reloaded. */
let lastLocation = null;
let readOnlyBanner = null;
let loadChain = Promise.resolve();
/** Settles when pdf.js has finished loading the current document's pages. */
let pagesSettled = Promise.resolve();
let workerReady;
let formEditTimer = 0;

// Loads run one after another, each first waiting (at most 5 s) for pdf.js to finish loading the
// previous document's pages: closing it half-way through aborts that work.
function queueLoad(message) {
  loadChain = loadChain.catch(() => undefined).then(() => loadDocument(message));
  return loadChain;
}

async function loadDocument({ data, annotations, readOnly, page }) {
  await Promise.race([pagesSettled, new Promise((resolve) => setTimeout(resolve, 5000))]);
  closeMenu();
  hidePeek();
  hideSelectionBar();
  closeCard({ discard: true });
  const previous = pdfViewer()?.pdfDocument ? { location: lastLocation, scale: pdfViewer().currentScaleValue } : null;
  // Otherwise pdf.js would offer to save changed form fields on close; saving is up to the host.
  pdfApp().pdfDocument?.annotationStorage.resetModified();
  clearLayers();
  model.reset(annotations, readOnly);
  showReadOnlyBanner(readOnly);

  const pagesInit = waitForEvent("pagesinit");
  const pagesLoaded = waitForEvent("pagesloaded");
  pagesSettled = pagesLoaded.promise;
  try {
    PDFViewerApplicationOptions.set("workerPort", await startWorker());
    await pdfApp().open({ data, filename: config.fileName, useWorkerFetch: false });
    await pagesInit.promise;
  } catch (error) {
    pagesInit.cancel();
    pagesLoaded.cancel();
    pagesSettled = Promise.resolve();
    throw error;
  }
  watchFormEdits();
  attachAllLayers();
  restoreView(previous, page);
}

/** Put back the zoom and scroll position of the previous load, or go to the page the host asked for. */
function restoreView(previous, requestedPage) {
  if (previous) {
    pdfViewer().currentScaleValue = previous.scale;
  }
  const pageNumber = Math.min(Math.max(1, requestedPage ?? previous?.location?.pageNumber ?? 1), pdfViewer().pagesCount);
  if (previous?.location && previous.location.pageNumber === pageNumber) {
    const { left, top } = previous.location;
    pdfViewer().scrollPageIntoView({ pageNumber, destArray: [null, { name: "XYZ" }, left, top, null] });
  } else if (requestedPage) {
    pdfViewer().currentPageNumber = pageNumber;
  }
}

function showReadOnlyBanner(reason) {
  readOnlyBanner?.remove();
  readOnlyBanner = null;
  if (reason) {
    readOnlyBanner = h("div", { className: "pdf-banner", role: "status" }, `Comments are read-only: ${reason}`);
    document.getElementById("viewerContainer")?.before(readOnlyBanner);
  }
}

/** A promise for the next pdf.js event `name`, plus `cancel()` for when that event never comes. */
function waitForEvent(name) {
  let listener;
  const promise = new Promise((resolve) => {
    listener = resolve;
    pdfApp().eventBus.on(name, listener, { once: true });
  });
  return { promise, cancel: () => pdfApp().eventBus.off(name, listener) };
}

/**
 * Extension files sit on another origin behind a VS Code service worker that only serves the page, so a
 * Worker loading or fetching them stalls (pdf.js gives up after ~30 s and parses on the main thread).
 * Hence a blob-URL worker, and the page fetches fonts, CMaps and WASM for it (`useWorkerFetch: false`).
 */
async function startWorker() {
  workerReady ??= fetch(`${config.pdfJsBuild}pdf.worker.mjs`)
    .then((response) => response.blob())
    .then((source) => new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })), { type: "module" }));
  return workerReady;
}

// Tell the host about form input after a pause. It replies by taking a snapshot, and taking one clears
// pdf.js's "modified" flag again, so every pause in typing ends one undo step.
function watchFormEdits() {
  clearTimeout(formEditTimer);
  const formValues = pdfApp().pdfDocument?.annotationStorage;
  if (!formValues) {
    return;
  }
  const pdfJsHandler = formValues.onSetModified;
  formValues.onSetModified = () => {
    pdfJsHandler?.();
    clearTimeout(formEditTimer);
    formEditTimer = setTimeout(() => toHost({ type: "form-edit" }), 400);
  };
}

/** State for the host to write, print or keep as a backup: the annotations, plus the PDF bytes when forms were filled in. */
async function takeSnapshot(flush) {
  if (flush) {
    // Unfinished typing must be saved too; File > Save never passes through the key handler below.
    commitTextBox();
    flushCard();
  }
  // These form values are in this snapshot; a report arriving after the save would flag the file as modified again.
  clearTimeout(formEditTimer);
  const pdfDocument = pdfApp().pdfDocument;
  const state = { annotations: model.list() };
  if (pdfDocument && pdfDocument.annotationStorage.size > 0) {
    state.formData = await pdfDocument.saveDocument();
    // So the next field edit fires onSetModified again.
    pdfDocument.annotationStorage.resetModified();
  }
  return state;
}

function wireDocumentEvents() {
  const bus = pdfApp().eventBus;
  bus.on("pagerendered", ({ source }) => attachLayers(source));
  bus.on("textlayerrendered", ({ source }) => attachLayers(source));
  bus.on("rotationchanging", () => redrawAll());
  bus.on("updateviewarea", ({ location }) => {
    lastLocation = location;
  });
  bus.on("pagechanging", ({ pageNumber }) => toHost({ type: "page", page: pageNumber }));

  // A relative link names a file next to the PDF; VS Code opens it rather than the webview.
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target?.closest?.("a[href]");
      if (link && config.resourceRoot && link.href.startsWith(config.resourceRoot)) {
        event.preventDefault();
        event.stopPropagation();
        toHost({ type: "open", url: link.href });
      }
    },
    true,
  );
}

// --- Keyboard --------------------------------------------------------------------
// Shortcuts are caught in the capture phase: otherwise save, print, undo and redo could fire twice, once in
// VS Code (which receives them even from inputs) and once in pdf.js. Saving and undoing go through VS Code
// commands to keep its dirty state and history in sync; inside an input, undo stays the input's own.
function swallow(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function routeKey(event) {
  const withModifier = (event.ctrlKey || event.metaKey) && !event.altKey;
  const key = event.key.toLowerCase();
  const typing = isTextInput(event.target);

  if (withModifier && key === "s") {
    swallow(event);
    // Commit unfinished typing before saving.
    commitTextBox();
    closeCard();
    hostCommand("workbench.action.files.save");
    return;
  }
  if (withModifier && key === "p") {
    swallow(event);
    hostCommand("pdf-editor.print");
    return;
  }
  if (withModifier && (key === "z" || key === "y")) {
    if (typing) {
      // Hide the key from VS Code but keep its default, so the field undoes its own text.
      event.stopImmediatePropagation();
      return;
    }
    swallow(event);
    hostCommand(key === "y" || event.shiftKey ? "redo" : "undo");
    return;
  }
  // Every other key in a field or a dialog (the signature pad) belongs to it.
  if (typing || event.target.closest?.(".pdf-dialog-backdrop")) {
    return;
  }
  // S and H pick Select and Hand. pdf.js has the same keys, but only for its own cursor tools, so with
  // another tool (say, Highlight) on, its S changed nothing.
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (key === "s" || key === "h")) {
    swallow(event);
    const tool = key === "s" ? "select" : "hand";
    if (activeTool() !== tool) {
      chooseTool(tool);
    }
    return;
  }
  // Escape closes one thing, innermost first.
  if (event.key === "Escape") {
    hideSelectionBar();
    if (menuOpen()) {
      closeMenu();
    } else if (copilotOpen()) {
      closeCopilot();
    } else if (cardId()) {
      closeCard({ discard: true });
    } else if (activeTool() !== "select") {
      backToSelect();
    } else if (model.selectedId()) {
      model.select(null);
    } else {
      return;
    }
    swallow(event);
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && !withModifier && model.selectedId()) {
    swallow(event);
    deleteThread(model.selectedId());
  }
}
