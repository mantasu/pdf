/**
 * Coordinate math with no DOM access. On-page positions are fractions (0..1) of the page box of a
 * scale-1 pdf.js viewport (rotation included); they do not change with zoom, so overlays need no redraw.
 */

/** Three decimals, the precision stored in the model. */
export const roundPt = (n) => Math.round(n * 1000) / 1000;

export function toFrac(viewport, x, y) {
  const [vx, vy] = viewport.convertToViewportPoint(x, y);
  return [vx / viewport.width, vy / viewport.height];
}

export const fromFrac = (viewport, fx, fy) => viewport.convertToPdfPoint(fx * viewport.width, fy * viewport.height);

/** The `[x1, y1, x2, y2]` box around a flat `x, y, x, y, ...` list. */
export function bbox(points) {
  const xs = points.filter((_, i) => i % 2 === 0);
  const ys = points.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export const inflate = ([x1, y1, x2, y2], d) => [x1 - d, y1 - d, x2 + d, y2 + d];
export const contains = (x, y, [x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2;

/** Every point that shapes an annotation, as one flat list. */
export function outlinePoints(a) {
  if (a.quads?.length) {
    return a.quads;
  }
  if (a.ink?.length) {
    return a.ink.flat();
  }
  return a.line ?? a.rect;
}

/** Combine a text selection's client rects into one box per run of text on a line; slivers are dropped. */
export function mergeLines(rects, gap = 3) {
  const boxes = rects
    .filter((r) => r.width > 0.5 && r.height > 0.5)
    .map((r) => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const runs = [];
  for (const box of boxes) {
    const run = runs.find((candidate) => onSameLine(candidate, box, gap));
    if (run) {
      Object.assign(run, { left: Math.min(run.left, box.left), right: Math.max(run.right, box.right), top: Math.min(run.top, box.top), bottom: Math.max(run.bottom, box.bottom) });
    } else {
      runs.push({ ...box });
    }
  }
  return runs;
}

/** `box` continues `run` when they share at least half the shorter height and are no more than `gap` apart sideways. */
function onSameLine(run, box, gap) {
  const overlap = Math.min(run.bottom, box.bottom) - Math.max(run.top, box.top);
  return overlap >= Math.min(run.bottom - run.top, box.bottom - box.top) * 0.5 && box.left <= run.right + gap && box.right >= run.left - gap;
}

/** On-screen line boxes as QuadPoints in Acrobat's TL, TR, BL, BR order, squared up in PDF space so on a rotated page they still run along the text. */
export function toQuads(lines, box, viewport) {
  const toPdf = (x, y) => fromFrac(viewport, (x - box.left) / box.width, (y - box.top) / box.height);
  return lines.flatMap((line) => {
    const corners = [...toPdf(line.left, line.top), ...toPdf(line.right, line.top), ...toPdf(line.left, line.bottom), ...toPdf(line.right, line.bottom)];
    const [x1, y1, x2, y2] = bbox(corners).map(roundPt);
    return [x1, y2, x2, y2, x1, y1, x2, y1];
  });
}

/** Shortest distance from point P to segment AB (a zero-length segment acts as point A). */
export function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance to the closest segment of a flat `[x, y, ...]` polyline (a single point counts as one). */
export function polylineDistance(px, py, points) {
  let nearest = Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const next = i + 2 < points.length ? i + 2 : i;
    nearest = Math.min(nearest, segmentDistance(px, py, points[i], points[i + 1], points[next], points[next + 1]));
  }
  return nearest;
}

/** Whether the point falls in the bounding box of any quad, grown by `tolerance`. */
export function inQuads(x, y, quads, tolerance = 0) {
  for (let i = 0; i + 8 <= quads.length; i += 8) {
    if (contains(x, y, inflate(bbox(quads.slice(i, i + 8)), tolerance))) {
      return true;
    }
  }
  return false;
}

/** The geometry patch for `a` with every point run through `transform(x, y)`; a sticky note only moves, keeping its icon size. */
export function mapPoints(a, transform) {
  const mapFlat = (flat) => {
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      out.push(...transform(flat[i], flat[i + 1]).map(roundPt));
    }
    return out;
  };
  if (a.kind === "note") {
    const [x, y] = transform(a.rect[0], a.rect[3]);
    const [w, h] = [a.rect[2] - a.rect[0], a.rect[3] - a.rect[1]];
    return { rect: [x, y - h, x + w, y].map(roundPt) };
  }
  if (a.ink) {
    const ink = a.ink.map(mapFlat);
    return { ink, rect: bbox(ink.flat()) };
  }
  if (a.line || a.quads) {
    const key = a.line ? "line" : "quads";
    const points = mapFlat(a[key]);
    return { [key]: points, rect: bbox(points) };
  }
  return { rect: bbox(mapFlat(a.rect)) };
}

export const moveBy = (a, dx, dy) => mapPoints(a, (x, y) => [x + dx, y + dy]);

/** Stretch an annotation's geometry so that box `from` lands on box `to`. */
export function fitBox(a, from, to) {
  const sx = (to[2] - to[0]) / (from[2] - from[0] || 1);
  const sy = (to[3] - to[1]) / (from[3] - from[1] || 1);
  return mapPoints(a, (x, y) => [to[0] + (x - from[0]) * sx, to[1] + (y - from[1]) * sy]);
}

// --- Shapes ------------------------------------------------------------------------

/** Highlight corner radius and overhang past each end, as fractions of the line height (src/pdf/kinds.ts draws the same shape). */
const ROUNDING = 0.22;
const OVERHANG = 0.08;
const KAPPA = 0.5523;

const towards = (from, to, distance) => {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
  return [from[0] + ((to[0] - from[0]) / length) * distance, from[1] + ((to[1] - from[1]) / length) * distance];
};
const lerpPoint = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/**
 * A highlight quad as a closed outline with rounded corners, reaching a little past both ends so the
 * rounding never clips a letter: `[["M", p], ["C", c1, c2, p], ["L", p], ...]` in the quad's coordinates.
 */
export function roundedQuad(tl, tr, br, bl) {
  const height = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
  const overhang = height * OVERHANG;
  const corners = [towards(tl, tr, -overhang), towards(tr, tl, -overhang), towards(br, bl, -overhang), towards(bl, br, -overhang)];
  const radius = Math.min(height * ROUNDING, Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) / 2);
  return corners.flatMap((corner, i) => {
    const start = towards(corner, corners[(i + 3) % 4], radius);
    const end = towards(corner, corners[(i + 1) % 4], radius);
    return [[i ? "L" : "M", start], ["C", lerpPoint(start, corner, KAPPA), lerpPoint(end, corner, KAPPA), end]];
  });
}

/** Points along a cubic Bezier curve, `steps` segments (the first point included). */
function cubic(p0, p1, p2, p3, steps = 8) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]);
  });
}

