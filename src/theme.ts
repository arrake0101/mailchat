import type {
  CommunityThemePresetId,
  CustomThemePalette,
  ThemeConfig,
  ThemeDensity,
  ThemeFontScale,
  ThemeMode,
  ThemePresetId,
} from "./types";

export const THEME_CACHE_KEY = "mailchat.theme_cache";

export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  mode: "light",
  preset: "mist",
  density: "comfortable",
  font_scale: "normal",
  custom_themes: [],
};

export interface SurfacePalette {
  canvasOuter: string;
  surfaceList: string;
  surfaceMain: string;
  surfaceCard: string;
  surfaceElevated: string;
  surfaceSubtle: string;
  surfaceHover: string;
  surfaceActive: string;
  ink: string;
  inkSecondary: string;
  inkMuted: string;
  bubbleIn: string;
  hairline: string;
}

export interface ThemePresetMeta {
  id: ThemePresetId | CommunityThemePresetId | string;
  label: string;
  desc: string;
  swatch: [string, string, string];
  lightAccent: string;
  darkAccent: string;
  light: SurfacePalette;
  dark: SurfacePalette;
}

export interface CommunityThemeMeta extends ThemePresetMeta {
  id: CommunityThemePresetId;
  author: string;
  defaultMode: "light" | "dark";
}

export const THEME_MODES: Array<{ id: ThemeMode; label: string; desc: string }> = [
  { id: "light", label: "浅色", desc: "明亮通透" },
  { id: "dark", label: "深色", desc: "柔和沉浸" },
  { id: "system", label: "跟随系统", desc: "自动切换" },
];

const NEUTRAL_LIGHT_SURFACE: SurfacePalette = {
  canvasOuter: "#eef2f7",
  surfaceList: "#f7f9fc",
  surfaceMain: "#ffffff",
  surfaceCard: "#ffffff",
  surfaceElevated: "#ffffff",
  surfaceSubtle: "#f2f5f9",
  surfaceHover: "rgba(15, 23, 42, 0.045)",
  surfaceActive: "#ffffff",
  ink: "#0f172a",
  inkSecondary: "#475569",
  inkMuted: "#8c98ab",
  bubbleIn: "#f3f5f9",
  hairline: "rgba(15, 23, 42, 0.075)",
};

const NEUTRAL_DARK_SURFACE: SurfacePalette = {
  canvasOuter: "#0e1116",
  surfaceList: "#141820",
  surfaceMain: "#181d26",
  surfaceCard: "#1e2430",
  surfaceElevated: "#242b38",
  surfaceSubtle: "#202632",
  surfaceHover: "rgba(148, 163, 184, 0.085)",
  surfaceActive: "#242b38",
  ink: "#eaeff7",
  inkSecondary: "#a2afc2",
  inkMuted: "#6f7d92",
  bubbleIn: "#212836",
  hairline: "rgba(148, 163, 184, 0.13)",
};

/** 官方内置主题模板（每套模板均内置浅色/深色配套底色阶与专属主题强调色） */
export const THEME_PRESETS: ThemePresetMeta[] = [
  {
    id: "mist",
    label: "清透雾蓝",
    desc: "通透雾感 · 皇家蓝主色",
    swatch: ["#eef2f7", "#f7f9fc", "#3563e9"],
    lightAccent: "#3563e9",
    darkAccent: "#5b85ff",
    light: NEUTRAL_LIGHT_SURFACE,
    dark: {
      canvasOuter: "#0b111d",
      surfaceList: "#101827",
      surfaceMain: "#141e30",
      surfaceCard: "#19253a",
      surfaceElevated: "#1e2c45",
      surfaceSubtle: "#1b273d",
      surfaceHover: "rgba(148, 163, 184, 0.09)",
      surfaceActive: "#1e2c45",
      ink: "#e6edf7",
      inkSecondary: "#9fb0c7",
      inkMuted: "#6c7f99",
      bubbleIn: "#1c2940",
      hairline: "rgba(148, 163, 184, 0.14)",
    },
  },
  {
    id: "paper",
    label: "暖杏纸感",
    desc: "护眼羊皮纸 · 暖琥珀主色",
    swatch: ["#efe9de", "#f7f3eb", "#c2621c"],
    lightAccent: "#c2621c",
    darkAccent: "#f59e0b",
    light: {
      canvasOuter: "#efe8dc",
      surfaceList: "#f7f2e8",
      surfaceMain: "#fcf9f2",
      surfaceCard: "#fffdf8",
      surfaceElevated: "#fffefb",
      surfaceSubtle: "#f1eadc",
      surfaceHover: "rgba(67, 48, 24, 0.05)",
      surfaceActive: "#fffdf8",
      ink: "#27211a",
      inkSecondary: "#61564a",
      inkMuted: "#9c8f80",
      bubbleIn: "#f3ede2",
      hairline: "rgba(67, 48, 24, 0.09)",
    },
    dark: {
      canvasOuter: "#141210",
      surfaceList: "#1b1815",
      surfaceMain: "#211d19",
      surfaceCard: "#28231e",
      surfaceElevated: "#302a24",
      surfaceSubtle: "#2a2520",
      surfaceHover: "rgba(231, 218, 200, 0.08)",
      surfaceActive: "#302a24",
      ink: "#f1ebe2",
      inkSecondary: "#b8ada0",
      inkMuted: "#84796c",
      bubbleIn: "#2b2620",
      hairline: "rgba(231, 218, 200, 0.13)",
    },
  },
  {
    id: "graphite",
    label: "极简石墨",
    desc: "纯粹灰阶 · 曜石黑主色",
    swatch: ["#ebebee", "#f6f6f8", "#27272a"],
    lightAccent: "#27272a",
    darkAccent: "#d4d4d8",
    light: {
      canvasOuter: "#eaeaee",
      surfaceList: "#f4f4f6",
      surfaceMain: "#fafafa",
      surfaceCard: "#ffffff",
      surfaceElevated: "#ffffff",
      surfaceSubtle: "#ededf0",
      surfaceHover: "rgba(24, 24, 27, 0.05)",
      surfaceActive: "#ffffff",
      ink: "#18181b",
      inkSecondary: "#52525b",
      inkMuted: "#8e95a2",
      bubbleIn: "#f0f0f3",
      hairline: "rgba(24, 24, 27, 0.085)",
    },
    dark: {
      canvasOuter: "#0c0c0e",
      surfaceList: "#131316",
      surfaceMain: "#18181c",
      surfaceCard: "#1f1f24",
      surfaceElevated: "#26262c",
      surfaceSubtle: "#222228",
      surfaceHover: "rgba(244, 244, 245, 0.075)",
      surfaceActive: "#26262c",
      ink: "#f4f4f5",
      inkSecondary: "#a1a1aa",
      inkMuted: "#71717a",
      bubbleIn: "#232329",
      hairline: "rgba(244, 244, 245, 0.12)",
    },
  },
  {
    id: "forest",
    label: "松石青雾",
    desc: "自然松叶 · 松石青主色",
    swatch: ["#e3efec", "#eef6f4", "#0d9488"],
    lightAccent: "#0d9488",
    darkAccent: "#2dd4bf",
    light: {
      canvasOuter: "#e3efec",
      surfaceList: "#eef6f4",
      surfaceMain: "#f8fcfa",
      surfaceCard: "#ffffff",
      surfaceElevated: "#ffffff",
      surfaceSubtle: "#e7f2ef",
      surfaceHover: "rgba(15, 46, 38, 0.05)",
      surfaceActive: "#ffffff",
      ink: "#11241f",
      inkSecondary: "#456159",
      inkMuted: "#7f9a92",
      bubbleIn: "#ebf4f1",
      hairline: "rgba(15, 46, 38, 0.085)",
    },
    dark: {
      canvasOuter: "#091311",
      surfaceList: "#0f1d1a",
      surfaceMain: "#132420",
      surfaceCard: "#182d28",
      surfaceElevated: "#1e3731",
      surfaceSubtle: "#1a302b",
      surfaceHover: "rgba(167, 216, 202, 0.08)",
      surfaceActive: "#1e3731",
      ink: "#e6f4f0",
      inkSecondary: "#9ec0b7",
      inkMuted: "#688c82",
      bubbleIn: "#1b322d",
      hairline: "rgba(167, 216, 202, 0.13)",
    },
  },
  {
    id: "midnight",
    label: "深空暗夜",
    desc: "冷冽星夜 · 靛青紫主色",
    swatch: ["#0d111f", "#151c31", "#6366f1"],
    lightAccent: "#4f46e5",
    darkAccent: "#818cf8",
    light: {
      canvasOuter: "#e6eaf5",
      surfaceList: "#f0f3fb",
      surfaceMain: "#f8faff",
      surfaceCard: "#ffffff",
      surfaceElevated: "#ffffff",
      surfaceSubtle: "#eaeff9",
      surfaceHover: "rgba(17, 24, 56, 0.05)",
      surfaceActive: "#ffffff",
      ink: "#0f152c",
      inkSecondary: "#465073",
      inkMuted: "#8690b2",
      bubbleIn: "#edf1fb",
      hairline: "rgba(17, 24, 56, 0.085)",
    },
    dark: {
      canvasOuter: "#070a14",
      surfaceList: "#0d1222",
      surfaceMain: "#11172b",
      surfaceCard: "#171f38",
      surfaceElevated: "#1d2746",
      surfaceSubtle: "#19223d",
      surfaceHover: "rgba(165, 180, 252, 0.085)",
      surfaceActive: "#1d2746",
      ink: "#eef2ff",
      inkSecondary: "#a3b1d6",
      inkMuted: "#6d7ba3",
      bubbleIn: "#1a2340",
      hairline: "rgba(165, 180, 252, 0.14)",
    },
  },
];

