/**
 * Document lifecycle: opening, serialization (annotations and/or page
 * reorganization), dirty tracking, save/print routing through the host, and
 * Ctrl/Cmd+P.
 */
import { app, bus, config, post, postError, ui } from "./util.mjs";
import { seedToolDefaults } from "./config.mjs";
import { onNotesDocumentOpen } from "./notes.mjs";
import { closeDialog } from "./dialog.mjs";

/**
 * Current PDF bytes: structural page changes live in the thumbnail viewer's
 * pagesMapper (extractPages), annotations in annotationStorage (saveDocument).
 */
export async function serialize() {
  const doc = app().pdfDocument;
  if (!doc) {
    throw new Error("The PDF is not loaded yet.");
  }
  const thumbs = app().pdfThumbnailViewer;
  if (thumbs?.hasStructuralChanges?.()) {
    return doc.extractPages(thumbs.getStructuralChanges());
  }
  return doc.annotationStorage.size > 0 ? doc.saveDocument() : doc.getData();
}

/** Route every viewer download/save through the extension host. */
function redirectDownloads() {
  const manager = app().downloadManager;
  if (!manager || manager.__df) {
    return;
  }
  manager.__df = true;
  manager.download = (data) => post({ type: "saved", data });
}

/** Report annotation or page-structure changes as editor dirty state. */
function hookDirtyTracking() {
  const storage = app().pdfDocument?.annotationStorage;
  if (!storage) {
    return;
  }
  const originalSet = storage.onSetModified;
  const originalReset = storage.onResetModified;
  storage.onSetModified = () => {
    originalSet?.();
    post({ type: "dirty", dirty: true });
  };
  storage.onResetModified = () => {
    originalReset?.();
    post({ type: "dirty", dirty: false });
  };
  // Thumbnail page reorganization (drag/cut/delete) mutates pagesMapper without
  // touching annotationStorage; pdf.js dispatches "pagesedited" for those.
  bus().on("pagesedited", () => post({ type: "dirty", dirty: true }));
  // Merging (drag-drop / "add file") reloads the document and flags it via
  // _mergedDocumentNeedsSaving; annotationStorage is fresh so nothing else fires.
  bus().on("pagesloaded", () => {
    if (app()._mergedDocumentNeedsSaving) {
      post({ type: "dirty", dirty: true });
    }
  });
}

export async function openDocument(page) {
  const instance = app();
  await instance.open({ url: config.url, resetHistory: true });
  await instance.pdfViewer.pagesPromise;
  if (page) {
    instance.pdfViewer.currentPageNumber = Math.min(page, instance.pdfViewer.pagesCount);
  }
  redirectDownloads();
  hookDirtyTracking();
  seedToolDefaults();
  const manager = ui();
  if (manager) {
    // Default /T author for annotations, like Acrobat (the OS user name).
    manager.dfDefaultAuthor = config.authorName || null;
  }
  onNotesDocumentOpen();
  closeDialog();
  const hash = config.url.split("#")[1];
  if (hash) {
    instance.pdfLinkService.setHash(decodeURIComponent(hash));
  }
}

export function initDocEvents() {
  // The webview cannot print; serialize and ask the host instead.
  app().triggerPrinting = async () => {
    try {
      post({ type: "print", data: await serialize() });
    } catch (error) {
      postError(error);
    }
  };
  // Ctrl/Cmd+P inside the viewer triggers our print (not the webview's no-op).
  document.addEventListener(
    "keydown",
    (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "p") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void app().triggerPrinting();
      }
    },
    true,
  );
  bus().on("pagechanging", (evt) => {
    if (evt.pageNumber) {
      post({ type: "page", page: evt.pageNumber });
    }
  });
}
