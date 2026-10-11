/**
 * Floating UI shared by the whole viewer: menus (context menus, toolbar dropdowns) and popovers,
 * hover tooltips for icon buttons, and placing and dragging cards that point at something on a page.
 */
import { pageView, svg } from "./layers.mjs";
import { h, iconNode } from "./core.mjs";

// --- Menus and popovers ----------------------------------------------------------
// Items: `{ label, action, disabled, checked, swatch, icon, submenu, separator }`. One menu or popover at a time.
let menuLayer = null;
export const menuOpen = () => menuLayer !== null;

export function closeMenu() {
  menuLayer?.remove();
  menuLayer = null;
}

export function openMenu(items, x, y) {
  closeMenu();
  if (items.length === 0) {
    return;
  }
  const menu = renderMenu(items, 0);
  menuLayer = h("div", { className: "pdf-menu-root" }, menu);
  document.body.append(menuLayer);
  keepInWindow(menu, x, y);
  menu.querySelector(".pdf-menu-item:not([disabled])")?.focus({ preventScroll: true });
}

/** Show any content (the style panel, say) in a menu frame that closes like a menu. */
export function openPopover(content, x, y) {
  closeMenu();
  menuLayer = h("div", { className: "pdf-menu-root" }, h("div", { className: "pdf-menu pdf-popover", dataset: { depth: "0" } }, content));
  document.body.append(menuLayer);
  keepInWindow(menuLayer.firstElementChild, x, y);
}

function renderMenu(items, depth) {
  const menu = h("div", { className: "pdf-menu", role: "menu", dataset: { depth: String(depth) } });
  for (const item of items) {
    menu.append(item.separator ? h("div", { className: "pdf-menu-separator", role: "separator" }) : renderItem(item, depth));
  }
  menu.addEventListener("keydown", (event) => onMenuKey(event, menu, depth));
  return menu;
}

function renderItem(item, depth) {
  const button = h(
    "button",
    { type: "button", className: `pdf-menu-item${item.submenu ? " has-submenu" : ""}`, role: "menuitem", disabled: item.disabled, "aria-checked": item.checked === undefined ? undefined : String(item.checked) },
    h("span", { className: "pdf-menu-check", "aria-hidden": "true" }, item.checked ? "✓" : ""),
    item.icon ? iconNode("span", item.icon, { className: "pdf-menu-icon", "aria-hidden": "true" }) : undefined,
    item.swatch ? h("span", { className: "pdf-menu-swatch", "aria-hidden": "true", style: { background: item.swatch } }) : undefined,
    h("span", { className: "pdf-menu-label" }, item.label),
    item.submenu ? h("span", { className: "pdf-menu-arrow", "aria-hidden": "true" }, "›") : undefined,
  );
  if (item.submenu) {
    const expand = () => showSubmenu(button, item.submenu, depth + 1);
    button.addEventListener("pointerenter", expand);
    button.addEventListener("click", expand);
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") {
        expand();
        menuLayer?.querySelector(`.pdf-menu[data-depth="${depth + 1}"] .pdf-menu-item:not([disabled])`)?.focus();
      }
    });
  } else {
    // Hovering a plain item collapses any submenu opened from a sibling.
    button.addEventListener("pointerenter", () => dropSubmenus(depth + 1));
    button.addEventListener("click", () => {
      closeMenu();
      item.action?.();
    });
  }
  return button;
}

function onMenuKey(event, menu, depth) {
  const enabled = [...menu.querySelectorAll(":scope > .pdf-menu-item:not([disabled])")];
  const focused = enabled.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    enabled[(focused + step + enabled.length) % enabled.length]?.focus();
  } else if (event.key === "ArrowLeft" && depth > 0) {
    event.preventDefault();
    dropSubmenus(depth);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  }
}

function dropSubmenus(minDepth) {
  for (const menu of menuLayer?.querySelectorAll(".pdf-menu") ?? []) {
    if (Number(menu.dataset.depth) >= minDepth) {
      menu.remove();
    }
  }
}

function showSubmenu(button, items, depth) {
  dropSubmenus(depth);
  const submenu = renderMenu(items, depth);
  menuLayer.append(submenu);
  const parentItem = button.getBoundingClientRect();
  keepInWindow(submenu, parentItem.right - 2, parentItem.top - 4, parentItem.left + 2);
}

/** Position a menu at (x, y) but inside the window, opening leftwards from `leftEdge` when the right side is too narrow. */
function keepInWindow(menu, x, y, leftEdge = x) {
  const { width, height } = menu.getBoundingClientRect();
  const left = x + width > innerWidth - 4 ? Math.max(4, leftEdge - width) : x;
  const top = Math.max(4, Math.min(y, innerHeight - height - 4));
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
}

// Close on a press outside the menu, and when the window loses focus or is resized.
function closeOnOutsidePress(event) {
  if (menuLayer && !menuLayer.contains(event.target)) {
    closeMenu();
  }
}
document.addEventListener("pointerdown", closeOnOutsidePress, true);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);

// --- Tooltips --------------------------------------------------------------------
// Webviews show `title` tooltips late or never, so icon-only controls here get our own after a hover delay.
const TOOLTIP_AREAS = "#toolbarContainer, .pdf-quickbar, .pdf-actionbar, .pdf-popup, .pdf-menu-root, .pdf-textbox-format";
let tipNode = null;
let tipOwner = null;
let tipTimer = 0;

export function setupTooltips() {
  document.addEventListener("pointerover", onPointerOver, true);
  for (const type of ["pointerdown", "keydown", "scroll", "blur"]) {
    window.addEventListener(type, hideTip, true);
  }
  document.addEventListener("pointerleave", hideTip);
}