/** 精选开源社区经典主题模板库（一键加载即同步套用配套底色与主题强调色） */
export const COMMUNITY_PRESETS: CommunityThemeMeta[] = [
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    desc: "暖奶拿铁 · 薰衣草紫主色",
    author: "Catppuccin",
    defaultMode: "light",
    lightAccent: "#8839ef",
    darkAccent: "#cba6f7",
    swatch: ["#dce0e8", "#e6e9ef", "#8839ef"],
    light: {
      canvasOuter: "#dce0e8",
      surfaceList: "#e6e9ef",
      surfaceMain: "#eff1f5",
      surfaceCard: "#f9fafd",
      surfaceElevated: "#ffffff",
      surfaceSubtle: "#e2e6ee",
      surfaceHover: "rgba(76, 79, 105, 0.06)",
      surfaceActive: "#ffffff",
      ink: "#4c4f69",
      inkSecondary: "#5c5f77",
      inkMuted: "#8c8fa1",
      bubbleIn: "#e6e9ef",
      hairline: "rgba(76, 79, 105, 0.1)",
    },
    dark: {
      canvasOuter: "#11111b",
      surfaceList: "#181825",
      surfaceMain: "#1e1e2e",
      surfaceCard: "#26273a",
      surfaceElevated: "#313244",
      surfaceSubtle: "#292a3c",
      surfaceHover: "rgba(205, 214, 244, 0.08)",
      surfaceActive: "#313244",
      ink: "#cdd6f4",
      inkSecondary: "#a6adc8",
      inkMuted: "#6c7086",
      bubbleIn: "#2a2b3d",
      hairline: "rgba(205, 214, 244, 0.12)",
    },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    desc: "摩卡暗夜 · 温润粉紫主色",
    author: "Catppuccin",
    defaultMode: "dark",
    lightAccent: "#8839ef",
    darkAccent: "#cba6f7",
    swatch: ["#11111b", "#1e1e2e", "#cba6f7"],
    light: {
      canvasOuter: "#dce0e8",
      surfaceList: "#e6e9ef",
      surfaceMain: "#eff1f5",
      surfaceCard: "#f9fafd",
      surfaceElevated: "#ffffff",
      surfaceSubtle: "#e2e5ec",
      surfaceHover: "rgba(76, 79, 105, 0.055)",
      surfaceActive: "#ffffff",
      ink: "#4c4f69",
      inkSecondary: "#5c5f77",
      inkMuted: "#8c8fa1",
      bubbleIn: "#e6e9ef",
      hairline: "rgba(76, 79, 105, 0.095)",
    },
    dark: {
      canvasOuter: "#11111b",
      surfaceList: "#181825",
      surfaceMain: "#1e1e2e",
      surfaceCard: "#26273a",
      surfaceElevated: "#313244",
      surfaceSubtle: "#292a3c",
      surfaceHover: "rgba(205, 214, 244, 0.08)",
      surfaceActive: "#313244",
      ink: "#cdd6f4",
      inkSecondary: "#bac2de",
      inkMuted: "#7f849c",
      bubbleIn: "#2a2b3d",
      hairline: "rgba(205, 214, 244, 0.12)",
    },
  },
  {
    id: "nord",
    label: "Nord",
    desc: "极地冰川 · 北欧冰蓝主色",
    author: "Arctic Ice Studio",
    defaultMode: "dark",
    lightAccent: "#5e81ac",
    darkAccent: "#88c0d0",
    swatch: ["#242933", "#2e3440", "#88c0d0"],
    light: {
      canvasOuter: "#d8dee9",
      surfaceList: "#e5e9f0",
      surfaceMain: "#eceff4",
      surfaceCard: "#f8fafc",
      surfaceElevated: "#ffffff",
      surfaceSubtle: "#dfe5ee",
      surfaceHover: "rgba(46, 52, 64, 0.055)",
      surfaceActive: "#ffffff",
      ink: "#2e3440",
      inkSecondary: "#4c566a",
      inkMuted: "#7b88a1",
      bubbleIn: "#e5e9f0",
      hairline: "rgba(46, 52, 64, 0.09)",
    },
    dark: {
      canvasOuter: "#242933",
      surfaceList: "#292e39",
      surfaceMain: "#2e3440",
      surfaceCard: "#3b4252",
      surfaceElevated: "#434c5e",
      surfaceSubtle: "#353c4a",
      surfaceHover: "rgba(216, 222, 233, 0.08)",
      surfaceActive: "#434c5e",
      ink: "#eceff4",
      inkSecondary: "#d8dee9",
      inkMuted: "#81a1c1",
      bubbleIn: "#3b4252",
      hairline: "rgba(216, 222, 233, 0.12)",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    desc: "东京暗夜 · 霓虹蓝紫主色",
    author: "enkia",
    defaultMode: "dark",
    lightAccent: "#2e7de9",
    darkAccent: "#7aa2f7",
    swatch: ["#16161e", "#1a1b26", "#7aa2f7"],
    light: {
      canvasOuter: "#d5d6db",
      surfaceList: "#e1e2e7",
      surfaceMain: "#edf0f5",
      surfaceCard: "#f7f8fb",
      surfaceElevated: "#ffffff",
      surfaceSubtle: "#dfe1e8",
      surfaceHover: "rgba(52, 59, 88, 0.055)",
      surfaceActive: "#ffffff",
      ink: "#343b58",
      inkSecondary: "#565f89",
      inkMuted: "#8990b3",
      bubbleIn: "#e1e2e7",
      hairline: "rgba(52, 59, 88, 0.09)",
    },
    dark: {
      canvasOuter: "#13141c",
      surfaceList: "#16161e",
      surfaceMain: "#1a1b26",
      surfaceCard: "#24283b",
      surfaceElevated: "#292e42",
      surfaceSubtle: "#1f2335",
      surfaceHover: "rgba(192, 202, 245, 0.08)",
      surfaceActive: "#292e42",
      ink: "#c0caf5",
      inkSecondary: "#a9b1d6",
      inkMuted: "#565f89",
      bubbleIn: "#24283b",
      hairline: "rgba(192, 202, 245, 0.12)",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    desc: "德古拉 · 经典暗紫主色",
    author: "Zeno Rocha",
    defaultMode: "dark",
    lightAccent: "#7c3aed",
    darkAccent: "#bd93f9",
    swatch: ["#191a21", "#282a36", "#bd93f9"],
    light: {
      canvasOuter: "#e9e7f2",
      surfaceList: "#f3f1f9",
      surfaceMain: "#fbfaff",
      surfaceCard: "#ffffff",
      surfaceElevated: "#ffffff",
      surfaceSubtle: "#ece9f6",
      surfaceHover: "rgba(40, 42, 54, 0.05)",
      surfaceActive: "#ffffff",
      ink: "#282a36",
      inkSecondary: "#44475a",
      inkMuted: "#7c7f99",
      bubbleIn: "#efecf8",
      hairline: "rgba(40, 42, 54, 0.085)",
    },
    dark: {
      canvasOuter: "#191a21",
      surfaceList: "#21222c",
      surfaceMain: "#282a36",
      surfaceCard: "#313444",
      surfaceElevated: "#3a3d52",
      surfaceSubtle: "#2d303e",
      surfaceHover: "rgba(248, 248, 242, 0.08)",
      surfaceActive: "#44475a",
      ink: "#f8f8f2",
      inkSecondary: "#cfd2e6",
      inkMuted: "#6272a4",
      bubbleIn: "#343746",
      hairline: "rgba(248, 248, 242, 0.12)",
    },
  },
  {
    id: "solarized",
    label: "Solarized",
    desc: "科学护眼 · 暖米湖蓝主色",
    author: "Ethan Schoonover",
    defaultMode: "light",
    lightAccent: "#268bd2",
    darkAccent: "#2aa198",
    swatch: ["#eee8d5", "#fdf6e3", "#268bd2"],
    light: {
      canvasOuter: "#e8e1cc",
      surfaceList: "#eee8d5",
      surfaceMain: "#fdf6e3",
      surfaceCard: "#fffbf0",
      surfaceElevated: "#ffffff",
      surfaceSubtle: "#eee8d5",
      surfaceHover: "rgba(7, 54, 66, 0.055)",
      surfaceActive: "#fffdf7",
      ink: "#073642",
      inkSecondary: "#586e75",
      inkMuted: "#93a1a1",
      bubbleIn: "#eee8d5",
      hairline: "rgba(7, 54, 66, 0.095)",
    },
    dark: {
      canvasOuter: "#001e26",
      surfaceList: "#002630",
      surfaceMain: "#002b36",
      surfaceCard: "#073642",
      surfaceElevated: "#0d4352",
      surfaceSubtle: "#05323e",
      surfaceHover: "rgba(147, 161, 161, 0.09)",
      surfaceActive: "#0d4352",
      ink: "#eee8d5",
      inkSecondary: "#93a1a1",
      inkMuted: "#657b83",
      bubbleIn: "#073642",
      hairline: "rgba(147, 161, 161, 0.14)",
    },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    desc: "玫瑰松木 · 侘寂玫瑰主色",
    author: "Rosé Pine",
    defaultMode: "dark",
    lightAccent: "#b4637a",
    darkAccent: "#ebbcba",
    swatch: ["#191724", "#232136", "#ebbcba"],
    light: {
      canvasOuter: "#f2e9e1",
      surfaceList: "#faf4ed",
      surfaceMain: "#fffaf3",
      surfaceCard: "#fffdf9",
      surfaceElevated: "#ffffff",
      surfaceSubtle: "#f2e9e1",
      surfaceHover: "rgba(87, 82, 121, 0.055)",
      surfaceActive: "#ffffff",
      ink: "#575279",
      inkSecondary: "#797593",
      inkMuted: "#9893a5",
      bubbleIn: "#f2e9e1",
      hairline: "rgba(87, 82, 121, 0.09)",
    },
    dark: {
      canvasOuter: "#191724",
      surfaceList: "#1f1d2e",
      surfaceMain: "#232136",
      surfaceCard: "#2a273f",
      surfaceElevated: "#393552",
      surfaceSubtle: "#26233a",
      surfaceHover: "rgba(224, 222, 244, 0.08)",
      surfaceActive: "#393552",
      ink: "#e0def4",
      inkSecondary: "#908caa",
      inkMuted: "#6e6a86",
      bubbleIn: "#2a273f",
      hairline: "rgba(224, 222, 244, 0.12)",
    },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    desc: "复古胶片 · 暖棕金黄主色",
    author: "morhetz",
    defaultMode: "dark",
    lightAccent: "#b57614",
    darkAccent: "#d79921",
    swatch: ["#1d2021", "#282828", "#d79921"],
    light: {
      canvasOuter: "#ebdbb2",
      surfaceList: "#f2e5bc",
      surfaceMain: "#fbf1c7",
      surfaceCard: "#fdf6dc",
      surfaceElevated: "#fffbeb",
      surfaceSubtle: "#ebdbb2",
      surfaceHover: "rgba(60, 56, 54, 0.06)",
      surfaceActive: "#fffbeb",
      ink: "#3c3836",
      inkSecondary: "#504945",
      inkMuted: "#7c6f64",
      bubbleIn: "#ebdbb2",
      hairline: "rgba(60, 56, 54, 0.1)",
    },
    dark: {
      canvasOuter: "#1d2021",
      surfaceList: "#242424",
      surfaceMain: "#282828",
      surfaceCard: "#32302f",
      surfaceElevated: "#3c3836",
      surfaceSubtle: "#2e2c2b",
      surfaceHover: "rgba(235, 219, 178, 0.08)",
      surfaceActive: "#3c3836",
      ink: "#ebdbb2",
      inkSecondary: "#d5c4a1",
      inkMuted: "#928374",
      bubbleIn: "#32302f",
      hairline: "rgba(235, 219, 178, 0.13)",
    },
  },
];

export const THEME_DENSITIES: Array<{ id: ThemeDensity; label: string; desc: string }> = [
  { id: "comfortable", label: "舒适标准", desc: "舒展留白" },
  { id: "compact", label: "紧凑高效", desc: "高信息密度" },
];

export const THEME_FONT_SCALES: Array<{ id: ThemeFontScale; label: string; desc: string }> = [
  { id: "small", label: "小号", desc: "12.5px" },
  { id: "normal", label: "标准", desc: "13.5px" },
  { id: "large", label: "大号", desc: "14.8px" },
];

export function normalizeHexColor(raw?: string | null): string | null {
  if (!raw) return null;
  const clean = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const expanded = clean
      .toLowerCase()
      .split("")
      .map((c) => c + c)
      .join("");
    return `#${expanded}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `#${clean.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{8}$/.test(clean)) {
    return `#${clean.slice(0, 6).toLowerCase()}`;
  }
  return null;
}

