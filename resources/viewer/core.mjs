/**
 * Base layer of the viewer: host bridge, preferences, pdf.js handles, colors, names,
 * DOM helpers and icons. It imports no other viewer module (the Node unit tests load it too).
 */

/** @type {import("../../src/protocol").ViewerConfig} */
export const config = JSON.parse(globalThis.document?.getElementById("pdf-config")?.dataset.config ?? "{}");

const hostApi = globalThis.acquireVsCodeApi?.();

export function toHost(message) {
  hostApi?.postMessage(message);
}

export function reportError(error) {
  toHost({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

/** The host only runs commands listed in WEBVIEW_COMMANDS (src/protocol.ts). */
export function hostCommand(command, ...args) {
  toHost({ type: "command", command, args });
}

export const pdfApp = () => globalThis.PDFViewerApplication;
export const pdfViewer = () => pdfApp()?.pdfViewer;

// --- Preferences -----------------------------------------------------------------
// The host keeps these in VS Code's global state, so they outlive the document and the session.
const prefs = { ...config.preferences };
let prefsSaveTimer = 0;

export const pref = (key, fallback) => prefs[key] ?? fallback;

export function setPref(key, value) {
  prefs[key] = value;
  clearTimeout(prefsSaveTimer);
  prefsSaveTimer = setTimeout(() => toHost({ type: "preferences", preferences: prefs }), 300);
}

export const recentColors = () => pref("recentColors", []);

export function rememberColor(hex) {
  setPref("recentColors", [hex, ...recentColors().filter((c) => c !== hex)].slice(0, 6));
}

// --- Colors, names, dates --------------------------------------------------------
// Up to five presets (the `pdf-editor.presetColors` setting), for marks, notes and drawings. Text and
// Fill & Sign marks get five as well: black and darker shades of the presets, which stay readable
// on a white page (a dark purple reads as black, so it is left out).
const presets = (config.presetColors?.length ? config.presetColors : [
  { name: "Yellow", color: "#FFD60A" },
  { name: "Red", color: "#FF453A" },
  { name: "Purple", color: "#AF52DE" },
  { name: "Green", color: "#30D158" },
  { name: "Blue", color: "#409CFF" },
]).slice(0, 5);

export const PALETTES = {
  markup: presets,
  ink: presets,
  text: [
    { name: "Black", color: "#000000" },
    ...presets
      .filter(({ name }) => !/pink|purple|violet|magenta/iu.test(name))
      .slice(0, 4)
      .map(({ name, color }) => ({ name, color: readableOnWhite(color) })),
  ],
};

export const presetColor = (name, fallback) => presets.find((p) => p.name === name)?.color ?? fallback;

// "#RRGGBB" <-> PDF color components in 0..1 (3 decimals); rgbToHex(undefined) is undefined.
export function hexToRgb(hex) {
  const packed = Number.parseInt(hex.slice(1), 16);
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255].map((n) => Math.round((n / 255) * 1000) / 1000);
}

export function rgbToHex(rgb) {
  return rgb ? `#${rgb.map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}` : undefined;
}

/** A darker shade (same hue and saturation) for text: at most 42% lightness and a 4.5:1 contrast with white. */
export function readableOnWhite(hex) {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  const hue = max === min ? 0 : max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  const fromHsl = (l) => {
    const chroma = (1 - Math.abs(2 * l - 1)) * saturation;
    const x = chroma * (1 - Math.abs((hue % 2) - 1));
    const [r1, g1, b1] = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][Math.floor(hue) % 6];
    return [r1, g1, b1].map((v) => v + l - chroma / 2);
  };
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const contrast = (rgb) => 1.05 / (0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]) + 0.05);
  let l = Math.min(lightness, 0.42);
  while (l > 0 && contrast(fromHsl(l)) < 4.5) {
    l -= 0.01;
  }
  return rgbToHex(fromHsl(Math.max(0, l)));
}

export const KIND_NAMES = {
  note: "Sticky Note",
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "Strikethrough",
  squiggly: "Squiggly",
  freetext: "Text Box",
  ink: "Drawing",
  square: "Rectangle",
  circle: "Oval",
  line: "Line",
  image: "Image",
  other: "Comment",
};

/** Display name of an annotation: its subject when it has one ("Signature", "Checkmark"), else its kind. */
export const nameOf = (a) => a.subject || KIND_NAMES[a.kind] || a.subtype;

/**
 * Review states as shown. "Completed" is the one-click Resolved (it shows as Completed in Acrobat);
 * Completed, Rejected and Cancelled close a thread, which then shows dimmed.
 */
export const STATUSES = {
  Accepted: { label: "Accepted", icon: "thumbsUp" },
  Rejected: { label: "Rejected", icon: "thumbsDown" },
  Cancelled: { label: "Cancelled", icon: "cancelled" },
  Completed: { label: "Resolved", icon: "resolve" },
};
export const isClosed = (status) => status === "Completed" || status === "Rejected" || status === "Cancelled";

export const uuid = () => globalThis.crypto.randomUUID();
export const timestamp = () => new Date().toISOString();

