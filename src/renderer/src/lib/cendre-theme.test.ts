import { BUNDLED_THEMES, COLOR_TOKENS, type ColorToken, ThemeSchema } from "@shared/theme";
import cendreHardJson from "@shared/theme/themes/cendre-hard.json";
import cendreMediumJson from "@shared/theme/themes/cendre-medium.json";
import cendreSoftJson from "@shared/theme/themes/cendre-soft.json";
import { describe, expect, it } from "vitest";
import { getHighlighter } from "./shiki.js";

const CENDRE_JSON = [cendreHardJson, cendreMediumJson, cendreSoftJson] as const;
const CENDRE = CENDRE_JSON.map((theme) => ThemeSchema.parse(theme));
const CENDRE_IDS = ["cendre-hard", "cendre-medium", "cendre-soft"] as const;

const SHARED_PALETTE = [
  "#e6d5c2",
  "#a09384",
  "#73665b",
  "#4e4641",
  "#fcba81",
  "#ea9875",
  "#99af6b",
  "#d1766e",
  "#4e89a2",
  "#d25780",
  "#f4a21c",
  "#43b16a",
  "#20c9cb",
  "#58bdff",
  "#9480ba",
  "#a692cd",
  "#8bcfff",
] as const;

const DEPTH_PALETTES: Record<(typeof CENDRE_IDS)[number], readonly string[]> = {
  "cendre-hard": [
    "#0f0c0a",
    "#171311",
    "#201b19",
    "#2a2422",
    "#362f2c",
    "#463e3a",
    "#5a504c",
    "#2f1e17",
    "#202515",
    "#301d1b",
    "#12262e",
  ],
  "cendre-medium": [
    "#141110",
    "#1d1917",
    "#26211f",
    "#312a28",
    "#3d3633",
    "#4e4541",
    "#625753",
    "#36241d",
    "#262c1b",
    "#372321",
    "#182c35",
  ],
  "cendre-soft": [
    "#1a1716",
    "#231f1d",
    "#2d2725",
    "#37312e",
    "#443c39",
    "#554c48",
    "#695e5a",
    "#3d2b23",
    "#2d3221",
    "#3e2a28",
    "#1f333b",
  ],
};

const DEPTH_COLOR_ROLES = new Set<string>([
  "bg-deep",
  "bg-sunken",
  "bg",
  "surface",
  "surface-2",
  "surface-3",
  "on-accent",
  "shadow",
  "scrim",
  "input-bg",
]);