export function sanitizeThemeId(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  if (slug) return slug;
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash * 33) ^ raw.charCodeAt(i)) >>> 0;
  }
  return `theme-${(hash & 0xffffff).toString(16).padStart(6, "0")}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = normalizeHexColor(hex)?.slice(1) || "3563e9";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [r, g, b];
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) => clampByte(v).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  weightB: number,
): [number, number, number] {
  const w = Math.max(0, Math.min(1, weightB));
  return [
    a[0] * (1 - w) + b[0] * w,
    a[1] * (1 - w) + b[1] * w,
    a[2] * (1 - w) + b[2] * w,
  ];
}

function mixHex(hexA: string, hexB: string, weightB: number): string {
  const [r, g, b] = mixRgb(hexToRgb(hexA), hexToRgb(hexB), weightB);
  return rgbToHex(r, g, b);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLinear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function normalizeCustomPalette(raw?: Partial<CustomThemePalette> | null): CustomThemePalette | null {
  if (!raw) return null;
  const surface = normalizeHexColor(raw.surface) ?? normalizeHexColor(raw.canvas);
  if (!surface) return null;
  const canvas = normalizeHexColor(raw.canvas) ?? surface;
  const sidebar = normalizeHexColor(raw.sidebar) ?? canvas;
  const card = normalizeHexColor(raw.card) ?? "";
  const modeClean = (raw.base_mode || "").trim().toLowerCase();
  const base_mode: "light" | "dark" =
    modeClean === "dark" || modeClean === "night" || modeClean === "hcdark" || modeClean === "hc-dark"
      ? "dark"
      : modeClean === "light" || modeClean === "day" || modeClean === "hclight" || modeClean === "hc-light"
        ? "light"
        : relativeLuminance(hexToRgb(surface)) < 0.22
          ? "dark"
          : "light";
  const ink =
    normalizeHexColor(raw.ink) ?? (base_mode === "dark" ? "#e6edf7" : "#0f172a");
  const ink_muted = normalizeHexColor(raw.ink_muted) ?? "";
  const defaultAccent = base_mode === "dark" ? "#5b85ff" : "#3563e9";
  const accent = normalizeHexColor(raw.accent) ?? defaultAccent;
  const rawName = (raw.name || "").trim();
  const rawId = (raw.id || "").trim();
  const id = sanitizeThemeId(rawId || rawName || surface);
  const name = (rawName || id).slice(0, 48);
  const author = (raw.author || "").trim().slice(0, 40);

  return {
    id,
    name,
    author: author || undefined,
    base_mode,
    canvas,
    sidebar,
    surface,
    card: card || undefined,
    ink,
    ink_muted: ink_muted || undefined,
    accent,
  };
}

function normalizeBuiltinOrCommunityPreset(raw: string): string | null {
  const p = raw.trim().toLowerCase();
  if (p === "mist" || p === "default") return "mist";
  if (p === "paper" || p === "warm" || p === "cream") return "paper";
  if (p === "graphite" || p === "mono" || p === "zinc" || p === "minimal") return "graphite";
  if (p === "forest" || p === "sage" || p === "mint") return "forest";
  if (p === "midnight" || p === "obsidian" || p === "abyss") return "midnight";
  if (p === "nord") return "nord";
  if (p === "catppuccin-latte" || p === "catppuccin_latte" || p === "latte") return "catppuccin-latte";
  if (p === "catppuccin-mocha" || p === "catppuccin_mocha" || p === "catppuccin" || p === "mocha")
    return "catppuccin-mocha";
  if (p === "tokyo-night" || p === "tokyo_night" || p === "tokyonight") return "tokyo-night";
  if (p === "dracula") return "dracula";
  if (p === "solarized" || p === "solarized-light" || p === "solarized-dark") return "solarized";
  if (p === "rose-pine" || p === "rose_pine" || p === "rosepine") return "rose-pine";
  if (p === "gruvbox" || p === "gruvbox-dark" || p === "gruvbox-light") return "gruvbox";
  return null;
}

export function normalizeThemeConfig(raw?: Partial<ThemeConfig> | null): ThemeConfig {
  const modeRaw = (raw?.mode || "").trim().toLowerCase();
  const mode: ThemeMode =
    modeRaw === "dark" || modeRaw === "night"
      ? "dark"
      : modeRaw === "system" || modeRaw === "auto" || modeRaw === "os"
        ? "system"
        : "light";

  const custom_themes: CustomThemePalette[] = [];
  if (Array.isArray(raw?.custom_themes)) {
    for (const item of raw.custom_themes) {
      const norm = normalizeCustomPalette(item);
      if (!norm) continue;
      const idx = custom_themes.findIndex((x) => x.id === norm.id);
      if (idx >= 0) {
        custom_themes[idx] = norm;
      } else if (custom_themes.length < 32) {
        custom_themes.push(norm);
      }
    }
  }

  const presetRaw = (raw?.preset || "").trim();
  const presetSlug = sanitizeThemeId(presetRaw);
  let preset = "mist";
  const matchedCustom = custom_themes.find(
    (ct) =>
      ct.id.toLowerCase() === presetRaw.toLowerCase() ||
      ct.id.toLowerCase() === presetSlug ||
      ct.name.toLowerCase() === presetRaw.toLowerCase(),
  );
  if (matchedCustom) {
    preset = matchedCustom.id;
  } else {
    preset = normalizeBuiltinOrCommunityPreset(presetRaw) ?? "mist";
  }

  const denRaw = (raw?.density || "").trim().toLowerCase();
  const density: ThemeDensity =
    denRaw === "compact" || denRaw === "dense" || denRaw === "tight" ? "compact" : "comfortable";

  const fsRaw = (raw?.font_scale || "").trim().toLowerCase();
  const font_scale: ThemeFontScale =
    fsRaw === "small" || fsRaw === "sm"
      ? "small"
      : fsRaw === "large" || fsRaw === "lg" || fsRaw === "big" || fsRaw === "xl"
        ? "large"
        : "normal";

  return {
    mode,
    preset,
    density,
    font_scale,
    custom_themes: custom_themes.length > 0 ? custom_themes : undefined,
  };
}

export function buildSurfaceFromCustomPalette(
  ct: CustomThemePalette,
  resolvedMode: "light" | "dark",
): SurfacePalette {
  const norm = normalizeCustomPalette(ct);
  if (!norm) {
    return resolvedMode === "dark" ? NEUTRAL_DARK_SURFACE : NEUTRAL_LIGHT_SURFACE;
  }

  // 若用户当前亮暗模式与外部主题模板原本的 base_mode 相反，自动生成和谐的伴生色阶，防止深色文字落入深底
  if (norm.base_mode !== resolvedMode) {
    if (resolvedMode === "light") {
      const tint = norm.accent || norm.surface;
      return {
        canvasOuter: mixHex("#ebeef4", tint, 0.1),
        surfaceList: mixHex("#f4f6fa", tint, 0.065),
        surfaceMain: mixHex("#fbfcfe", tint, 0.03),
        surfaceCard: "#ffffff",
        surfaceElevated: "#ffffff",
        surfaceSubtle: mixHex("#eef1f7", tint, 0.075),
        surfaceHover: "rgba(15, 23, 42, 0.048)",
        surfaceActive: "#ffffff",
        ink: "#0f172a",
        inkSecondary: "#475569",
        inkMuted: "#8c98ab",
        bubbleIn: mixHex("#eff2f8", tint, 0.06),
        hairline: "rgba(15, 23, 42, 0.085)",
      };
    }
    const tint = norm.accent || norm.canvas;
    return {
      canvasOuter: mixHex("#0d1017", tint, 0.12),
      surfaceList: mixHex("#131822", tint, 0.11),
      surfaceMain: mixHex("#171d29", tint, 0.09),
      surfaceCard: mixHex("#1e2534", tint, 0.09),
      surfaceElevated: mixHex("#252d3f", tint, 0.09),
      surfaceSubtle: mixHex("#202737", tint, 0.09),
      surfaceHover: "rgba(226, 232, 240, 0.08)",
      surfaceActive: mixHex("#262f42", tint, 0.1),
      ink: "#e6edf7",
      inkSecondary: "#a3b1c6",
      inkMuted: "#6f7f96",
      bubbleIn: mixHex("#21293a", tint, 0.09),
      hairline: "rgba(226, 232, 240, 0.13)",
    };
  }

  const inkRgb = hexToRgb(norm.ink);
  if (resolvedMode === "dark") {
    const surfaceCard = norm.card || mixHex(norm.surface, "#ffffff", 0.055);
    const surfaceElevated = mixHex(surfaceCard, "#ffffff", 0.06);
    const surfaceSubtle = mixHex(norm.surface, "#ffffff", 0.038);
    const inkSecondary = norm.ink_muted
      ? mixHex(norm.ink, norm.ink_muted, 0.55)
      : mixHex(norm.ink, norm.surface, 0.28);
    const inkMuted = norm.ink_muted || mixHex(norm.ink, norm.surface, 0.5);
    return {
      canvasOuter: norm.canvas,
      surfaceList: norm.sidebar,
      surfaceMain: norm.surface,
      surfaceCard,
      surfaceElevated,
      surfaceSubtle,
      surfaceHover: `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.08)`,
      surfaceActive: surfaceElevated,
      ink: norm.ink,
      inkSecondary,
      inkMuted,
      bubbleIn: mixHex(norm.surface, "#ffffff", 0.065),
      hairline: `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.125)`,
    };
  }

  const surfaceCard = norm.card || mixHex(norm.surface, "#ffffff", 0.65);
  const surfaceElevated = mixHex(surfaceCard, "#ffffff", 0.72);
  const surfaceSubtle = mixHex(norm.sidebar, norm.ink, 0.045);
  const inkSecondary = norm.ink_muted
    ? mixHex(norm.ink, norm.ink_muted, 0.5)
    : mixHex(norm.ink, norm.surface, 0.34);
  const inkMuted = norm.ink_muted || mixHex(norm.ink, norm.surface, 0.56);
  return {
    canvasOuter: norm.canvas,
    surfaceList: norm.sidebar,
    surfaceMain: norm.surface,
    surfaceCard,
    surfaceElevated,
    surfaceSubtle,
    surfaceHover: `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.05)`,
    surfaceActive: surfaceElevated,
    ink: norm.ink,
    inkSecondary,
    inkMuted,
    bubbleIn: mixHex(norm.sidebar, "#ffffff", 0.25),
    hairline: `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.095)`,
  };
}

/** 根据当前激活的主题模板，同时解析完整底色阶与该模板自带的主题强调色（无需用户手动选主题色） */
export function resolveActiveThemeTemplate(
  rawTheme: Partial<ThemeConfig> | null | undefined,
  resolvedMode: "light" | "dark",
): {
  surface: SurfacePalette;
  accentHex: string;
  activeLabel: string;
  templateKind: "builtin" | "community" | "custom";
} {
  const norm = normalizeThemeConfig(rawTheme);

  const customFound = norm.custom_themes?.find((ct) => ct.id === norm.preset);
  if (customFound) {
    const surface = buildSurfaceFromCustomPalette(customFound, resolvedMode);
    const accentHex =
      normalizeHexColor(customFound.accent) ??
      (resolvedMode === "dark" ? "#5b85ff" : "#3563e9");
    return {
      surface,
      accentHex,
      activeLabel: customFound.name,
      templateKind: "custom",
    };
  }

  const commFound = COMMUNITY_PRESETS.find((c) => c.id === norm.preset);
  if (commFound) {
    const surface = resolvedMode === "dark" ? commFound.dark : commFound.light;
    const accentHex = resolvedMode === "dark" ? commFound.darkAccent : commFound.lightAccent;
    return {
      surface,
      accentHex,
      activeLabel: commFound.label,
      templateKind: "community",
    };
  }

  const presetMeta = THEME_PRESETS.find((p) => p.id === norm.preset) || THEME_PRESETS[0];
  const surface = resolvedMode === "dark" ? presetMeta.dark : presetMeta.light;
  const accentHex = resolvedMode === "dark" ? presetMeta.darkAccent : presetMeta.lightAccent;
  return {
    surface,
    accentHex,
    activeLabel: presetMeta.label,
    templateKind: "builtin",
  };
}

function computeAccentTokens(rawAccentHex: string, resolvedMode: "light" | "dark") {
  const cleanHex =
    normalizeHexColor(rawAccentHex) ?? (resolvedMode === "dark" ? "#5b85ff" : "#3563e9");
  const rawRgb = hexToRgb(cleanHex);
  const rawLum = relativeLuminance(rawRgb);

  let baseHex: string;
  if (resolvedMode === "dark" && rawLum < 0.14) {
    const lifted = mixRgb(rawRgb, [255, 255, 255], 0.32);
    baseHex = rgbToHex(lifted[0], lifted[1], lifted[2]);
  } else if (resolvedMode === "light" && rawLum > 0.68) {
    const darkened = mixRgb(rawRgb, [15, 23, 42], 0.28);
    baseHex = rgbToHex(darkened[0], darkened[1], darkened[2]);
  } else {
    baseHex = cleanHex;
  }

  const rgb = hexToRgb(baseHex);
  const lum = relativeLuminance(rgb);

  const hoverRgb =
    resolvedMode === "dark"
      ? mixRgb(rgb, [255, 255, 255], 0.14)
      : mixRgb(rgb, [0, 0, 0], 0.13);
  const hoverHex = rgbToHex(hoverRgb[0], hoverRgb[1], hoverRgb[2]);

  const inkRgb =
    resolvedMode === "dark"
      ? mixRgb(rgb, [255, 255, 255], 0.26)
      : mixRgb(rgb, [15, 23, 42], 0.22);
  const accentInk = rgbToHex(inkRgb[0], inkRgb[1], inkRgb[2]);

  const softAlpha = resolvedMode === "dark" ? 0.16 : 0.1;
  const accentSoft = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${softAlpha})`;
  const accentBorder = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${resolvedMode === "dark" ? 0.34 : 0.24})`;
  const accentRing = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${resolvedMode === "dark" ? 0.2 : 0.12})`;

  let bubbleOut: string;
  let bubbleOutInk: string;
  let bubbleOutBorder: string;
  if (resolvedMode === "dark") {
    bubbleOut = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.2)`;
    const lightInkRgb = mixRgb(rgb, [255, 255, 255], 0.82);
    bubbleOutInk = rgbToHex(lightInkRgb[0], lightInkRgb[1], lightInkRgb[2]);
    bubbleOutBorder = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.28)`;
  } else {
    const softTint = mixRgb(rgb, [255, 255, 255], 0.88);
    bubbleOut = rgbToHex(softTint[0], softTint[1], softTint[2]);
    const deepInk = mixRgb(rgb, [15, 23, 42], 0.76);
    bubbleOutInk = rgbToHex(deepInk[0], deepInk[1], deepInk[2]);
    bubbleOutBorder = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.18)`;
  }

  const onAccentInk = lum > 0.44 ? "#0f172a" : "#ffffff";
  const shadowPill =
    resolvedMode === "dark"
      ? "0 3px 10px rgba(0, 0, 0, 0.34)"
      : "0 2px 8px rgba(15, 23, 42, 0.055)";

  return {
    accent: baseHex,
    accentHover: hoverHex,
    accentSoft,
    accentBorder,
    accentRing,
    accentInk,
    onAccentInk,
    bubbleOut,
    bubbleOutInk,
    bubbleOutBorder,
    shadowPill,
  };
}

export function resolveEffectiveMode(mode: string): "light" | "dark" {
  const clean = mode.trim().toLowerCase();
  if (clean === "dark") return "dark";
  if (clean === "system") {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  }
  return "light";
}

export function applyThemeToDom(rawTheme?: Partial<ThemeConfig> | null): ThemeConfig {
  const norm = normalizeThemeConfig(rawTheme);
  if (typeof document === "undefined") {
    return norm;
  }

  const resolvedMode = resolveEffectiveMode(norm.mode);
  const { surface, accentHex } = resolveActiveThemeTemplate(norm, resolvedMode);
  const accentTokens = computeAccentTokens(accentHex, resolvedMode);

  const root = document.documentElement;
  root.dataset.themeMode = norm.mode;
  root.dataset.themeResolved = resolvedMode;
  root.dataset.themePreset = norm.preset;
  root.dataset.themeDensity = norm.density;
  root.dataset.themeFont = norm.font_scale;
  root.style.colorScheme = resolvedMode;

  root.style.setProperty("--canvas-outer", surface.canvasOuter);
  root.style.setProperty("--surface-list", surface.surfaceList);
  root.style.setProperty("--surface-main", surface.surfaceMain);
  root.style.setProperty("--surface-card", surface.surfaceCard);
  root.style.setProperty("--surface-elevated", surface.surfaceElevated);
  root.style.setProperty("--surface-popover", surface.surfaceElevated);
  root.style.setProperty("--surface-subtle", surface.surfaceSubtle);
  root.style.setProperty("--surface-hover", surface.surfaceHover);
  root.style.setProperty("--surface-active", surface.surfaceActive);
  root.style.setProperty("--ink", surface.ink);
  root.style.setProperty("--ink-secondary", surface.inkSecondary);
  root.style.setProperty("--ink-muted", surface.inkMuted);
  root.style.setProperty("--bubble-in", surface.bubbleIn);
  root.style.setProperty("--hairline", surface.hairline);

  const cardRgb = hexToRgb(surface.surfaceCard);
  root.style.setProperty(
    "--surface-glass",
    `rgba(${cardRgb[0]}, ${cardRgb[1]}, ${cardRgb[2]}, ${resolvedMode === "dark" ? 0.78 : 0.72})`,
  );

  root.style.setProperty("--accent", accentTokens.accent);
  root.style.setProperty("--accent-hover", accentTokens.accentHover);
  root.style.setProperty("--accent-soft", accentTokens.accentSoft);
  root.style.setProperty("--accent-border", accentTokens.accentBorder);
  root.style.setProperty("--accent-ring", accentTokens.accentRing);
  root.style.setProperty("--accent-ink", accentTokens.accentInk);
  root.style.setProperty("--on-accent-ink", accentTokens.onAccentInk);
  root.style.setProperty("--bubble-out", accentTokens.bubbleOut);
  root.style.setProperty("--bubble-out-ink", accentTokens.bubbleOutInk);
  root.style.setProperty("--bubble-out-border", accentTokens.bubbleOutBorder);
  root.style.setProperty("--shadow-pill", accentTokens.shadowPill);

  // 语义状态色独立自适应，不与主题强调色混淆
  if (resolvedMode === "dark") {
    root.style.setProperty("--ok", "#2dd4bf");
    root.style.setProperty("--ok-soft", "rgba(45, 212, 191, 0.15)");
    root.style.setProperty("--warn", "#fbbf24");
    root.style.setProperty("--warn-soft", "rgba(251, 191, 36, 0.15)");
    root.style.setProperty("--danger", "#f87171");
    root.style.setProperty("--danger-soft", "rgba(248, 113, 113, 0.16)");
    root.style.setProperty(
      "--shadow-card",
      "0 2px 6px rgba(0, 0, 0, 0.28), 0 12px 32px rgba(0, 0, 0, 0.36)",
    );
    root.style.setProperty(
      "--shadow-float",
      "0 18px 48px rgba(0, 0, 0, 0.55), 0 4px 14px rgba(0, 0, 0, 0.35)",
    );
  } else {
    root.style.setProperty("--ok", "#0d9488");
    root.style.setProperty("--ok-soft", "rgba(13, 148, 136, 0.11)");
    root.style.setProperty("--warn", "#d97706");
    root.style.setProperty("--warn-soft", "rgba(217, 119, 6, 0.12)");
    root.style.setProperty("--danger", "#dc2626");
    root.style.setProperty("--danger-soft", "rgba(220, 38, 38, 0.1)");
    root.style.setProperty(
      "--shadow-card",
      "0 1px 2px rgba(15, 23, 42, 0.03), 0 6px 20px rgba(15, 23, 42, 0.04)",
    );
    root.style.setProperty(
      "--shadow-float",
      "0 16px 40px rgba(15, 23, 42, 0.1), 0 2px 8px rgba(15, 23, 42, 0.04)",
    );
  }

  try {
    window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(norm));
  } catch {
    // ignore storage errors
  }

  return norm;
}

export function applyCachedThemeEarly(): ThemeConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const cached = window.localStorage.getItem(THEME_CACHE_KEY);
    if (!cached) return null;
    const parsed = JSON.parse(cached) as Partial<ThemeConfig>;
    return applyThemeToDom(parsed);
  } catch {
    return null;
  }
}

/* ============================================================================
   通用外部主题模板加载器与模板导出器
   支持：MailChat 主题模板 (.toml / .json) · VS Code color-theme.json · Shadcn/Web CSS 变量 (:root) · Base16 / 色板列表
   ============================================================================ */

function hslToHex(hRaw: number, sPct: number, lPct: number): string {
  const h = ((hRaw % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, sPct)) / 100;
  const l = Math.max(0, Math.min(100, lPct)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return rgbToHex((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
}

function parseCssColorValue(raw?: string | null): string | null {
  if (!raw) return null;
  const val = raw.trim().replace(/;$/, "").trim();
  const directHex = normalizeHexColor(val);
  if (directHex) return directHex;

  // hsl(222.2 84% 4.9%) 或 hsl(222, 84%, 5%) 或 Shadcn 裸三元组 `222.2 84% 4.9%`
  const hslMatch = val.match(
    /^(?:hsla?\(\s*)?(-?\d+(?:\.\d+)?)\s*(?:deg)?[\s,]+(\d+(?:\.\d+)?)%\s*[\s,]+(\d+(?:\.\d+)?)%/i,
  );
  if (hslMatch) {
    return hslToHex(Number(hslMatch[1]), Number(hslMatch[2]), Number(hslMatch[3]));
  }

  const rgbMatch = val.match(
    /^rgba?\(\s*(\d{1,3})\s*[\s,]+\s*(\d{1,3})\s*[\s,]+\s*(\d{1,3})/i,
  );
  if (rgbMatch) {
    return rgbToHex(Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3]));
  }

  return null;
}

function stripJsonCommentsAndTrailingCommas(src: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += ch;
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

export type ParsedExternalThemeResult =
  | {
      ok: true;
      palette: CustomThemePalette;
      density?: ThemeDensity;
      font_scale?: ThemeFontScale;
      formatLabel: string;
    }
  | { ok: false; error: string };

function parseOptionalDensity(raw?: unknown): ThemeDensity | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "compact" || v === "dense" || v === "tight") return "compact";
  if (v === "comfortable" || v === "normal") return "comfortable";
  return undefined;
}

function parseOptionalFontScale(raw?: unknown): ThemeFontScale | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "small" || v === "sm") return "small";
  if (v === "large" || v === "lg" || v === "xl") return "large";
  if (v === "normal" || v === "md") return "normal";
  return undefined;
}

export function parseExternalThemeInput(
  rawText: string,
  fileNameHint?: string,
): ParsedExternalThemeResult {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { ok: false, error: "请先选择主题模板文件或粘贴模板代码" };
  }

  const hintTitle = fileNameHint
    ? fileNameHint
        .replace(/\.(mailchat-theme\.)?(jsonc?|toml|css|ya?ml|txt)$/i, "")
        .replace(/[-_]+/g, " ")
        .trim()
    : "";

  // 1. 尝试 JSON / JSONC（兼容 MailChat 主题模板 JSON、VS Code *-color-theme.json、Base16 JSON）
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const cleanedJson = stripJsonCommentsAndTrailingCommas(trimmed.slice(firstBrace, lastBrace + 1));
      const obj = JSON.parse(cleanedJson) as Record<string, unknown>;
      const pickHex = (rec: Record<string, unknown>, keys: string[]): string | undefined => {
        for (const k of keys) {
          const v = rec[k];
          if (typeof v === "string") {
            const parsed = parseCssColorValue(v);
            if (parsed) return parsed;
          }
        }
        return undefined;
      };

      if (obj.colors && typeof obj.colors === "object" && obj.colors !== null) {
        const colors = obj.colors as Record<string, unknown>;
        const surface = pickHex(colors, [
          "editor.background",
          "panel.background",
          "sideBar.background",
        ]);
        if (surface) {
          const canvas =
            pickHex(colors, [
              "activityBar.background",
              "titleBar.activeBackground",
              "sideBar.background",
            ]) ?? surface;
          const sidebar =
            pickHex(colors, ["sideBar.background", "editorGroupHeader.tabsBackground"]) ?? canvas;
          const card = pickHex(colors, [
            "editorWidget.background",
            "dropdown.background",
            "input.background",
          ]);
          const ink = pickHex(colors, ["editor.foreground", "foreground", "sideBar.foreground"]);
          const ink_muted = pickHex(colors, [
            "descriptionForeground",
            "editorLineNumber.foreground",
          ]);
          const accent = pickHex(colors, [
            "button.background",
            "focusBorder",
            "textLink.foreground",
            "activityBarBadge.background",
          ]);
          const name =
            (typeof obj.name === "string" && obj.name.trim()) || hintTitle || "VS Code 主题模板";
          const norm = normalizeCustomPalette({
            name,
            author: typeof obj.author === "string" ? obj.author : undefined,
            base_mode: typeof obj.type === "string" ? obj.type : undefined,
            canvas,
            sidebar,
            surface,
            card,
            ink: ink || "",
            ink_muted,
            accent,
          });
          if (norm) {
            return { ok: true, palette: norm, formatLabel: "VS Code 主题模板" };
          }
        }
      }

      // 兼容 `{ template: { ... } }` 或 `{ palette: { ... } }` 或顶层扁平模板
      const targetRec =
        obj.template && typeof obj.template === "object" && obj.template !== null
          ? (obj.template as Record<string, unknown>)
          : obj.palette && typeof obj.palette === "object" && obj.palette !== null
            ? (obj.palette as Record<string, unknown>)
            : obj;
      const surface = pickHex(targetRec, [
        "surface",
        "surfaceMain",
        "background",
        "bg",
        "editor_bg",
        "base00",
      ]);
      if (surface) {
        const canvas =
          pickHex(targetRec, ["canvas", "canvasOuter", "frame", "outer", "base01"]) ?? surface;
        const sidebar =
          pickHex(targetRec, ["sidebar", "surfaceList", "list", "panel", "base01"]) ?? canvas;
        const card = pickHex(targetRec, ["card", "surfaceCard", "elevated", "base02"]);
        const ink = pickHex(targetRec, ["ink", "foreground", "fg", "text", "base05"]);
        const ink_muted = pickHex(targetRec, [
          "ink_muted",
          "inkMuted",
          "muted",
          "subtext",
          "base04",
        ]);
        const accent = pickHex(targetRec, [
          "accent",
          "primary",
          "brand",
          "cursor",
          "base0D",
          "blue",
        ]);
        const name =
          (typeof targetRec.name === "string" && targetRec.name.trim()) ||
          (typeof obj.name === "string" && obj.name.trim()) ||
          (typeof targetRec.scheme === "string" && targetRec.scheme.trim()) ||
          hintTitle ||
          "导入主题模板";
        const baseMode =
          (typeof targetRec.base_mode === "string" && targetRec.base_mode) ||
          (typeof targetRec.mode === "string" && targetRec.mode) ||
          (typeof targetRec.type === "string" && targetRec.type) ||
          (typeof obj.mode === "string" && obj.mode) ||
          "";
        const norm = normalizeCustomPalette({
          id: typeof targetRec.id === "string" ? targetRec.id : undefined,
          name,
          author:
            (typeof targetRec.author === "string" && targetRec.author) ||
            (typeof obj.author === "string" ? obj.author : undefined),
          base_mode: baseMode,
          canvas,
          sidebar,
          surface,
          card,
          ink: ink || "",
          ink_muted,
          accent,
        });
        if (norm) {
          const isMailchatTpl =
            typeof obj.schema === "string" && obj.schema.startsWith("mailchat-theme");
          return {
            ok: true,
            palette: norm,
            density: parseOptionalDensity(targetRec.density ?? obj.density),
            font_scale: parseOptionalFontScale(targetRec.font_scale ?? obj.font_scale),
            formatLabel: isMailchatTpl ? "MailChat 主题模板" : "JSON 主题模板",
          };
        }
      }
    } catch {
      // 继续尝试 CSS / TOML / 色值列表解析
    }
  }

  // 2. 尝试 CSS 变量模板（支持 MailChat / Shadcn / Tailwind `:root` 或 `.dark` 的 Hex 与 HSL 变量）
  const cssVarRegex = /--([a-zA-Z0-9_-]+)\s*:\s*([^;\n}]+)/g;
  const cssVars = new Map<string, string>();
  let mCss: RegExpExecArray | null = cssVarRegex.exec(trimmed);
  while (mCss) {
    const color = parseCssColorValue(mCss[2]);
    if (color) {
      cssVars.set(mCss[1].toLowerCase(), color);
    }
    mCss = cssVarRegex.exec(trimmed);
  }
  if (cssVars.size >= 2) {
    const pickCss = (keys: string[]) => {
      for (const k of keys) {
        const hit = cssVars.get(k);
        if (hit) return hit;
      }
      return undefined;
    };
    const surface = pickCss(["surface-main", "surface", "background", "bg"]);
    if (surface) {
      const canvas =
        pickCss(["canvas-outer", "canvas", "sidebar-background", "muted"]) ?? surface;
      const sidebar = pickCss(["surface-list", "sidebar", "card"]) ?? canvas;
      const card = pickCss(["surface-card", "card", "popover"]);
      const ink = pickCss(["ink", "foreground", "fg", "text"]);
      const ink_muted = pickCss(["ink-muted", "muted-foreground"]);
      const accent = pickCss(["accent", "primary", "brand", "ring"]);
      const norm = normalizeCustomPalette({
        name: hintTitle || "CSS 主题模板",
        canvas,
        sidebar,
        surface,
        card,
        ink: ink || "",
        ink_muted,
        accent,
      });
      if (norm) {
        return { ok: true, palette: norm, formatLabel: "CSS 主题模板" };
      }
    }
  }

  // 3. 尝试 MailChat TOML 主题模板 / Base16 配置
  const kvRegex = /^\s*([a-zA-Z0-9_.-]+)\s*[=:]\s*["']?([^"'\n#]+)["']?/gm;
  const kvMap = new Map<string, string>();
  let mKv: RegExpExecArray | null = kvRegex.exec(trimmed);
  while (mKv) {
    kvMap.set(mKv[1].trim().toLowerCase(), mKv[2].trim());
    mKv = kvRegex.exec(trimmed);
  }
  if (kvMap.size >= 3) {
    const pickKvColor = (keys: string[]) => {
      for (const k of keys) {
        const rawV = kvMap.get(k);
        const parsed = parseCssColorValue(rawV);
        if (parsed) return parsed;
      }
      return undefined;
    };
    const surface = pickKvColor(["surface", "background", "bg", "base00"]);
    if (surface) {
      const canvas = pickKvColor(["canvas", "outer", "frame", "base01"]) ?? surface;
      const sidebar = pickKvColor(["sidebar", "list", "panel", "base01"]) ?? canvas;
      const card = pickKvColor(["card", "base02"]);
      const ink = pickKvColor(["ink", "foreground", "fg", "text", "base05"]);
      const ink_muted = pickKvColor(["ink_muted", "muted", "base04"]);
      const accent = pickKvColor(["accent", "primary", "cursor", "blue", "base0d"]);
      const name = kvMap.get("name") || kvMap.get("scheme") || hintTitle || "TOML 主题模板";
      const norm = normalizeCustomPalette({
        id: kvMap.get("id"),
        name,
        author: kvMap.get("author"),
        base_mode: kvMap.get("base_mode") || kvMap.get("mode") || "",
        canvas,
        sidebar,
        surface,
        card,
        ink: ink || "",
        ink_muted,
        accent,
      });
      if (norm) {
        return {
          ok: true,
          palette: norm,
          density: parseOptionalDensity(kvMap.get("density")),
          font_scale: parseOptionalFontScale(kvMap.get("font_scale")),
          formatLabel: "TOML 主题模板",
        };
      }
    }
  }

  // 4. 尝试多色值模板串（至少 3 个 #RRGGBB 色值）
  const hexMatches = trimmed.match(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) || [];
  const uniqueHexes: string[] = [];
  for (const hm of hexMatches) {
    const h = normalizeHexColor(hm);
    if (h && !uniqueHexes.includes(h)) uniqueHexes.push(h);
  }
  if (uniqueHexes.length >= 3) {
    const canvas = uniqueHexes[0];
    const isDark = relativeLuminance(hexToRgb(canvas)) < 0.22;
    const sidebar = uniqueHexes.length >= 4 ? uniqueHexes[1] : canvas;
    const surface = uniqueHexes.length >= 4 ? uniqueHexes[1] : canvas;
    const surfLum = relativeLuminance(hexToRgb(surface));
    let ink = isDark ? "#e6edf7" : "#0f172a";
    let bestContrast = -1;
    for (const candidate of uniqueHexes.slice(1)) {
      const diff = Math.abs(relativeLuminance(hexToRgb(candidate)) - surfLum);
      if (diff > bestContrast) {
        bestContrast = diff;
        ink = candidate;
      }
    }
    let accent = uniqueHexes[uniqueHexes.length - 1];
    let bestChroma = -1;
    for (const candidate of uniqueHexes) {
      if (candidate === canvas || candidate === ink) continue;
      const [r, g, b] = hexToRgb(candidate);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma > bestChroma) {
        bestChroma = chroma;
        accent = candidate;
      }
    }
    const norm = normalizeCustomPalette({
      name: hintTitle || "自定义主题模板",
      base_mode: isDark ? "dark" : "light",
      canvas,
      sidebar,
      surface,
      ink,
      accent,
    });
    if (norm) {
      return { ok: true, palette: norm, formatLabel: "色板模板提取" };
    }
  }

  return {
    ok: false,
    error:
      "未能识别主题模板格式。支持 MailChat 主题模板 (.toml/.json)、VS Code 主题 (.json)、CSS 变量模板 (:root) 或至少 3 个 #RRGGBB 色值。",
  };
}

export function exportThemeToShareJson(rawTheme?: Partial<ThemeConfig> | null): string {
  const norm = normalizeThemeConfig(rawTheme);
  const resolvedMode = resolveEffectiveMode(norm.mode);
  const { surface, accentHex, activeLabel } = resolveActiveThemeTemplate(norm, resolvedMode);

  const sharePayload = {
    schema: "mailchat-theme-template/v1",
    id: sanitizeThemeId(norm.preset === "mist" ? "my-mailchat-theme" : norm.preset),
    name: activeLabel,
    base_mode: resolvedMode,
    density: norm.density,
    font_scale: norm.font_scale,
    canvas: normalizeHexColor(surface.canvasOuter) ?? "#eef2f7",
    sidebar: normalizeHexColor(surface.surfaceList) ?? "#f7f9fc",
    surface: normalizeHexColor(surface.surfaceMain) ?? "#ffffff",
    card: normalizeHexColor(surface.surfaceCard) ?? "#ffffff",
    ink: normalizeHexColor(surface.ink) ?? "#0f172a",
    ink_muted: normalizeHexColor(surface.inkMuted) ?? "#8c98ab",
    accent: accentHex,
  };
  return JSON.stringify(sharePayload, null, 2);
}

export function exportThemeTemplateToml(rawTheme?: Partial<ThemeConfig> | null): string {
  const norm = normalizeThemeConfig(rawTheme);
  const resolvedMode = resolveEffectiveMode(norm.mode);
  const { surface, accentHex, activeLabel } = resolveActiveThemeTemplate(norm, resolvedMode);
  const tplId = sanitizeThemeId(norm.preset === "mist" ? "my-mailchat-theme" : norm.preset);

  return [
    "# MailChat 声明式主题模板 (.mailchat-theme.toml)",
    "# 可在客户端「加载主题模板」中直接导入，或粘贴给配置助手自动应用",
    "",
    "[[theme.custom_themes]]",
    `id = "${tplId}"`,
    `name = "${activeLabel.replace(/"/g, '\\"')}"`,
    `base_mode = "${resolvedMode}"`,
    `canvas = "${normalizeHexColor(surface.canvasOuter) ?? "#eef2f7"}"`,
    `sidebar = "${normalizeHexColor(surface.surfaceList) ?? "#f7f9fc"}"`,
    `surface = "${normalizeHexColor(surface.surfaceMain) ?? "#ffffff"}"`,
    `card = "${normalizeHexColor(surface.surfaceCard) ?? "#ffffff"}"`,
    `ink = "${normalizeHexColor(surface.ink) ?? "#0f172a"}"`,
    `ink_muted = "${normalizeHexColor(surface.inkMuted) ?? "#8c98ab"}"`,
    `accent = "${accentHex}"`,
    "",
  ].join("\n");
}