/** Locale-aware short form: "Today 14:05", "Yesterday 09:12", otherwise date and time. */
export function formatDate(iso, today = new Date()) {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const clock = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((midnight(today) - midnight(date)) / 86_400_000);
  if (daysAgo === 0 || daysAgo === 1) {
    return `${daysAgo ? "Yesterday" : "Today"} ${clock}`;
  }
  return `${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} ${clock}`;
}

// --- DOM -------------------------------------------------------------------------

/**
 * `h("div", { className: "x", onclick }, child, "text")`: `on…` props become listeners, `dataset` and `style`
 * are merged in, the rest set as properties or attributes; undefined, null and false props and children are skipped.
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (name === "dataset") {
      Object.assign(node.dataset, value);
    } else if (name === "style") {
      for (const [property, cssValue] of Object.entries(value)) {
        node.style.setProperty(property.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`), cssValue);
      }
    } else if (name.startsWith("on")) {
      node.addEventListener(name.slice(2), value);
    } else if (name in node && name !== "role") {
      node[name] = value;
    } else {
      node.setAttribute(name, value === true ? "" : value);
    }
  }
  node.append(...children.flat().filter((child) => child !== undefined && child !== null && child !== false));
  return node;
}

/** Like `h`, but the content is one of the trusted SVG strings below. */
export function iconNode(tag, svgMarkup, props = {}) {
  return h(tag, { ...props, innerHTML: svgMarkup });
}

export function isTextInput(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName));
}

/** localStorage that fails quietly: a webview may refuse it, and nothing here depends on it. */
export const localStore = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Unavailable: the value is simply forgotten.
    }
  },
};

// --- Icons -----------------------------------------------------------------------
// Inline SVG drawn with currentColor or fixed fills: no image requests, no CSS masks.
const svgIcon = (body, viewBox = "0 0 16 16") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" aria-hidden="true" focusable="false">${body}</svg>`;
const outline = (d, width = 1.3) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** Sticky-note speech balloon filled with `fill`; matches the appearance stream the host writes. */
export function noteSvg(fill) {
  return svgIcon(
    `<path d="M4 1H20C22 1 23 2 23 4V15C23 17 22 18 20 18H11L5 22.5 6.5 18H4C2 18 1 17 1 15V4C1 2 2 1 4 1Z" fill="${fill}" stroke="#333" stroke-width="1" stroke-linejoin="round"/>` +
      `<path d="M5.5 6H18.5M5.5 9.5H18.5M5.5 13H14" stroke="#333" stroke-width="1.4" stroke-linecap="round"/>`,
    "0 0 24 24",
  );
}