const SHIKI_RULE_NAMES = [
  "Comment",
  "String",
  "String escape",
  "Regex",
  "Number",
  "Boolean and null",
  "Constant",
  "Keyword",
  "Operator",
  "Punctuation",
  "Function",
  "Macro",
  "Type",
  "Namespace",
  "Variable",
  "Parameter",
  "Property",
  "Builtin variable",
  "Tag",
  "Tag attribute",
  "Decorator",
  "Heading",
  "Markup bold",
  "Markup italic",
  "Markup link",
  "Markup raw",
  "Markup quote",
  "Markup list",
  "Diff added",
  "Diff removed",
  "Diff changed",
  "Invalid",
  "Deprecated",
] as const;

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((index) => {
    const channel = Number.parseInt(value.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

function hexesIn(value: unknown): string[] {
  return (
    JSON.stringify(value)
      .match(/#[0-9a-fA-F]{6}/g)
      ?.map((hex) => hex.toLowerCase()) ?? []
  );
}

function inlineTheme(theme: (typeof CENDRE)[number]): Record<string, unknown> {
  if (!("inline" in theme.syntax)) throw new Error(`${theme.id} must use inline Shiki syntax`);
  return theme.syntax.inline;
}

describe("Cendre bundled themes", () => {
  it("parse, define every semantic role, and are bundled as three dark depths", () => {
    expect(CENDRE.map((theme) => theme.id)).toEqual(CENDRE_IDS);
    for (const theme of CENDRE) {
      expect(theme.appearance).toBe("dark");
      for (const token of COLOR_TOKENS) expect(theme.colors[token], token).toBeTruthy();
    }

    const bundledIds = BUNDLED_THEMES.map((theme) => theme.id);
    for (const id of CENDRE_IDS) expect(bundledIds).toContain(id);
  });

  it("uses only colors published in the original palettes", () => {
    for (const theme of CENDRE) {
      const allowed = new Set([
        ...SHARED_PALETTE,
        ...DEPTH_PALETTES[theme.id as (typeof CENDRE_IDS)[number]],
      ]);
      for (const hex of hexesIn(theme)) {
        expect(allowed.has(hex as (typeof SHARED_PALETTE)[number]), `${theme.id}:${hex}`).toBe(
          true,
        );
      }
    }
  });

  it("assigns ink, pigments, and diagnostics to their intended semantic roles", () => {
    const expectedSharedRoles = {
      "text-ghost": "#4e4641",
      "text-faint": "#73665b",
      "text-disabled": "#73665b",
      "text-muted": "#a09384",
      "text-secondary": "#a09384",
      text: "#e6d5c2",
      accent: "#ea9875",
      "accent-soft": "#fcba81",
      "accent-fill": "#ea9875",
      success: "#43b16a",
      warning: "#f4a21c",
      "warning-soft": "#f4a21c",
      danger: "#d25780",
      info: "#58bdff",
      "info-soft": "#20c9cb",
      cyan: "#4e89a2",
      magenta: "#9480ba",
      cursor: "#ea9875",
    } as const;

    for (const theme of CENDRE) {
      for (const [role, expected] of Object.entries(expectedSharedRoles)) {
        expect(theme.colors[role as ColorToken], `${theme.id}:${role}`).toBe(expected);
      }
    }
  });

  it("moves the ground while keeping ink, pigments, semantics, and Shiki rules fixed", () => {
    const hard = CENDRE[0]!;
    for (const theme of CENDRE.slice(1)) {
      for (const token of COLOR_TOKENS) {
        if (!DEPTH_COLOR_ROLES.has(token)) {
          expect(theme.colors[token], `${theme.id}:${token}`).toBe(hard.colors[token]);
        }
      }
      expect(inlineTheme(theme).tokenColors).toEqual(inlineTheme(hard).tokenColors);
    }
  });

  it("maps the complete ground hierarchy onto distinct app planes", () => {
    const expectedPlanes = [
      ["#0f0c0a", "#171311", "#201b19", "#2a2422", "#362f2c", "#463e3a"],
      ["#141110", "#1d1917", "#26211f", "#312a28", "#3d3633", "#4e4541"],
      ["#1a1716", "#231f1d", "#2d2725", "#37312e", "#443c39", "#554c48"],
    ] as const;
    const planeRoles = ["bg-deep", "bg", "bg-sunken", "surface", "surface-2", "surface-3"] as const;
    const expectedScrims = [
      "rgba(15, 12, 10, 0.7)",
      "rgba(20, 17, 16, 0.7)",
      "rgba(26, 23, 22, 0.7)",
    ] as const;

    CENDRE.forEach((theme, index) => {
      const actual = planeRoles.map((role) => theme.colors[role]);
      expect(actual, theme.id).toEqual(expectedPlanes[index]);
      expect(theme.colors["input-bg"], theme.id).toBe(theme.colors["bg-sunken"]);
      expect(theme.colors.shadow, theme.id).toBe(theme.colors["bg-deep"]);
      // Keep the modal ground depth-specific but translucent: an opaque
      // scrim defeats every overlay's backdrop-filter and blanks the app.
      expect(theme.colors.scrim, theme.id).toBe(expectedScrims[index]);
      expect(theme.colors["on-accent"], theme.id).toBe(theme.colors.bg);

      for (let plane = 1; plane < actual.length; plane++) {
        expect(luminance(actual[plane]!), `${theme.id}:${planeRoles[plane]}`).toBeGreaterThan(
          luminance(actual[plane - 1]!),
        );
      }
      expect(
        contrast(theme.colors.surface, theme.colors["bg-sunken"]),
        `${theme.id}:dropdown/sidebar`,
      ).toBeGreaterThanOrEqual(1.1);
      expect(
        contrast(theme.colors["surface-2"], theme.colors.surface),
        `${theme.id}:hover/dropdown`,
      ).toBeGreaterThanOrEqual(1.15);
      expect(
        contrast(theme.colors["surface-3"], theme.colors["surface-2"]),
        `${theme.id}:strongest/hover`,
      ).toBeGreaterThanOrEqual(1.2);
      for (const role of planeRoles) {
        expect(
          contrast(theme.colors.text, theme.colors[role]),
          `${theme.id}:text/${role}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  it("ships every one of Cendre's 33 TextMate/Shiki rules", () => {
    for (const theme of CENDRE) {
      const tokenColors = inlineTheme(theme).tokenColors as Array<{ name?: string }>;
      expect(
        tokenColors.map((rule) => rule.name),
        theme.id,
      ).toEqual(SHIKI_RULE_NAMES);
    }
  });

  it("loads all depths into Shiki and applies the specified syntax pigments", async () => {
    const highlighter = await getHighlighter();
    for (const id of CENDRE_IDS) {
      expect(highlighter.getLoadedThemes()).toContain(id);
      const result = highlighter.codeToTokens(
        'const value: Ember = load({ enabled: true, label: "fire" }); // quiet',
        { lang: "typescript", theme: id },
      );
      const colors = new Set(result.tokens.flat().map((token) => token.color?.toLowerCase()));
      for (const expected of ["#d1766e", "#fcba81", "#99af6b", "#73665b"]) {
        expect(colors.has(expected), `${id}:${expected}`).toBe(true);
      }
    }
  });
});

describe("Cendre contrast contract", () => {
  const published = [
    { id: "cendre-hard", text: 12.89, comment: 3.32, frost: 4.77 },
    { id: "cendre-medium", text: 12.18, comment: 3.14, frost: 4.51 },
    { id: "cendre-soft", text: 11.41, comment: 2.94, frost: 4.22 },
  ] as const;

  it("matches the published per-depth ratios instead of maximizing contrast", () => {
    for (const expected of published) {
      const theme = CENDRE.find((candidate) => candidate.id === expected.id)!;
      expect(contrast(theme.colors.text, theme.colors.bg)).toBeCloseTo(expected.text, 2);
      expect(contrast("#73665b", theme.colors.bg)).toBeCloseTo(expected.comment, 2);
      expect(contrast("#4e89a2", theme.colors.bg)).toBeCloseTo(expected.frost, 2);
    }
  });

  it("preserves deliberately quiet comments and the documented soft-depth exceptions", () => {
    for (const theme of CENDRE) {
      expect(contrast("#73665b", theme.colors.bg), theme.id).toBeLessThan(4.5);
    }
    const soft = CENDRE[2]!;
    expect(contrast(soft.colors.cyan, soft.colors.bg)).toBeLessThan(4.5);
    expect(contrast(soft.colors.danger, soft.colors.bg)).toBeLessThan(4.5);
  });

  it("keeps ordinary UI text and the accent control pair readable at every depth", () => {
    const readableRoles: ColorToken[] = [
      "text-muted",
      "text-secondary",
      "text",
      "accent",
      "success",
      "warning",
      "warning-soft",
      "info",
      "info-soft",
    ];
    for (const theme of CENDRE) {
      for (const role of readableRoles) {
        expect(
          contrast(theme.colors[role], theme.colors.bg),
          `${theme.id}:${role}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrast(theme.colors["on-accent"]!, theme.colors["accent-fill"]!),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(theme.colors["on-accent"]!, theme.colors["accent-soft"]),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
