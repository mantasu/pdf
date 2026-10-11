/**
 * Annotation tools and their styles. Besides the base tools "select" and "hand", every tool falls
 * back to Select after a single use, as in Acrobat, so the new object can be adjusted at once; "Keep
 * tool selected" turns that off per tool (on by default for the pen). Styles and these
 * choices persist as preferences.
 */
import { PALETTES, hexToRgb, pref, presetColor, setPref } from "./core.mjs";
import { MARK_STYLES } from "./geometry.mjs";

/** The tools that share one toolbar button with a flyout. */
export const TOOL_GROUPS = {
  markup: ["highlight", "underline", "strikeout", "squiggly"],
  draw: ["ink", "line", "arrow", "square", "circle"],
  // Modelled on Acrobat's Fill & Sign, which can add text too; pictures are placed the same way.
  insert: ["freetext", "image", "signature", "check", "cross", "dot"],
};
export const TEXT_MARKS = TOOL_GROUPS.markup;
export const DRAG_TOOLS = ["ink", "line", "arrow", "square", "circle"];

/** Text-box fonts: the PDF standard three, then those in resources/fonts (src/pdf/fonts.ts embeds them). */
export const FONT_FAMILIES = ["Helvetica", "Times", "Courier", "Roboto", "Lora", "Comic Neue"];
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 48];
export const STROKE_WIDTHS = [1, 2, 3, 5, 8];
/** Line widths for underlines and strikethroughs (marks from other apps may have none: theirs follows the text size). */
export const MARK_WIDTHS = [0.5, 1, 2, 3];
export { MARK_STYLES };

const STICKY_BY_DEFAULT = new Set(["ink"]);
const [YELLOW, RED] = [presetColor("Yellow", PALETTES.markup[0].color), presetColor("Red", "#FF453A")];
const STYLE_DEFAULTS = {
  note: { color: YELLOW },
  freetext: { color: "#000000", font: { family: "Helvetica", size: 12 } },
  // Text marks at 70%: highlights are multiplied into the page as a lighter wash that keeps the text crisp.
  highlight: { color: YELLOW, opacity: 0.7 },
  underline: { color: RED, width: 1, opacity: 0.7 },
  strikeout: { color: RED, width: 1, opacity: 0.7 },
  squiggly: { color: RED, width: 1, opacity: 0.7 },
  ink: { color: RED, width: 2, opacity: 1 },
  line: { color: RED, width: 2 },
  arrow: { color: RED, width: 2 },
  square: { color: RED, width: 2 },
  circle: { color: RED, width: 2 },
  signature: { color: "#000000", width: 2 },
  check: { color: "#000000", width: 2, style: "swoosh" },
  cross: { color: "#000000", width: 2, style: "swoosh" },
  dot: { color: "#000000", width: 1.5, style: "solid" },
};
// The stored preference holds only the user's overrides, so later changes to the defaults still apply.
const storedStyles = pref("styles", {});
// Version 2 changed the text-mark defaults (all 70%, lines red, widths without 1.5 pt): earlier saved choices for
// them are dropped once, so the new defaults show.
if (pref("stylesVersion", 1) < 2) {
  for (const name of TOOL_GROUPS.markup) {
    delete storedStyles[name];
  }
  setPref("styles", { ...storedStyles });
  setPref("stylesVersion", 2);
}
// The old built-in Pink preset became Purple: a tool that still remembers it takes the new color.
for (const style of Object.values(storedStyles)) {
  if (style?.color === "#FF66C4") {
    style.color = presetColor("Purple", style.color);
  }
}
// Bold and italic once were box-wide settings; they now belong to the text, so an old stored choice is dropped.
if (storedStyles.freetext?.font) {
  const { bold: _bold, italic: _italic, ...font } = storedStyles.freetext.font;
  storedStyles.freetext = { ...storedStyles.freetext, font };
}
const currentStyles = Object.fromEntries(Object.entries(STYLE_DEFAULTS).map(([name, style]) => [name, { ...style, ...storedStyles[name] }]));

