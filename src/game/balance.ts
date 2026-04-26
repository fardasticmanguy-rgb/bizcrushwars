import type { BuildingType } from "./types";

export const DIFFICULTY_REGEN: Record<string, number> = {
  relaxed: 0.6,
  balanced: 1.0,
  intense: 1.5,
};

// Per-cell costs for the flood
export const COST_EMPTY = 1;        // claim an empty cell
export const COST_ENEMY_BASE = 4;   // base cost to claim an enemy cell
export const FORT_DEFENSE = 3;      // forts multiply enemy cell cost
export const FACTORY_INCOME = 6;    // units per sync per factory
export const STARTER_RADIUS = 2;    // starter cluster radius

export const BUILD_COST: Record<BuildingType, number> = {
  fort: 120,
  factory: 180,
};

export function hexRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [
    parseInt(c.slice(0, 2), 16),
    parseInt(c.slice(2, 4), 16),
    parseInt(c.slice(4, 6), 16),
  ];
}