/** A square of side 2 around the origin with rounded corners, as one closed stroke. */
function roundedSquare(corner = 0.3) {
  const edge = 1 - corner;
  const arcs = [[edge, edge, 0], [-edge, edge, 90], [-edge, -edge, 180], [edge, -edge, 270]].flatMap(([cx, cy, from]) =>
    Array.from({ length: 4 }, (_, i) => {
      const angle = ((from + (i * 90) / 3) * Math.PI) / 180;
      return [cx + corner * Math.cos(angle), cy + corner * Math.sin(angle)];
    }),
  );
  return [...arcs, arcs[0]];
}

const scaled = (points, k) => points.map(([x, y]) => [x * k, y * k]);

/** Fill & Sign shapes per tool and style, on a square of side 2 around the origin (y up); "dot" is drawn as a circle instead. */
const MARK_SHAPES = {
  check: {
    swoosh: () => [[...cubic([-0.82, 0.02], [-0.64, -0.1], [-0.44, -0.34], [-0.3, -0.62], 4), ...cubic([-0.3, -0.62], [0, -0.02], [0.4, 0.5], [0.88, 0.78]).slice(1)]],
    classic: () => [[[-1, 0], [-1 / 3, -0.7], [1, 0.8]]],
    boxed: () => [roundedSquare(), scaled(MARK_SHAPES.check.swoosh()[0], 0.6)],
  },
  cross: {
    swoosh: () => [cubic([-0.74, 0.84], [-0.5, 0.2], [0.3, -0.12], [0.82, -0.8]), cubic([0.8, 0.8], [0.52, 0.22], [-0.24, -0.06], [-0.8, -0.76])],
    classic: () => [[[-1, 1], [1, -1]], [[-1, -1], [1, 1]]],
    boxed: () => [roundedSquare(), ...MARK_SHAPES.cross.classic().map((stroke) => scaled(stroke, 0.5))],
  },
};
export const MARK_STYLES = { check: Object.keys(MARK_SHAPES.check), cross: Object.keys(MARK_SHAPES.cross), dot: ["solid", "ring"] };

/** The pen strokes of a check or cross in `style`, centred on (x, y) with half-size `r`, as flat `[x, y, ...]` lists. */
export function markStrokes(name, style, x, y, r) {
  const shapes = MARK_SHAPES[name];
  const shape = shapes?.[style] ?? Object.values(shapes ?? {})[0];
  return (shape?.() ?? []).map((stroke) => stroke.flatMap(([px, py]) => [roundPt(x + px * r), roundPt(y + py * r)]));
}

/**
 * Letters of upright vertical text in columns of at most `capacity` (src/pdf/kinds.ts stackColumns does the same
 * for the PDF): words stay whole where they fit, longer ones break anywhere, spaces at a break are dropped, and each
 * paragraph (an array of runs `{ text, ... }`) starts a new column. Returns columns of `{ text, run }` letters.
 */
export function stackColumns(paragraphs, capacity) {
  const columns = [];
  const isSpace = (letter) => /\s/u.test(letter.text);
  const close = (column) => {
    while (column.length && isSpace(column.at(-1))) {
      column.pop();
    }
    columns.push(column);
  };
  for (const runs of paragraphs) {
    const words = [[]];
    for (const run of runs) {
      for (const text of run.text) {
        words.at(-1).push({ text, run });
        if (/\s/u.test(text)) {
          words.push([]);
        }
      }
    }
    let column = [];
    for (const word of words) {
      if (column.length && column.length + word.filter((letter) => !isSpace(letter)).length > capacity) {
        close(column);
        column = [];
      }
      for (const letter of word) {
        if (column.length >= capacity) {
          if (isSpace(letter)) {
            continue;
          }
          close(column);
          column = [];
        }
        if (column.length || !isSpace(letter)) {
          column.push(letter);
        }
      }
    }
    close(column);
  }
  return columns;
}