export const ICON = {
  note: svgIcon(outline("M2.5 2.5h11v8h-5l-3.5 3v-3h-2.5Z") + outline("M5 5.5h6M5 8h4")),
  freetext: svgIcon(`<rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/>` + outline("M5 5.5h6M8 5.5v5.5")),
  highlight: svgIcon(outline("M9.8 2.2 13.8 6.2 8.4 11.6 4.4 7.6Z") + outline("M4.4 7.6 3 11l2 2 3.4-1.4") + outline("M1.5 14.5h5")),
  underline: svgIcon(outline("M4.5 2.5v4.5a3.5 3.5 0 0 0 7 0V2.5M3 14h10")),
  strikeout: svgIcon(outline("M11.3 3.5C10.7 2.7 9.6 2.2 8 2.2c-2 0-3.3 1-3.3 2.4 0 1 .6 1.7 1.6 2.2M10.5 9.2c.6.4.9 1 .9 1.6 0 1.6-1.4 2.7-3.4 2.7-1.9 0-3.2-.7-3.7-2M2 8h12")),
  // Just a loopy line: drawing a pen here would look too much like the marker.
  ink: svgIcon(outline("M2 11.5C3.5 6 6.5 2.5 8 4s-3.5 7.5-1.5 8.5S11 7 12 8.5s-.5 4 2 4", 1.4)),
  line: svgIcon(outline("M2.5 13.5 13.5 2.5")),
  arrow: svgIcon(outline("M2.5 13.5 13.5 2.5M7.5 2.5h6v6")),
  square: svgIcon(outline("M2.5 3.5h11v9h-11Z")),
  circle: svgIcon(outline("M8 3c3.3 0 6 2.2 6 5s-2.7 5-6 5-6-2.2-6-5 2.7-5 6-5Z")),
  image: svgIcon(outline("M2 3h12v10H2Z") + outline("M2 11l3.5-3.5 3 3 2-2L14 12") + `<circle cx="10.5" cy="5.8" r="1.2" fill="currentColor"/>`),
  comments: svgIcon(outline("M2 2.5h12v8.5H8.5L5 14v-3H2Z") + outline("M10.5 2.5v8.5")),
  more: svgIcon(`<circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/>`),
  close: svgIcon(outline("M4 4l8 8M12 4l-8 8")),
  chevron: svgIcon(outline("M4.5 6.5 8 10l3.5-3.5")),
  check: svgIcon(outline("M2.8 8.6c1 .7 2 1.8 3 3.4 1.6-3.4 3.9-6.1 7.4-8.3", 1.8)),
  cross: svgIcon(outline("M4 4.2c2.6 2.4 5 5.1 8 7.8M12.2 4c-2.9 2.5-5.5 5.2-8.2 8", 1.8)),
  trash: svgIcon(outline("M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9M7 7v4M9 7v4")),
  select: svgIcon(outline("M4 2.5v10l2.8-2.6 1.9 4.1 1.6-.7-1.9-4.1h3.6Z")),
  hand: svgIcon(outline("M5.5 8V3.5a1 1 0 0 1 2 0V7M7.5 6.5V2.8a1 1 0 0 1 2 0V7M9.5 7V3.5a1 1 0 0 1 2 0v5.2M11.5 6a1 1 0 0 1 2 0v3.5c0 2.5-1.8 4.5-4.5 4.5H8c-1.5 0-2.4-.6-3.3-1.7L2.7 9.6a1 1 0 0 1 1.5-1.3L5.5 9.6")),
  // Pen nib above a baseline, so Fill & Sign reads differently from the freehand tool.
  signature: svgIcon(outline("M8 1.5 11.8 5.8 10.2 11H5.8L4.2 5.8Z", 1.2) + outline("M8 7.6V11", 1.1) + `<circle cx="8" cy="6.6" r="1" fill="currentColor"/>` + outline("M2 14.2h12", 1.1)),
  dot: svgIcon(`<circle cx="8" cy="8" r="3.5" fill="currentColor"/>`),
  resolve: svgIcon(`<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/>` + outline("M5.3 8.2l1.9 1.9 3.6-3.9", 1.4)),
  thumbsUp: svgIcon(outline("M5 7.2 7.6 2.5c.9 0 1.6.7 1.5 1.6L8.8 6.5h3.4c.8 0 1.4.8 1.2 1.6l-1 4.2c-.2.6-.7 1-1.3 1H5ZM2.5 7.2H5v6.1H2.5Z", 1.2)),
  thumbsDown: svgIcon(outline("M11 8.8 8.4 13.5c-.9 0-1.6-.7-1.5-1.6l.3-2.4H3.8c-.8 0-1.4-.8-1.2-1.6l1-4.2c.2-.6.7-1 1.3-1H11ZM13.5 8.8H11V2.7h2.5Z", 1.2)),
  cancelled: svgIcon(`<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/>` + outline("M3.6 12.4l8.8-8.8", 1.3)),
  squiggly: svgIcon(outline("M4.5 2.5v4.5a3.5 3.5 0 0 0 7 0V2.5M2 14l1.5-1.2 1.5 1.2 1.5-1.2 1.5 1.2 1.5-1.2 1.5 1.2 1.5-1.2 1.5 1.2")),
  copilot: svgIcon(outline("M7 1.8 8.4 5.6l3.8 1.4-3.8 1.4L7 12.2 5.6 8.4 1.8 7l3.8-1.4Z", 1.2) + outline("M12.5 10.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6Z", 1)),
  copy: svgIcon(outline("M5.5 5.5h8v8h-8Z") + outline("M10.5 5.5v-3h-8v8h3")),
  bold: svgIcon(`<path d="M4.5 2.5h4a2.6 2.6 0 0 1 0 5.2h-4Zm0 5.2h4.8a2.9 2.9 0 0 1 0 5.8H4.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`),
  italic: svgIcon(outline("M7 2.5h5M4 13.5h5M10 2.5l-4 11", 1.5)),
  sup: svgIcon(outline("M2 5l6 7M8 5l-6 7", 1.4) + outline("M10.5 3.8c0-.8.6-1.3 1.4-1.3s1.4.5 1.4 1.2c0 1.2-2.8 1.8-2.8 3.3h2.9", 1.1)),
  sub: svgIcon(outline("M2 3l6 7M8 3l-6 7", 1.4) + outline("M10.5 10.3c0-.8.6-1.3 1.4-1.3s1.4.5 1.4 1.2c0 1.2-2.8 1.8-2.8 3.3h2.9", 1.1)),
  math: svgIcon(outline("M12 3.5H4.5l4 4.5-4 4.5H12")),
  code: svgIcon(outline("M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5", 1.4)),
  // Letters in a row, and letters stacked in a column.
  horizontal: svgIcon(`<text x="8" y="11" text-anchor="middle" font-size="8.5" font-family="sans-serif" font-weight="600" fill="currentColor">Ab</text>`),
  vertical: svgIcon(`<text x="8" y="7" text-anchor="middle" font-size="6.5" font-family="sans-serif" font-weight="600" fill="currentColor">A</text><text x="8" y="14" text-anchor="middle" font-size="6.5" font-family="sans-serif" font-weight="600" fill="currentColor">b</text>`),
  alignLeft: svgIcon(outline("M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7")),
  alignCenter: svgIcon(outline("M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7")),
  alignRight: svgIcon(outline("M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7")),
};

/** A round badge with the status icon, colored by status (see STATUSES). */
export function badgeHtml(status) {
  const { label, icon } = STATUSES[status] ?? STATUSES.Completed;
  return `<span class="pdf-status-badge" data-status="${status}" title="${label}">${ICON[icon]}</span>`;
}
