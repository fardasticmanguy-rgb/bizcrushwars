import { GRID_W, GRID_H } from "@/game/constants";
import type { Building, BuildingType, LobbyPlayer } from "./types";

export type MapRect = { x: number; y: number; w: number; h: number };
export type Camera = { x: number; y: number; zoom: number };

export function computeMapRect(canvasW: number, canvasH: number): MapRect {
  const mapRatio = 1920 / 960;
  const canvasRatio = canvasW / canvasH;
  let mw: number, mh: number, mx: number, my: number;
  if (canvasRatio > mapRatio) {
    mh = canvasH; mw = canvasH * mapRatio; mx = (canvasW - mw) / 2; my = 0;
  } else {
    mw = canvasW; mh = canvasW / mapRatio; mx = 0; my = (canvasH - mh) / 2;
  }
  return { x: mx, y: my, w: mw, h: mh };
}

export function drawBuildingIcon(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, type: BuildingType, color: string,
) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineWidth = 1.5;
  if (type === "fort") {
    ctx.beginPath();
    ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y - 3); ctx.lineTo(x + 6, y + 3);
    ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y + 3); ctx.lineTo(x - 6, y - 3);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else {
    ctx.fillRect(x - 6, y - 6, 12, 12);
    ctx.strokeRect(x - 6, y - 6, 12, 12);
    ctx.fillRect(x - 3, y - 11, 3, 6);
    ctx.strokeRect(x - 3, y - 11, 3, 6);
  }
  ctx.restore();
}

/**
 * Soft pastel territory fill (low opacity over the basemap, OpenFront-style).
 */
export function drawTerritory(
  ctx: CanvasRenderingContext2D,
  off: HTMLCanvasElement,
  offCtx: CanvasRenderingContext2D,
  imgData: ImageData,
  grid: Int16Array,
  colors: [number, number, number][],
  mr: MapRect,
) {
  const data = imgData.data;
  for (let i = 0; i < grid.length; i++) {
    const o = grid[i];
    if (o < 0 || !colors[o]) { data[i * 4 + 3] = 0; }
    else {
      const c = colors[o];
      // soften toward white so colors look pastel against the map
      data[i * 4]     = Math.round(c[0] * 0.55 + 255 * 0.45);
      data[i * 4 + 1] = Math.round(c[1] * 0.55 + 255 * 0.45);
      data[i * 4 + 2] = Math.round(c[2] * 0.55 + 255 * 0.45);
      data[i * 4 + 3] = 150;
    }
  }
  offCtx.putImageData(imgData, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, mr.x, mr.y, mr.w, mr.h);
  ctx.imageSmoothingEnabled = true;
}

/**
 * Draw a crisp dark outline only around the OUTER perimeter of each
 * player's territory (cell faces between owner and not-owner).
 */
export function drawTerritoryOutlines(
  ctx: CanvasRenderingContext2D,
  grid: Int16Array,
  mr: MapRect,
  zoom: number,
) {
  const cellW = mr.w / GRID_W;
  const cellH = mr.h / GRID_H;
  ctx.save();
  ctx.strokeStyle = "rgba(20, 20, 30, 0.85)";
  ctx.lineWidth = Math.max(0.8, 1.2 / zoom);
  ctx.lineCap = "square";
  ctx.beginPath();
  for (let i = 0; i < grid.length; i++) {
    const o = grid[i];
    if (o < 0) continue;
    const x = i % GRID_W, y = (i / GRID_W) | 0;
    const px = mr.x + x * cellW;
    const py = mr.y + y * cellH;
    // top
    if (y === 0 || grid[i - GRID_W] !== o) {
      ctx.moveTo(px, py); ctx.lineTo(px + cellW, py);
    }
    // bottom
    if (y === GRID_H - 1 || grid[i + GRID_W] !== o) {
      ctx.moveTo(px, py + cellH); ctx.lineTo(px + cellW, py + cellH);
    }
    // left
    if (x === 0 || grid[i - 1] !== o) {
      ctx.moveTo(px, py); ctx.lineTo(px, py + cellH);
    }
    // right
    if (x === GRID_W - 1 || grid[i + 1] !== o) {
      ctx.moveTo(px + cellW, py); ctx.lineTo(px + cellW, py + cellH);
    }
  }
  ctx.stroke();
  ctx.restore();
}

