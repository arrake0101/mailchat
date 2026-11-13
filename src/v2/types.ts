export type StudioSkin = "editorial" | "obsidian" | "mineral";

export type SidecarTab = "agent" | "toml" | "vault" | "context";

export type ReadingDensity = "editorial" | "compact";

export const SKIN_META: { id: StudioSkin; label: string; badge: string; desc: string }[] = [
  { id: "editorial", label: "宣纸墨韵", badge: "Editorial", desc: "温润纸感米白 + 陶土朱砂强调，长信阅读护眼" },
  { id: "obsidian", label: "曜石暗房", badge: "Obsidian", desc: "极客深色面板 + 电光靛青微光，夜间高对比编排" },
  { id: "mineral", label: "极地矿石", badge: "Mineral", desc: "高密度冷白单色建筑风，纯粹克制" },
];
