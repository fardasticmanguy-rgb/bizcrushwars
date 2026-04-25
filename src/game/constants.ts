export const PLAYER_COLORS = [
  "#ef4444", // red
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#a855f7", // purple
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#84cc16", // lime
  "#f97316", // orange
  "#14b8a6", // teal
  "#eab308", // yellow
  "#8b5cf6", // violet
];

export const BOT_NAMES = [
  "Falcon", "Viper", "Phantom", "Rogue", "Saber", "Wolf",
  "Hawk", "Cobra", "Ghost", "Reaper", "Storm", "Titan",
];

export const MAPS = [
  { id: "world", name: "World", center: [0.5, 0.5] as [number, number] },
  { id: "europe", name: "Europe", center: [0.52, 0.32] as [number, number] },
  { id: "namerica", name: "North America", center: [0.22, 0.35] as [number, number] },
  { id: "samerica", name: "South America", center: [0.30, 0.65] as [number, number] },
  { id: "asia", name: "Asia", center: [0.72, 0.40] as [number, number] },
  { id: "africa", name: "Africa", center: [0.53, 0.55] as [number, number] },
  { id: "australia", name: "Australia", center: [0.82, 0.70] as [number, number] },
];

// Territory grid — higher res = smaller, more fluid-looking cells
export const GRID_W = 320;
export const GRID_H = 160;

export function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function pickColor(taken: string[]) {
  const free = PLAYER_COLORS.filter((c) => !taken.includes(c));
  if (free.length === 0) return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
  return free[Math.floor(Math.random() * free.length)];
}

export function getOrCreatePlayerId() {
  if (typeof window === "undefined") return "";
  const k = "frontwars_player_id";
  let id = window.localStorage.getItem(k);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(k, id);
  }
  return id;
}