export function drawBuildings(
  ctx: CanvasRenderingContext2D,
  buildings: Building[],
  mr: MapRect,
  playerIndex: Map<string, number>,
  players: Map<string, LobbyPlayer>,
) {
  const cellW = mr.w / GRID_W;
  const cellH = mr.h / GRID_H;
  buildings.forEach((b) => {
    const bx = b.gridIdx % GRID_W;
    const by = (b.gridIdx / GRID_W) | 0;
    const px = mr.x + bx * cellW + cellW / 2;
    const py = mr.y + by * cellH + cellH / 2;
    const ownerEntry = [...playerIndex.entries()].find(([, v]) => v === b.ownerIdx);
    const owner = ownerEntry ? players.get(ownerEntry[0]) : null;
    drawBuildingIcon(ctx, px, py, b.type, owner?.color ?? "#fff");
  });
}

function formatTroops(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return `${n}`;
}

function drawCrown(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  ctx.save();
  ctx.fillStyle = "#FFD24A";
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = Math.max(1, size * 0.06);
  const w = size, h = size * 0.7;
  const x = cx - w / 2, y = cy - h / 2;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + h * 0.35);
  ctx.lineTo(x + w * 0.2, y + h * 0.7);
  ctx.lineTo(x + w * 0.5, y);
  ctx.lineTo(x + w * 0.8, y + h * 0.7);
  ctx.lineTo(x + w, y + h * 0.35);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * OpenFront-style big centered name + troops label inside each player's
 * territory. The text auto-scales to fit each empire — bigger empires get
 * bigger labels. Crown above the leader.
 */
export function drawTerritoryLabels(
  ctx: CanvasRenderingContext2D,
  grid: Int16Array,
  mr: MapRect,
  zoom: number,
  playerIndex: Map<string, number>,
  players: Map<string, LobbyPlayer>,
  colorCount: number,
) {
  const sumX = new Float64Array(colorCount);
  const sumY = new Float64Array(colorCount);
  const minX = new Int32Array(colorCount).fill(GRID_W);
  const maxX = new Int32Array(colorCount).fill(-1);
  const minY = new Int32Array(colorCount).fill(GRID_H);
  const maxY = new Int32Array(colorCount).fill(-1);
  const countP = new Int32Array(colorCount);

  for (let i = 0; i < grid.length; i++) {
    const o = grid[i];
    if (o < 0 || o >= colorCount) continue;
    const x = i % GRID_W, y = (i / GRID_W) | 0;
    sumX[o] += x; sumY[o] += y;
    if (x < minX[o]) minX[o] = x;
    if (x > maxX[o]) maxX[o] = x;
    if (y < minY[o]) minY[o] = y;
    if (y > maxY[o]) maxY[o] = y;
    countP[o]++;
  }

  // Find leader (most cells)
  let leaderIdx = -1, leaderCount = 0;
  for (let i = 0; i < colorCount; i++) {
    if (countP[i] > leaderCount) { leaderCount = countP[i]; leaderIdx = i; }
  }

  const cellW = mr.w / GRID_W;
  const cellH = mr.h / GRID_H;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  playerIndex.forEach((idx, pid) => {
    if (countP[idx] < 4) return;
    const p = players.get(pid);
    if (!p || !p.alive) return;

    const cx = sumX[idx] / countP[idx];
    const cy = sumY[idx] / countP[idx];
    const sx = mr.x + cx * cellW + cellW / 2;
    const sy = mr.y + cy * cellH + cellH / 2;

    // Auto-size by territory bounding box (in screen pixels, pre-zoom)
    const bbW = (maxX[idx] - minX[idx] + 1) * cellW;
    const bbH = (maxY[idx] - minY[idx] + 1) * cellH;
    const target = Math.min(bbW * 0.45, bbH * 0.5);
    const nameSize = Math.max(8, Math.min(48, target / zoom * 0.9));
    const troopSize = nameSize * 0.95;

    // Crown for leader
    if (idx === leaderIdx) {
      drawCrown(ctx, sx, sy - nameSize * 1.1, nameSize * 1.2);
    }

    // Name
    ctx.font = `700 ${nameSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.lineWidth = Math.max(2, nameSize * 0.12);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.fillStyle = "rgba(20,20,30,0.95)";
    ctx.strokeText(p.name, sx, sy);
    ctx.fillText(p.name, sx, sy);

    // Troops
    ctx.font = `800 ${troopSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.lineWidth = Math.max(2, troopSize * 0.14);
    ctx.strokeText(formatTroops(p.units), sx, sy + nameSize * 0.85);
    ctx.fillText(formatTroops(p.units), sx, sy + nameSize * 0.85);
  });
  ctx.restore();
}
