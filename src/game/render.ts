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
      data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2];
      data[i * 4 + 3] = 200;
    }
  }
  offCtx.putImageData(imgData, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, mr.x, mr.y, mr.w, mr.h);
  ctx.imageSmoothingEnabled = true;
}

export function drawCellBorders(
  ctx: CanvasRenderingContext2D,
  grid: Int16Array,
  mr: MapRect,
  zoom: number,
) {
  if (zoom <= 1.5) return;
  const cellW = mr.w / GRID_W;
  const cellH = mr.h / GRID_H;
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 0.5 / zoom;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] < 0) continue;
    const x = i % GRID_W, y = (i / GRID_W) | 0;
    ctx.strokeRect(mr.x + x * cellW, mr.y + y * cellH, cellW, cellH);
  }
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
    const bx = (b.gridIdx % GRID_W);
    const by = (b.gridIdx / GRID_W) | 0;
    const px = mr.x + bx * cellW + cellW / 2;
    const py = mr.y + by * cellH + cellH / 2;
    const ownerEntry = [...playerIndex.entries()].find(([, v]) => v === b.ownerIdx);
    const owner = ownerEntry ? players.get(ownerEntry[0]) : null;
    drawBuildingIcon(ctx, px, py, b.type, owner?.color ?? "#fff");
  });
}

export function drawNameplates(
  ctx: CanvasRenderingContext2D,
  grid: Int16Array,
  mr: MapRect,
  zoom: number,
  playerIndex: Map<string, number>,
  players: Map<string, LobbyPlayer>,
  colorCount: number,
) {
  if (zoom <= 0.6) return;
  const scale = Math.min(1, zoom);
  const fontSize = Math.round(11 * scale);
  ctx.save();
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const sumX = new Float64Array(colorCount);
  const sumY = new Float64Array(colorCount);
  const countP = new Int32Array(colorCount);
  for (let i = 0; i < grid.length; i++) {
    const o = grid[i];
    if (o < 0 || o >= colorCount) continue;
    sumX[o] += i % GRID_W;
    sumY[o] += (i / GRID_W) | 0;
    countP[o]++;
  }

  playerIndex.forEach((idx, pid) => {
    if (countP[idx] < 6) return;
    const p = players.get(pid);
    if (!p || !p.alive) return;
    const cx = sumX[idx] / countP[idx];
    const cy = sumY[idx] / countP[idx];
    const sx = mr.x + (cx / GRID_W) * mr.w;
    const sy = mr.y + (cy / GRID_H) * mr.h;
    const label = p.name;
    const textW = ctx.measureText(label).width;
    const pad = 4;
    const bh = fontSize + pad * 2;
    const bw = textW + pad * 2;

    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.beginPath();
    ctx.roundRect(sx - bw / 2, sy - bh / 2, bw, bh, bh / 2);
    ctx.fill();

    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.roundRect(sx - bw / 2, sy - bh / 2, 3, bh, [bh / 2, 0, 0, bh / 2]);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, sx + 2, sy);

    if (zoom > 1.2) {
      ctx.font = `${Math.round(9 * scale)}px sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.fillText(`${p.units}u`, sx + 2, sy + fontSize);
      ctx.font = `bold ${fontSize}px sans-serif`;
    }
  });
  ctx.restore();
}