/** The color palette offered for a tool or an annotation kind. */
export const paletteFor = (name) => (["freetext", "signature", "check", "cross", "dot"].includes(name) ? PALETTES.text : TEXT_MARKS.includes(name) || name === "note" ? PALETTES.markup : PALETTES.ink);

const toolWatchers = new Set();
let active = "select";
/** Per group, the tool its toolbar button shows: the one used last. */
const shownInGroup = { markup: "highlight", draw: "ink", insert: "freetext" };
// Stored choices of tools that are gone (the eraser) are dropped.
for (const [group, name] of Object.entries(pref("lastOfGroup", {}))) {
  if (TOOL_GROUPS[group]?.includes(name)) {
    shownInGroup[group] = name;
  }
}

/** The tool whose style the color button shows when nothing is selected and no styled tool is on. */
let lastStyled = pref("lastStyled", "highlight");

export const activeTool = () => active;
export const lastStyledTool = () => lastStyled;
export const toolStyle = (name) => currentStyles[name];
export const lastInGroup = (group) => shownInGroup[group];
export const groupOf = (name) => Object.keys(TOOL_GROUPS).find((group) => TOOL_GROUPS[group].includes(name));
export const isSticky = (name) => pref("keepTool", {})[name] ?? STICKY_BY_DEFAULT.has(name);

export function onToolChange(callback) {
  toolWatchers.add(callback);
}

const announce = () => toolWatchers.forEach((callback) => callback(active));

/** Activate a tool; picking the tool that is already active switches back to Select. */
export function chooseTool(name) {
  active = active === name && name !== "select" ? "select" : name;
  if (currentStyles[name] && lastStyled !== name) {
    lastStyled = name;
    setPref("lastStyled", name);
  }
  const group = groupOf(name);
  if (group && shownInGroup[group] !== name) {
    shownInGroup[group] = name;
    setPref("lastOfGroup", { ...shownInGroup });
  }
  announce();
}

export function backToSelect() {
  if (active !== "select") {
    active = "select";
    announce();
  }
}

/** Called once the active tool made something. */
export function afterUse() {
  if (!isSticky(active)) {
    backToSelect();
  }
}

export function setSticky(name, sticky) {
  setPref("keepTool", { ...pref("keepTool", {}), [name]: sticky });
  announce();
}

const overridesOf = (name) =>
  Object.fromEntries(Object.entries(currentStyles[name]).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(STYLE_DEFAULTS[name][key])));

export function setToolStyle(name, change) {
  currentStyles[name] = { ...currentStyles[name], ...change };
  setPref("styles", Object.fromEntries(Object.keys(currentStyles).map((key) => [key, overridesOf(key)]).filter(([, diff]) => Object.keys(diff).length)));
  announce();
}

const SUBTYPE_OF = { note: "Text", freetext: "FreeText", highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly", ink: "Ink", line: "Line", square: "Square", circle: "Circle" };
/** Fill & Sign marks are plain drawings that carry Acrobat's subject names: tool -> [kind, subject]. */
const SIGN_MARKS = { check: ["ink", "Checkmark"], cross: ["ink", "Cross"], dot: ["circle", "Dot"], signature: ["ink", "Signature"] };

/** The model fields of an annotation made with `name`, in its current style (a mark's `style` shapes it when placed, see pointer.mjs). */
export function fieldsFor(name) {
  const { color, width, opacity, font, fill, style, align, vertical } = currentStyles[name];
  const [kind, subject] = SIGN_MARKS[name] ?? [name === "arrow" ? "line" : name];
  return {
    kind,
    subtype: SUBTYPE_OF[kind],
    color: hexToRgb(color),
    ...(width !== undefined && { width }),
    ...(opacity !== undefined && { opacity }),
    ...(font && { font: { ...font } }),
    ...(align && { align }),
    ...(vertical && { vertical }),
    ...(subject && { subject }),
    ...(fill && { fill }),
    ...(name === "dot" && style !== "ring" && { fill: hexToRgb(color) }),
    ...(name === "arrow" && { arrow: true }),
    ...(name === "note" && { icon: "Comment" }),
  };
}
