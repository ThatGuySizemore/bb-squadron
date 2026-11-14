// Pixel material for the board: a 5x7 cell font for spec numbers and the
// Bayer 4x4 ordered-dither masks the CSS textures are cut from. Canvas dither
// lives in dither.ts.

const G = (rows: string[]) => rows;

/** 5x7 glyphs; "#" is an inked cell. Narrow glyphs are allowed. */
export const GLYPHS: Record<string, string[]> = {
  A: G([" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"]),
  B: G(["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "]),
  C: G([" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "]),
  D: G(["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "]),
  E: G(["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"]),
  F: G(["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "]),
  G: G([" ### ", "#   #", "#    ", "# ###", "#   #", "#   #", " ####"]),
  H: G(["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"]),
  I: G(["###", " # ", " # ", " # ", " # ", " # ", "###"]),
  J: G(["  ###", "   # ", "   # ", "   # ", "   # ", "#  # ", " ##  "]),
  K: G(["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"]),
  L: G(["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"]),
  M: G(["#   #", "## ##", "# # #", "# # #", "#   #", "#   #", "#   #"]),
  N: G(["#   #", "#   #", "##  #", "# # #", "#  ##", "#   #", "#   #"]),
  O: G([" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "]),
  P: G(["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "]),
  Q: G([" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"]),
  R: G(["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"]),
  S: G([" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "]),
  T: G(["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "]),
  U: G(["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "]),
  V: G(["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "]),
  W: G(["#   #", "#   #", "#   #", "# # #", "# # #", "# # #", " # # "]),
  X: G(["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"]),
  Y: G(["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "]),
  Z: G(["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"]),
  "0": G([" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "]),
  "1": G([" # ", "## ", " # ", " # ", " # ", " # ", "###"]),
  "2": G([" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"]),
  "3": G(["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "]),
  "4": G(["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "]),
  "5": G(["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "]),
  "6": G(["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "]),
  "7": G(["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "]),
  "8": G([" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "]),
  "9": G([" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "]),
  "-": G(["   ", "   ", "   ", "###", "   ", "   ", "   "]),
  " ": G(["  ", "  ", "  ", "  ", "  ", "  ", "  "]),
};

export interface PixelRun {
  /** Cell coordinates of every inked cell. */
  cells: Array<[x: number, y: number]>;
  width: number;
  height: number;
}

/** Lays text out on the cell grid, one empty column between glyphs. */
export function layoutPixels(text: string): PixelRun {
  const cells: Array<[number, number]> = [];
  let x = 0;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "]!;
    const w = glyph[0]!.length;
    glyph.forEach((row, y) => {
      for (let i = 0; i < w; i++) if (row[i] === "#") cells.push([x + i, y]);
    });
    x += w + 1;
  }
  return { cells, width: Math.max(0, x - 1), height: 7 };
}

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** An 8px tile (4x4 cells of 2px) with `level` of 16 cells inked. */
function ditherTile(level: number): string {
  const rects: string[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      if (BAYER4[y]![x]! < level) rects.push(`<rect x='${x * 2}' y='${y * 2}' width='2' height='2'/>`);
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8' shape-rendering='crispEdges'>${rects.join("")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** CSS custom properties --sq-d0 … --sq-d16, set once on the board root. */
export const DITHER_VARS: Record<string, string> = Object.fromEntries(
  Array.from({ length: 17 }, (_, level) => [`--sq-d${level}`, ditherTile(level)]),
);