function onPointerOver(event) {
  const control = event.target.closest?.("button, label[title], [data-tooltip]");
  if (control === tipOwner) {
    return;
  }
  hideTip();
  // A control showing its own text needs no tooltip; neither do menu items.
  if (!control?.closest(TOOLTIP_AREAS) || control.closest(".pdf-menu-item") || control.textContent.trim()) {
    return;
  }
  const text = control.dataset.tooltip ?? control.getAttribute("aria-label") ?? control.title;
  if (!text) {
    return;
  }
  control.dataset.tooltip = text;
  control.removeAttribute("title");
  tipOwner = control;
  tipTimer = setTimeout(() => showTip(control), 400);
}

/** Center the tip under the control (above it when there is no room below), within the window. */
function showTip(control) {
  const text = control.dataset.tooltip;
  if (!text || !control.isConnected) {
    return;
  }
  tipNode = h("div", { className: "pdf-tooltip", role: "tooltip" }, text);
  document.body.append(tipNode);
  const anchor = control.getBoundingClientRect();
  const { width, height } = tipNode.getBoundingClientRect();
  const left = Math.max(4, Math.min(anchor.left + anchor.width / 2 - width / 2, innerWidth - width - 4));
  const top = anchor.bottom + 6 + height <= innerHeight ? anchor.bottom + 6 : anchor.top - height - 6;
  Object.assign(tipNode.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}

function hideTip() {
  clearTimeout(tipTimer);
  tipNode?.remove();
  tipNode = tipOwner = null;
}

// --- Cards beside the page -------------------------------------------------------
// Comment and Copilot cards sit in the page margin (right, else left) like Acrobat's pop-ups; without one, at a
// viewer edge clear of the target, or in a narrow viewer below or above it. A connector line joins card and target.
const CARD_GAP = 12;

export function makeConnector() {
  const wire = svg("svg", { class: "pdf-connector", "aria-hidden": "true" });
  wire.append(svg("line"), svg("circle", { r: 3 }));
  return wire;
}

/** Place `card` beside `target` (a client rect on page index `page`), shifted by the user's drag `offset`. */
export function placeCard(card, connector, target, page, offset = { x: 0, y: 0 }) {
  const scroller = document.getElementById("viewerContainer");
  const area = scroller?.getBoundingClientRect();
  const onScreen = target && area && target.bottom >= area.top && target.top <= area.bottom;
  card.style.visibility = connector.style.visibility = onScreen ? "" : "hidden";
  if (!onScreen) {
    return;
  }
  const { width, height } = card.getBoundingClientRect();
  const pageBox = pageView(page)?.div.getBoundingClientRect() ?? target;
  // clientWidth leaves the vertical scrollbar out of the usable width.
  const [minX, maxX] = [area.left + CARD_GAP, area.left + scroller.clientWidth - CARD_GAP];
  const fits = (x) => x >= minX && x + width <= maxX;
  const uncovered = (x) => x >= target.right + CARD_GAP || x + width <= target.left - CARD_GAP;
  const sideSlots = [pageBox.right + CARD_GAP + 4, pageBox.left - CARD_GAP - 4 - width, maxX - width, minX];
  let left = sideSlots.find((x) => fits(x) && uncovered(x));
  let top = target.top;
  if (left === undefined) {
    left = Math.max(minX, Math.min(target.left, maxX - width));
    top = target.bottom + CARD_GAP + height <= area.bottom - CARD_GAP ? target.bottom + CARD_GAP : target.top - CARD_GAP - height;
  }
  left = Math.max(minX, Math.min(left + offset.x, maxX - width));
  top = Math.max(area.top + CARD_GAP, Math.min(top + offset.y, area.bottom - height - CARD_GAP));
  Object.assign(card.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
  aimConnector(connector, target, { left, top, width, height });
}

/** Draw the connector: beside the target it ends level with the card's title; above or below, at the card's nearer edge. */
function aimConnector(connector, target, { left, top, width, height }) {
  const headerY = top + 16;
  const sideY = target.top + Math.min(target.height / 2, 10);
  const anchorX = target.left + Math.min(target.width / 2, 20);
  const cardX = Math.max(left + 12, Math.min(anchorX, left + width - 12));
  const [fromX, fromY, toX, toY] =
    left >= target.right ? [target.right, sideY, left, headerY]
    : left + width <= target.left ? [target.left, sideY, left + width, headerY]
    : top >= target.bottom ? [anchorX, target.bottom, cardX, top]
    : [anchorX, target.top, cardX, top + height];
  const [line, dot] = connector.children;
  for (const [name, value] of Object.entries({ x1: fromX, y1: fromY, x2: toX, y2: toY })) {
    line.setAttribute(name, String(Math.round(value)));
  }
  dot.setAttribute("cx", String(Math.round(fromX)));
  dot.setAttribute("cy", String(Math.round(fromY)));
}

/** Drag a card by an element matching `handleSelector` (not its buttons or fields); `onMove(dx, dy)` gets the total offset. */
export function dragBy(event, handleSelector, onMove) {
  const handle = event.target.closest?.(handleSelector);
  if (event.button !== 0 || !handle || event.target.closest("button, input, textarea")) {
    return;
  }
  event.preventDefault();
  const [startX, startY] = [event.clientX, event.clientY];
  handle.setPointerCapture(event.pointerId);
  const follow = (e) => onMove(e.clientX - startX, e.clientY - startY);
  handle.addEventListener("pointermove", follow);
  handle.addEventListener("pointerup", () => handle.removeEventListener("pointermove", follow), { once: true });
}
