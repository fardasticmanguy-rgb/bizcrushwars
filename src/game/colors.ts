export const PLAYER_COLORS = [
  "#ef4444", // red
  "#3b82f6", // blue
  "#22c55e", // green
  "#a855f7", // purple
  "#f59e0b", // amber
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
];

export function pickColor(taken: string[]): string {
  const free = PLAYER_COLORS.find((c) => !taken.includes(c));
  return free ?? PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}
