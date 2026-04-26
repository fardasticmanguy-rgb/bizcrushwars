import { GRID_W, GRID_H } from "@/game/constants";
import { COST_EMPTY, COST_ENEMY_BASE, FORT_DEFENSE } from "./balance";
import type { Building, Claim } from "./types";

const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/**
 * Territorial.io / OpenFront style wave flood.
 *
 * - Starts from the ENTIRE border of the attacker (every owned cell adjacent
 *   to a non-owned cell). Every border cell pushes simultaneously — this is
 *   what creates the "front line moves outward as one wave" feel.
 * - Processes wave by wave (BFS): all distance-1 cells, then all distance-2,
 *   etc. Within each wave, cheaper cells (empty before enemy) are absorbed
 *   first, so the flood naturally rushes through gaps and stalls on hard cells.
 * - The click target is only used to bias selection inside a wave (cells closer
 *   to the click are processed first when costs tie). Pressure does NOT
 *   tunnel toward the click — it spreads in all directions like water.
 * - Each absorbed cell costs `pressure`. When pressure runs out the front
 *   stops mid-wave, leaving the attacker's territory bulged toward the click.
 */
export function floodAttack(opts: {
  ownerGrid: Int16Array;
  landMask: Uint8Array;
  buildings: Building[];
  ownerIdx: number;
  targetIdx: number;
  sendUnits: number;
  defenderStrength: (defIdx: number) => number; // ≥1, scales enemy cost
  attackerSize: number; // pixels owned — bigger empires flood faster (cheaper)
}): { claims: Claim[]; spent: number; reachedTarget: boolean; unreachable: boolean } {
  const { ownerGrid, landMask, buildings, ownerIdx, targetIdx, sendUnits, defenderStrength, attackerSize } = opts;
  const grid = ownerGrid;

  // ── 1. Seed the wave from the attacker's entire border ────────────────────
  const visited = new Uint8Array(grid.length);
  let wave: number[] = [];
  let hasOwned = false;

  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== ownerIdx) continue;
    hasOwned = true;
    visited[i] = 1;
    const x = i % GRID_W, y = (i / GRID_W) | 0;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      const ni = ny * GRID_W + nx;
      if (!visited[ni] && landMask[ni] && grid[ni] !== ownerIdx) {
        visited[ni] = 1;
        wave.push(ni);
      }
    }
  }
  if (!hasOwned || wave.length === 0) {
    return { claims: [], spent: 0, reachedTarget: false, unreachable: !hasOwned ? false : true };
  }

  // ── 2. Reachability check (cheap BFS over land) ──────────────────────────
  {
    const reach = new Uint8Array(grid.length);
    const q: number[] = [...wave];
    for (const i of q) reach[i] = 1;
    let reachable = false, h = 0;
    while (h < q.length) {
      const cur = q[h++];
      if (cur === targetIdx) { reachable = true; break; }
      const x = cur % GRID_W, y = (cur / GRID_W) | 0;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const ni = ny * GRID_W + nx;
        if (!reach[ni] && landMask[ni]) { reach[ni] = 1; q.push(ni); }
      }
    }
    if (!reachable) return { claims: [], spent: 0, reachedTarget: false, unreachable: true };
  }

  // ── 3. Wave-by-wave flood ────────────────────────────────────────────────
  // Bigger empires get a slight cost discount (Territorial.io: attack speed
  // scales with pixel count). Capped so it doesn't trivialize the game.
  const sizeDiscount = Math.max(0.6, 1 - Math.sqrt(attackerSize) / 200);

  const tx = targetIdx % GRID_W, ty = (targetIdx / GRID_W) | 0;
  const fortSet = new Set<number>();
  for (const b of buildings) if (b.type === "fort") fortSet.add(b.gridIdx);

  const claims: Claim[] = [];
  let pressure = sendUnits;
  let reachedTarget = false;

  while (wave.length > 0 && pressure > 0) {
    // Sort this wave: cheapest first, then closest-to-target as tiebreaker.
    // This is what makes the flood race through gaps and bias toward the click
    // without ignoring the rest of the front.
    const costed = wave.map((ni) => {
      const cur = grid[ni];
      const isFort = cur !== -1 && fortSet.has(ni);
      const raw = cur === -1
        ? COST_EMPTY
        : COST_ENEMY_BASE * (isFort ? FORT_DEFENSE : 1) * defenderStrength(cur);
      const cost = Math.max(1, Math.ceil(raw * sizeDiscount));
      const dist = Math.abs((ni % GRID_W) - tx) + Math.abs(((ni / GRID_W) | 0) - ty);
      return { ni, cost, dist };
    });
    costed.sort((a, b) => (a.cost - b.cost) || (a.dist - b.dist));

    const next: number[] = [];
    for (const { ni, cost } of costed) {
      if (grid[ni] === ownerIdx) continue;
      if (pressure < cost) continue; // can't afford this cell — flood stalls here, may flow elsewhere
      pressure -= cost;
      grid[ni] = ownerIdx;
      claims.push({ i: ni, o: ownerIdx });
      if (ni === targetIdx) reachedTarget = true;

      // Push neighbours into the NEXT wave
      const x = ni % GRID_W, y = (ni / GRID_W) | 0;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const ni2 = ny * GRID_W + nx;
        if (visited[ni2] || !landMask[ni2] || grid[ni2] === ownerIdx) continue;
        visited[ni2] = 1;
        next.push(ni2);
      }
    }
    wave = next;
  }

  return { claims, spent: sendUnits - pressure, reachedTarget, unreachable: false };
}

/** Plant a starter cluster of cells around a chosen center. */
export function plantStarterCluster(opts: {
  ownerGrid: Int16Array;
  landMask: Uint8Array;
  centerIdx: number;
  ownerIdx: number;
  radius: number;
}): Claim[] {
  const { ownerGrid, landMask, centerIdx, ownerIdx, radius } = opts;
  const cx = centerIdx % GRID_W, cy = (centerIdx / GRID_W) | 0;
  const claims: Claim[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
      const i = y * GRID_W + x;
      if (landMask[i] && ownerGrid[i] === -1) {
        ownerGrid[i] = ownerIdx;
        claims.push({ i, o: ownerIdx });
      }
    }
  }
  return claims;
}
