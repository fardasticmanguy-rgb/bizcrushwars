import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { GRID_W, GRID_H } from "@/game/constants";
import { loadLandMask } from "@/game/landMask";
import worldMap from "@/assets/map-world.jpg";
import { Button } from "@/components/ui/button";
import { LogOut, Shield, Factory, Hammer, Sword } from "lucide-react";
import { toast } from "sonner";

type Lobby = {
  id: string;
  code: string;
  host_id: string;
  map_id: string;
  difficulty: string;
};
type LobbyPlayer = {
  id: string;
  player_id: string;
  name: string;
  color: string;
  is_bot: boolean;
  dot_x: number;
  dot_y: number;
  units: number;
  pixels: number;
  alive: boolean;
};

type BuildingType = "city" | "defense_post" | "port" | "fort" | "factory" | "missile_silo";
type Building = { type: BuildingType; ownerIdx: number; gridIdx: number };

const BUILDING_LABELS: Record<BuildingType, string> = {
  city: "City", defense_post: "Defense Post", port: "Port",
  fort: "Fort", factory: "Factory", missile_silo: "Missile Silo",
};

interface GameScreenProps {
  lobby: Lobby;
  playerId: string;
  onLeave: () => void;
}

function hexRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

const DIFFICULTY_REGEN: Record<string, number> = {
  relaxed: 0.6,
  balanced: 1.0,
  intense: 1.5,
};

// Costs per cell during flood
const COST_EMPTY = 1;
const COST_ENEMY_BASE = 3;
const FORT_DEFENSE = 2.5;
const DEFENSE_POST_MULT = 1.8;  // defense posts slow enemy advance
const FACTORY_INCOME = 8;
const CITY_POP_BONUS = 500;     // extra max-units per city
const MISSILE_SILO_STRIKE = 200; // one-shot damage to a target cell cluster
const STARTER_RADIUS = 1;
const BUILD_COST: Record<BuildingType, number> = {
  city: 100, defense_post: 60, port: 120,
  fort: 80, factory: 140, missile_silo: 300,
};
const BUILDING_INCOME: Partial<Record<BuildingType, number>> = {
  factory: FACTORY_INCOME, port: 4,
};
const FLOOD_CELLS_PER_FRAME = 8;

type CtxMenu = {
  screenX: number;
  screenY: number;
  gx: number;
  gy: number;
  isOwnTerritory: boolean;
  isLand: boolean;
} | null;

type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };

export function GameScreen({ lobby, playerId, onLeave }: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [, setTick] = useState(0);
  const [sendPct, setSendPct] = useState(50);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [hasSpawned, setHasSpawned] = useState(false);

  const sendPctRef = useRef(50);
  const buildingsRef = useRef<Building[]>([]);
  useEffect(() => { sendPctRef.current = sendPct; }, [sendPct]);
  useEffect(() => { buildingsRef.current = buildings; }, [buildings]);

  function showNotif(msg: string, kind: "info" | "error" | "success" = "info") {
    if (kind === "error") toast.error(msg);
    else if (kind === "success") toast.success(msg);
    else toast(msg);
  }

  const ownerGridRef = useRef<Int16Array>(new Int16Array(GRID_W * GRID_H).fill(-1));
  const landMaskRef = useRef<Uint8Array | null>(null);
  const playersRef = useRef<Map<string, LobbyPlayer>>(new Map());
  const playerIndexRef = useRef<Map<string, number>>(new Map());
  const colorsRef = useRef<[number, number, number][]>([]);
  const lastSyncRef = useRef<number>(0);
  const lastBotMoveRef = useRef<number>(0);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const camRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef = useRef({ active: false, startX: 0, startY: 0, camX: 0, camY: 0 });
  const dragMovedRef = useRef(false);
  const mapRectRef = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // Pending flood cells to animate. executeAttack computes claims instantly
  // (pressure math is synchronous) but queues them here so the render loop
  // reveals them gradually — FLOOD_CELLS_PER_FRAME per frame.
  const floodQueueRef = useRef<Array<[number, number]>>([]);
  const particlesRef = useRef<Particle[]>([]);

  const screenToGrid = useCallback((sx: number, sy: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = (sx - rect.left) * devicePixelRatio;
    const py = (sy - rect.top) * devicePixelRatio;
    const cam = camRef.current;
    const wx = (px - cam.x) / cam.zoom;
    const wy = (py - cam.y) / cam.zoom;
    const mr = mapRectRef.current;
    const gx = Math.floor((wx - mr.x) / (mr.w / GRID_W));
    const gy = Math.floor((wy - mr.y) / (mr.h / GRID_H));
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return null;
    return { gx, gy };
  }, []);

  // Load players + subscribe realtime
  useEffect(() => {
    let active = true;
    async function load() {
      const { data } = await supabase.from("lobby_players").select("*").eq("lobby_id", lobby.id);
      if (!active || !data) return;
      setPlayers(data);
      const map = new Map<string, LobbyPlayer>();
      data.forEach((p) => map.set(p.player_id, p));
      playersRef.current = map;
      const idx = new Map<string, number>();
      const cols: [number, number, number][] = [];
      data.forEach((p, i) => { idx.set(p.player_id, i); cols.push(hexRgb(p.color)); });
      playerIndexRef.current = idx;
      colorsRef.current = cols;
    }
    load();

    const ch = supabase
      .channel(`game-${lobby.id}`, { config: { broadcast: { self: false } } })
      .on("postgres_changes", { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobby.id}` },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const p = payload.new as LobbyPlayer;
          playersRef.current.set(p.player_id, p);
          setPlayers((prev) => {
            const i = prev.findIndex((x) => x.player_id === p.player_id);
            if (i === -1) return [...prev, p];
            const next = [...prev]; next[i] = p; return next;
          });
        })
      .on("broadcast", { event: "claim" }, ({ payload }) => {
        const claims = payload as { i: number; o: number }[];
        const grid = ownerGridRef.current;
        for (const c of claims) grid[c.i] = c.o;
      })
      .on("broadcast", { event: "building" }, ({ payload }) => {
        const b = payload as Building;
        setBuildings((prev) => prev.some((x) => x.gridIdx === b.gridIdx) ? prev : [...prev, b]);
        if (!buildingsRef.current.some((x) => x.gridIdx === b.gridIdx))
          buildingsRef.current = [...buildingsRef.current, b];
      })
      .subscribe();
    channelRef.current = ch;
    return () => { active = false; supabase.removeChannel(ch); channelRef.current = null; };
  }, [lobby.id]);

  useEffect(() => { loadLandMask().then((m) => { landMaskRef.current = m; }); }, []);

  // Render + sim loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const off = document.createElement("canvas");
    off.width = GRID_W; off.height = GRID_H;
    const offCtx = off.getContext("2d")!;
    const imgData = offCtx.createImageData(GRID_W, GRID_H);

    const bgImg = new Image();
    bgImg.src = worldMap;

    function resize() {
      const r = container!.getBoundingClientRect();
      canvas!.width = r.width * devicePixelRatio;
      canvas!.height = r.height * devicePixelRatio;
      canvas!.style.width = `${r.width}px`;
      canvas!.style.height = `${r.height}px`;
      mapRectRef.current = computeMapRect();
    }
    function computeMapRect() {
      const w = canvas!.width;
      const h = canvas!.height;
      const mapRatio = 1920 / 960;
      const canvasRatio = w / h;
      let mw: number, mh: number, mx: number, my: number;
      if (canvasRatio > mapRatio) { mh = h; mw = h * mapRatio; mx = (w - mw) / 2; my = 0; }
      else { mw = w; mh = w / mapRatio; mx = 0; my = (h - mh) / 2; }
      return { x: mx, y: my, w: mw, h: mh };
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    async function syncStats() {
      if (lobby.host_id !== playerId) return;
      const grid = ownerGridRef.current;
      const blds = buildingsRef.current;
      const counts = new Array(colorsRef.current.length).fill(0);
      for (let i = 0; i < grid.length; i++) { const o = grid[i]; if (o >= 0) counts[o]++; }
      // Buildings transfer color when land is captured — re-read owner from grid
      blds.forEach((b) => {
        const currentOwner = grid[b.gridIdx];
        if (currentOwner >= 0 && currentOwner !== b.ownerIdx) b.ownerIdx = currentOwner;
      });
      const factoryBonus = new Array(colorsRef.current.length).fill(0);
      blds.forEach((b) => {
        const inc = BUILDING_INCOME[b.type];
        if (inc) factoryBonus[b.ownerIdx] = (factoryBonus[b.ownerIdx] || 0) + inc;
      });
      // City pop bonus — tracked as extra units cap (applied below)
      const cityBonus = new Array(colorsRef.current.length).fill(0);
      blds.forEach((b) => { if (b.type === "city") cityBonus[b.ownerIdx] = (cityBonus[b.ownerIdx] || 0) + CITY_POP_BONUS; });
      const regenMult = DIFFICULTY_REGEN[lobby.difficulty] ?? 1;

      const updates: Promise<unknown>[] = [];
      playersRef.current.forEach((p) => {
        const idx = playerIndexRef.current.get(p.player_id);
        if (idx === undefined) return;
        const px = counts[idx] ?? 0;
        // Passive regen: scales with territory (sqrt to avoid runaway)
        const passive = Math.round(Math.sqrt(px) * 2 * regenMult);
        const bonus = Math.round(factoryBonus[idx] || 0);
        const popCap = 99999 + (cityBonus[idx] || 0);
        const newUnits = Math.min(popCap, p.units + passive + bonus);
        const alive = px > 0 || p.units > 0;
        updates.push(Promise.resolve(supabase.from("lobby_players")
          .update({ pixels: px, units: newUnits, alive })
          .eq("lobby_id", lobby.id).eq("player_id", p.player_id)));
      });
      await Promise.all(updates);
    }

    function drawBuildingIcon(x: number, y: number, type: BuildingType, color: string) {
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.lineWidth = 1.2;
      const r = 5; // base radius
      switch (type) {
        case "city":
          // Building silhouette
          ctx.fillRect(x - r, y - r * 0.6, r * 2, r * 1.4);
          ctx.strokeRect(x - r, y - r * 0.6, r * 2, r * 1.4);
          // Towers
          ctx.fillRect(x - r, y - r * 1.4, r * 0.7, r * 0.8);
          ctx.strokeRect(x - r, y - r * 1.4, r * 0.7, r * 0.8);
          ctx.fillRect(x + r * 0.3, y - r * 1.6, r * 0.7, r);
          ctx.strokeRect(x + r * 0.3, y - r * 1.6, r * 0.7, r);
          break;
        case "defense_post":
          // Shield shape
          ctx.beginPath();
          ctx.moveTo(x, y - r * 1.4);
          ctx.lineTo(x + r, y - r * 0.4);
          ctx.lineTo(x + r, y + r * 0.6);
          ctx.lineTo(x, y + r * 1.4);
          ctx.lineTo(x - r, y + r * 0.6);
          ctx.lineTo(x - r, y - r * 0.4);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          break;
        case "port":
          // Anchor
          ctx.beginPath();
          ctx.arc(x, y - r * 0.5, r * 0.6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x, y - r * 0.5); ctx.lineTo(x, y + r);
          ctx.moveTo(x - r * 0.8, y + r * 0.6); ctx.lineTo(x + r * 0.8, y + r * 0.6);
          ctx.stroke();
          break;
        case "fort":
          // Hexagon
          ctx.beginPath();
          for (let a = 0; a < 6; a++) {
            const ang = (a / 6) * Math.PI * 2 - Math.PI / 6;
            a === 0 ? ctx.moveTo(x + Math.cos(ang)*r, y + Math.sin(ang)*r)
                    : ctx.lineTo(x + Math.cos(ang)*r, y + Math.sin(ang)*r);
          }
          ctx.closePath(); ctx.fill(); ctx.stroke();
          break;
        case "factory":
          // Square + chimney
          ctx.fillRect(x - r, y - r * 0.6, r * 2, r * 1.4);
          ctx.strokeRect(x - r, y - r * 0.6, r * 2, r * 1.4);
          ctx.fillRect(x - r * 0.4, y - r * 1.4, r * 0.5, r * 0.9);
          ctx.strokeRect(x - r * 0.4, y - r * 1.4, r * 0.5, r * 0.9);
          break;
        case "missile_silo":
          // Rocket/triangle
          ctx.beginPath();
          ctx.moveTo(x, y - r * 1.4);
          ctx.lineTo(x + r * 0.7, y + r);
          ctx.lineTo(x - r * 0.7, y + r);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          // flame
          ctx.fillStyle = "#f97316";
          ctx.beginPath();
          ctx.moveTo(x - r * 0.4, y + r);
          ctx.lineTo(x, y + r * 1.8);
          ctx.lineTo(x + r * 0.4, y + r);
          ctx.closePath(); ctx.fill();
          break;
      }
      ctx.restore();
    }

    function render() {
      const w = canvas!.width;
      const h = canvas!.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0a1628";
      ctx.fillRect(0, 0, w, h);

      const mr = computeMapRect();
      mapRectRef.current = mr;
      const { x: mx, y: my, w: mw, h: mh } = mr;

      const cam = camRef.current;
      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.zoom, cam.zoom);

      if (bgImg.complete) ctx.drawImage(bgImg, mx, my, mw, mh);
      else { ctx.fillStyle = "#1a3050"; ctx.fillRect(mx, my, mw, mh); }

      // ── Territory fill + border outline (OpenFront style) ─────────────────
      // Pass 1: fill owned cells with semi-transparent color
      const grid = ownerGridRef.current;
      const colors = colorsRef.current;
      const data = imgData.data;
      const defPostSet = new Set(buildingsRef.current.filter(b => b.type === "defense_post").map(b => b.gridIdx));

      for (let i = 0; i < grid.length; i++) {
        const o = grid[i];
        if (o < 0 || !colors[o]) { data[i * 4 + 3] = 0; continue; }
        const c = colors[o];
        // Defense-post cells show checkerboard: every other cell slightly lighter
        const isDefPost = defPostSet.has(i);
        const x = i % GRID_W, y = Math.floor(i / GRID_W);
        const checker = isDefPost && (x + y) % 2 === 0;
        data[i * 4]     = checker ? Math.min(255, c[0] + 60) : c[0];
        data[i * 4 + 1] = checker ? Math.min(255, c[1] + 60) : c[1];
        data[i * 4 + 2] = checker ? Math.min(255, c[2] + 60) : c[2];
        data[i * 4 + 3] = 190;
      }
      offCtx.putImageData(imgData, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, mx, my, mw, mh);
      ctx.imageSmoothingEnabled = true;

      // Pass 2: bright border outline — a cell is a border if any 4-neighbour is different owner
      // We draw a 1.5px bright stroke around each owned cell that borders another owner/empty
      const cellW = mw / GRID_W;
      const cellH = mh / GRID_H;
      for (let i = 0; i < grid.length; i++) {
        const o = grid[i];
        if (o < 0) continue;
        const x = i % GRID_W, y = Math.floor(i / GRID_W);
        let isBorder = false;
        for (const [dx2, dy2] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
          const nx2 = x+dx2, ny2 = y+dy2;
          if (nx2<0||ny2<0||nx2>=GRID_W||ny2>=GRID_H) { isBorder = true; break; }
          if (grid[ny2*GRID_W+nx2] !== o) { isBorder = true; break; }
        }
        if (!isBorder) continue;
        // Bright version of owner color for the outline
        const c = colors[o];
        const bright = `rgba(${Math.min(255,c[0]+80)},${Math.min(255,c[1]+80)},${Math.min(255,c[2]+80)},0.9)`;
        ctx.strokeStyle = bright;
        ctx.lineWidth = Math.max(1, cellW * 0.35);
        ctx.strokeRect(mx + x * cellW + 0.5, my + y * cellH + 0.5, cellW - 1, cellH - 1);
      }

      // ── Buildings ────────────────────────────────────────────────────────
      // Buildings re-color when captured (ownerIdx is updated in executeAttack)
      const blds = buildingsRef.current;
      blds.forEach((b) => {
        // Re-read owner from grid (captures update ownerIdx directly)
        const currentOwner = grid[b.gridIdx];
        const ownerEntry2 = currentOwner >= 0
          ? [...playerIndexRef.current.entries()].find(([, v]) => v === currentOwner)
          : null;
        const ownerP = ownerEntry2 ? playersRef.current.get(ownerEntry2[0]) : null;
        const col = ownerP?.color ?? "#fff";
        const bx = (b.gridIdx % GRID_W) / GRID_W;
        const by = Math.floor(b.gridIdx / GRID_W) / GRID_H;
        const px2 = mx + bx * mw + cellW / 2;
        const py2 = my + by * mh + cellH / 2;
        drawBuildingIcon(px2, py2, b.type, col);
      });

      // ── Nameplates (OpenFront style) ─────────────────────────────────────
      // Name + troop count floating over territory centroid. No pill — just
      // bold white text with a dark shadow, exactly like the reference images.
      {
        const sumX = new Float64Array(colors.length);
        const sumY = new Float64Array(colors.length);
        const countP = new Int32Array(colors.length);
        for (let i = 0; i < grid.length; i++) {
          const o = grid[i];
          if (o < 0 || o >= colors.length) continue;
          sumX[o] += i % GRID_W;
          sumY[o] += Math.floor(i / GRID_W);
          countP[o]++;
        }
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const baseFont = Math.max(7, Math.min(14, 10 * cam.zoom));

        playerIndexRef.current.forEach((idx, pid) => {
          if (countP[idx] < 4) return;
          const p = playersRef.current.get(pid);
          if (!p || !p.alive) return;
          const sx = mx + (sumX[idx] / countP[idx] / GRID_W) * mw;
          const sy = my + (sumY[idx] / countP[idx] / GRID_H) * mh;

          // Name line
          ctx.font = `bold ${baseFont}px sans-serif`;
          ctx.shadowColor = "rgba(0,0,0,0.9)";
          ctx.shadowBlur = 3;
          ctx.fillStyle = "#ffffff";
          ctx.fillText(p.name, sx, sy - baseFont * 0.6);

          // Troop count line — formatted like "5.22K"
          const troopStr = p.units >= 1000
            ? `${(p.units / 1000).toFixed(2)}K`
            : `${p.units}`;
          ctx.font = `${baseFont * 0.85}px sans-serif`;
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.fillText(troopStr, sx, sy + baseFont * 0.6);
          ctx.shadowBlur = 0;
        });
        ctx.restore();
      }

      ctx.restore(); // end camera transform

      // ── Particles (screen space, after camera restore) ───────────────────
      for (const p of particlesRef.current) {
        ctx.globalAlpha = p.life * 0.85;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2 + p.life * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function loop(now: number) {
      // ── Drain flood animation queue ──────────────────────────────────────
      // Claims were pre-computed synchronously; we reveal them gradually here.
      const fq = floodQueueRef.current;
      const grid = ownerGridRef.current;
      const mr = mapRectRef.current;
      if (fq.length > 0) {
        const batch = fq.splice(0, FLOOD_CELLS_PER_FRAME);
        for (const [ci, oi] of batch) {
          grid[ci] = oi;
          // Spawn 2 particles at this cell for visual fizz
          // world coords → screen coords (apply camera transform)
          const wx2 = mr.x + ((ci % GRID_W) + 0.5) / GRID_W * mr.w;
          const wy2 = mr.y + (Math.floor(ci / GRID_W) + 0.5) / GRID_H * mr.h;
          const cam2 = camRef.current;
          const cx2 = cam2.x + wx2 * cam2.zoom;
          const cy2 = cam2.y + wy2 * cam2.zoom;
          const ownerEntry2 = [...playerIndexRef.current.entries()].find(([, v]) => v === oi);
          const ownerP = ownerEntry2 ? playersRef.current.get(ownerEntry2[0]) : null;
          const col = ownerP?.color ?? "#fff";
          for (let pi = 0; pi < 3; pi++) {
            const ang = Math.random() * Math.PI * 2;
            const spd = 0.3 + Math.random() * 0.6;
            particlesRef.current.push({
              x: cx2, y: cy2,
              vx: Math.cos(ang) * spd,
              vy: Math.sin(ang) * spd,
              life: 1,
              color: col,
            });
          }
        }
        // Broadcast the batch claims to other players
        if (batch.length > 0)
          channelRef.current?.send({ type: "broadcast", event: "claim", payload: batch.map(([i, o]) => ({ i, o })) });
      }

      // ── Update particles ─────────────────────────────────────────────────
      const cam = camRef.current;
      particlesRef.current = particlesRef.current.filter(p => {
        p.x += p.vx * cam.zoom;
        p.y += p.vy * cam.zoom;
        p.life -= 0.04;
        return p.life > 0;
      });

      render();

      if (now - lastSyncRef.current > 1500) { lastSyncRef.current = now; syncStats(); }

      // ── Bot AI ───────────────────────────────────────────────────────────
      if (lobby.host_id === playerId && now - lastBotMoveRef.current > 1800) {
        lastBotMoveRef.current = now;
        const mask = landMaskRef.current;
        if (mask) {
          playersRef.current.forEach((bot) => {
            if (!bot.is_bot || !bot.alive) return;
            const idx = playerIndexRef.current.get(bot.player_id);
            if (idx === undefined) return;

            // Plant starter if no territory
            const owned: number[] = [];
            for (let i = 0; i < grid.length; i++) if (grid[i] === idx) owned.push(i);
            if (owned.length === 0) {
              const candidates: number[] = [];
              for (let i = 0; i < mask.length; i++)
                if (mask[i] && grid[i] === -1) candidates.push(i);
              if (candidates.length === 0) return;
              plantStarter(candidates[Math.floor(Math.random() * candidates.length)], idx);
              return;
            }

            // Build when rich enough — bots build too
            if (bot.units > 150 && buildingsRef.current.filter(b => b.ownerIdx === idx).length < 3) {
              const myLand = owned[Math.floor(Math.random() * owned.length)];
              if (!buildingsRef.current.some(b => b.gridIdx === myLand)) {
                const btype: BuildingType = bot.units > 300 ? "factory" : "fort";
                const cost2 = BUILD_COST[btype];
                if (bot.units >= cost2) {
                  const bld: Building = { type: btype, ownerIdx: idx, gridIdx: myLand };
                  buildingsRef.current = [...buildingsRef.current, bld];
                  setBuildings(prev => [...prev, bld]);
                  channelRef.current?.send({ type: "broadcast", event: "building", payload: bld });
                  bot.units -= cost2;
                }
              }
            }

            if (bot.units < 20) return;

            // Find frontier cells — split by neutral vs enemy
            const neutralFrontier: number[] = [];
            const enemyFrontier: number[] = [];
            for (const i of owned) {
              const x = i % GRID_W, y = Math.floor(i / GRID_W);
              for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
                const nx = x+dx, ny = y+dy;
                if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
                const ni = ny*GRID_W+nx;
                if (!mask[ni]) continue;
                if (grid[ni] === -1) neutralFrontier.push(ni);
                else if (grid[ni] !== idx) enemyFrontier.push(ni);
              }
            }

            // Decision: prefer neutral expansion; only fight enemies when strong
            let target = -1;
            let sendFrac = 0.35;
            if (neutralFrontier.length > 0 && bot.units > 50) {
              // Expand into neutral — pick a random neutral neighbour
              target = neutralFrontier[Math.floor(Math.random() * neutralFrontier.length)];
              sendFrac = 0.3 + Math.random() * 0.2;
            } else if (enemyFrontier.length > 0 && bot.units > 200) {
              // Attack a weakly-defended enemy tile
              target = enemyFrontier[Math.floor(Math.random() * enemyFrontier.length)];
              sendFrac = 0.5 + Math.random() * 0.3;
            }
            if (target === -1) return;

            const sendUnits = Math.max(5, Math.floor(bot.units * sendFrac));
            executeAttack(target, sendUnits, idx, bot.player_id, bot.units);
          });
        }
      }

      setTick((t) => (t + 1) % 1000000);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const r = canvas!.getBoundingClientRect();
      const mx2 = (e.clientX - r.left) * devicePixelRatio;
      const my2 = (e.clientY - r.top) * devicePixelRatio;
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const cam = camRef.current;
      const newZoom = Math.min(8, Math.max(0.4, cam.zoom * factor));
      cam.x = mx2 - (mx2 - cam.x) * (newZoom / cam.zoom);
      cam.y = my2 - (my2 - cam.y) * (newZoom / cam.zoom);
      cam.zoom = newZoom;
    }
    function onMouseDown(e: MouseEvent) {
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        dragMovedRef.current = false;
        dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, camX: camRef.current.x, camY: camRef.current.y };
      }
    }
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current.active) return;
      const dx = (e.clientX - dragRef.current.startX) * devicePixelRatio;
      const dy = (e.clientY - dragRef.current.startY) * devicePixelRatio;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMovedRef.current = true;
      camRef.current.x = dragRef.current.camX + dx;
      camRef.current.y = dragRef.current.camY + dy;
    }
    function onMouseUp() { dragRef.current.active = false; }

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby.id, lobby.host_id, lobby.difficulty, playerId]);

  // Plant starter cluster (used for both player + bots)
  function plantStarter(centerIdx: number, ownerIdx: number) {
    const mask = landMaskRef.current;
    if (!mask) return;
    const grid = ownerGridRef.current;
    const cx = centerIdx % GRID_W;
    const cy = Math.floor(centerIdx / GRID_W);
    const claims: { i: number; o: number }[] = [];
    for (let dy = -STARTER_RADIUS; dy <= STARTER_RADIUS; dy++) {
      for (let dx = -STARTER_RADIUS; dx <= STARTER_RADIUS; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
        const i = y * GRID_W + x;
        if (mask[i] && grid[i] === -1) {
          grid[i] = ownerIdx;
          claims.push({ i, o: ownerIdx });
        }
      }
    }
    if (claims.length > 0)
      channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });
  }

  // ─── PRESSURE FLOOD ATTACK ───────────────────────────────────────────────
  // Models territory like a liquid under pressure. Units pour outward from your
  // ENTIRE border at once, biased toward the target cell (nearest cells processed
  // first). The flood spreads in every direction simultaneously — clicking a
  // distant point directs the flow, but pressure also spills into easy adjacent
  // empty cells along the way. When pressure runs out the front stalls visibly.
  function executeAttack(
    targetIdx: number,
    sendUnits: number,
    ownerIdx: number,
    ownerPid: string,
    currentUnits: number
  ) {
    const mask = landMaskRef.current;
    if (!mask) return { spent: 0, captured: 0, repelled: false };
    const grid = ownerGridRef.current;
    const blds = buildingsRef.current;

    // ── 1. Collect border frontier (owned cells with at least one non-owned neighbour) ──
    const visited = new Uint8Array(grid.length);
    const seedQueue: number[] = [];
    let hasOwned = false;

    for (let i = 0; i < grid.length; i++) {
      if (grid[i] !== ownerIdx) continue;
      hasOwned = true;
      visited[i] = 1; // mark owned cells so they are never re-processed
      const x = i % GRID_W, y = Math.floor(i / GRID_W);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
        const nx = x+dx, ny = y+dy;
        if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
        const ni = ny*GRID_W+nx;
        if (!visited[ni] && mask[ni] && grid[ni] !== ownerIdx) {
          visited[ni] = 1;
          seedQueue.push(ni);
        }
      }
    }
    if (!hasOwned) return { spent: 0, captured: 0, repelled: false };
    if (seedQueue.length === 0) return { spent: 0, captured: 0, repelled: false, unreachable: true };

    // ── 2. Check reachability: can we BFS from border to target at all? ──
    // (quick check before the expensive priority flood)
    {
      const reach = new Uint8Array(grid.length);
      const q: number[] = [...seedQueue];
      q.forEach(i => reach[i] = 1);
      let reachable = false;
      let h = 0;
      while (h < q.length) {
        const cur = q[h++];
        if (cur === targetIdx) { reachable = true; break; }
        const x = cur % GRID_W, y = Math.floor(cur / GRID_W);
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
          const nx = x+dx, ny = y+dy;
          if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
          const ni = ny*GRID_W+nx;
          if (!reach[ni] && mask[ni]) { reach[ni] = 1; q.push(ni); }
        }
      }
      if (!reachable) return { spent: 0, captured: 0, repelled: false, unreachable: true };
    }

    // ── 3. Pressure flood with distance-to-target priority ──
    // Bucket queue sorted by Manhattan distance to target — nearest processed first.
    // This naturally directs the flow toward where you clicked while still
    // letting the flood spill into any cheap adjacent cells along the way.
    const tx = targetIdx % GRID_W, ty = Math.floor(targetIdx / GRID_W);
    const maxDist = GRID_W + GRID_H;
    const buckets: number[][] = Array.from({ length: maxDist + 1 }, () => []);
    for (const ni of seedQueue) {
      const d = Math.abs(ni % GRID_W - tx) + Math.abs(Math.floor(ni / GRID_W) - ty);
      buckets[Math.min(d, maxDist)].push(ni);
    }

    // Defender strength cache
    const defCache = new Map<number, number>();
    function defStr(defIdx: number) {
      if (defCache.has(defIdx)) return defCache.get(defIdx)!;
      const entry = [...playerIndexRef.current.entries()].find(([, v]) => v === defIdx);
      const p = entry ? playersRef.current.get(entry[0]) : null;
      const s = p ? Math.max(1, Math.sqrt(p.units) / 5) : 1;
      defCache.set(defIdx, s);
      return s;
    }

    let pressure = sendUnits;
    const claims: { i: number; o: number }[] = [];
    let captured = 0;
    let reachedTarget = false;

    outer:
    for (let d = 0; d <= maxDist && pressure > 0; d++) {
      const bucket = buckets[d];
      if (!bucket || bucket.length === 0) continue;
      for (let bi = 0; bi < bucket.length && pressure > 0; bi++) {
        const ni = bucket[bi];
        const cur = grid[ni];
        if (cur === ownerIdx) continue; // already ours (shouldn't happen but guard)

        // Cost to absorb this cell.
        // KEY: neutral tiles far from the target corridor are expensive until
        // the target is reached — this stops the flood wasting units by
        // painting random empty land sideways instead of driving toward the click.
        const hasFort = cur !== -1 && blds.some((b) => b.gridIdx === ni && b.type === "fort");
        let cost: number;
        if (cur === -1) {
          // Neutral: cheap in the corridor (d <= 3), expensive off to the sides
          const offAxis = reachedTarget ? 0 : Math.max(0, d - 2);
          cost = COST_EMPTY + Math.floor(offAxis * 1.5);
        } else {
          cost = Math.ceil(COST_ENEMY_BASE * (hasFort ? FORT_DEFENSE : 1) * defStr(cur));
        }

        if (pressure < cost) continue; // not enough pressure — fluid skips, finds easier path

        pressure -= cost;
        grid[ni] = ownerIdx;
        claims.push({ i: ni, o: ownerIdx });
        captured++;
        if (ni === targetIdx) reachedTarget = true;

        // Expand newly claimed cell's neighbours into buckets
        const x = ni % GRID_W, y = Math.floor(ni / GRID_W);
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
          const nx = x+dx, ny = y+dy;
          if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
          const ni2 = ny*GRID_W+nx;
          if (visited[ni2] || !mask[ni2] || grid[ni2] === ownerIdx) continue;
          visited[ni2] = 1;
          const d2 = Math.abs(nx - tx) + Math.abs(ny - ty);
          buckets[Math.min(d2, maxDist)].push(ni2);
        }
      }
    }

    // Revert the instant grid writes and push to the animation queue instead.
    // The render loop drains floodQueueRef at FLOOD_CELLS_PER_FRAME/frame,
    // writes to the real grid, spawns particles, and broadcasts each batch.
    for (const { i } of claims) ownerGridRef.current[i] = -1;
    for (const { i, o } of claims) floodQueueRef.current.push([i, o]);

    const actuallySpent = sendUnits - pressure;
    const newUnits = Math.max(0, currentUnits - actuallySpent);
    const playerObj = playersRef.current.get(ownerPid);
    if (playerObj) playerObj.units = newUnits;
    supabase.from("lobby_players")
      .update({ units: newUnits })
      .eq("lobby_id", lobby.id).eq("player_id", ownerPid);

    return { spent: actuallySpent, captured, repelled: captured === 0, reachedTarget, unreachable: false };
  }

  // CLICK — either plant starter (if no territory) or attack target cube
  function handleClick(e: React.MouseEvent) {
    if (dragMovedRef.current) { dragMovedRef.current = false; return; }
    if (ctxMenu) { setCtxMenu(null); return; }

    const coords = screenToGrid(e.clientX, e.clientY);
    if (!coords) return;
    const { gx, gy } = coords;
    const me = playersRef.current.get(playerId);
    if (!me) return;
    const myIdx = playerIndexRef.current.get(playerId);
    if (myIdx === undefined) return;
    const i = gy * GRID_W + gx;
    const grid = ownerGridRef.current;
    const mask = landMaskRef.current;
    if (!mask) return;
    if (!mask[i]) { showNotif("Click a land cube"); return; }

    // Count my cubes
    let mineCount = 0;
    for (let k = 0; k < grid.length; k++) if (grid[k] === myIdx) { mineCount++; if (mineCount > 0) break; }

    // No starter yet → plant here
    if (mineCount === 0) {
      if (grid[i] !== -1) { showNotif("Pick an unclaimed land cube to start"); return; }
      plantStarter(i, myIdx);
      setHasSpawned(true);
      showNotif("Empire founded! Click any cube to expand.", "success");
      return;
    }

    // Attack target with sendPct of my units
    if (grid[i] === myIdx) { showNotif("You already own that cube"); return; }
    const sending = Math.max(1, Math.floor(me.units * sendPctRef.current / 100));
    if (sending < COST_EMPTY) { showNotif("Not enough units", "error"); return; }

    const result = executeAttack(i, sending, myIdx, playerId, me.units);
    if (result.unreachable) { showNotif("No land path to that point", "error"); return; }
    if (result.captured === 0) { showNotif("Pressure repelled — enemy too strong", "error"); return; }
    if (!result.reachedTarget) showNotif(`Flooded ${result.captured} cells — pressure stalled short of target`, "info");
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const coords = screenToGrid(e.clientX, e.clientY);
    if (!coords) return;
    const { gx, gy } = coords;
    const myIdx = playerIndexRef.current.get(playerId);
    const i = gy * GRID_W + gx;
    const grid = ownerGridRef.current;
    const mask = landMaskRef.current;
    const isOwnTerritory = myIdx !== undefined && grid[i] === myIdx;
    const isLand = mask ? !!mask[i] : false;
    setCtxMenu({ screenX: e.clientX, screenY: e.clientY, gx, gy, isOwnTerritory, isLand });
  }

  async function doBuild(gx: number, gy: number, type: BuildingType) {
    setCtxMenu(null);
    const me = playersRef.current.get(playerId);
    if (!me) return;
    const myIdx = playerIndexRef.current.get(playerId);
    if (myIdx === undefined) return;
    const cost = BUILD_COST[type];
    if (me.units < cost) { showNotif(`Need ${cost} units to build ${type}`, "error"); return; }
    const gridIdx = gy * GRID_W + gx;
    if (ownerGridRef.current[gridIdx] !== myIdx) { showNotif("Build on your own cubes only", "error"); return; }
    if (buildingsRef.current.some((b) => b.gridIdx === gridIdx)) { showNotif("Already a building here", "error"); return; }

    const building: Building = { type, ownerIdx: myIdx, gridIdx };
    setBuildings((prev) => [...prev, building]);
    buildingsRef.current = [...buildingsRef.current, building];
    channelRef.current?.send({ type: "broadcast", event: "building", payload: building });

    const newUnits = me.units - cost;
    me.units = newUnits;
    await supabase.from("lobby_players").update({ units: newUnits }).eq("lobby_id", lobby.id).eq("player_id", playerId);
    showNotif(`${type === "fort" ? "Fort" : "Factory"} built!`, "success");
  }

  const sortedPlayers = [...players].sort((a, b) => b.pixels - a.pixels);
  const me = playersRef.current.get(playerId);
  const myIdx = playerIndexRef.current.get(playerId);
  const myCubeCount = me ? me.pixels : 0;
  const sendingUnits = me ? Math.max(1, Math.floor(me.units * sendPct / 100)) : 0;

  return (
    <div ref={containerRef} className="relative h-screen w-screen overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: "crosshair" }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      />

      {/* Starter prompt */}
      {me && myCubeCount === 0 && !hasSpawned && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 rounded-xl border border-primary/60 bg-card/95 px-6 py-4 text-center shadow-2xl backdrop-blur-md">
          <div className="text-lg font-bold text-foreground mb-1">Pick your starting cube</div>
          <div className="text-sm text-muted-foreground">Click any land cube on the map to found your empire</div>
        </div>
      )}

      {/* Leaderboard */}
      <div className="absolute right-3 top-3 w-56 rounded-xl border border-border/60 bg-card/85 p-2 shadow-lg backdrop-blur-md">
        <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Leaderboard</div>
        <div className="space-y-0.5">
          {sortedPlayers.slice(0, 10).map((p, i) => (
            <div key={p.id} className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${p.player_id === playerId ? "bg-primary/15" : ""}`}>
              <span className="w-3 text-right text-muted-foreground">{i + 1}</span>
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: p.color }} />
              <span className="flex-1 truncate font-medium">{p.name}</span>
              <span className="font-mono text-muted-foreground">{p.pixels}</span>
            </div>
          ))}
        </div>
      </div>

      <Button onClick={onLeave} variant="secondary" size="sm" className="absolute left-3 top-3 gap-1.5 bg-card/85 backdrop-blur-md">
        <LogOut className="h-3.5 w-3.5" /> Leave
      </Button>

      {/* Bottom HUD */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-4 rounded-xl border border-border/60 bg-card/90 px-5 py-2.5 backdrop-blur-md shadow-lg">
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Send</span>
          <div className="flex items-center gap-2">
            <input type="range" min={5} max={100} step={5} value={sendPct}
              onChange={e => setSendPct(+e.target.value)}
              className="w-32 accent-primary" />
            <span className="w-12 text-right font-mono text-sm font-bold text-primary">{sendPct}%</span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground">{sendingUnits} units</span>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="flex flex-col items-center gap-1 px-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Click to attack</span>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sword className="h-3 w-3" /> click any cube
          </div>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="flex gap-1">
          <button title="Zoom in"
            onClick={() => { const c = camRef.current; c.zoom = Math.min(8, c.zoom * 1.25); }}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-sm hover:bg-secondary">+</button>
          <button title="Zoom out"
            onClick={() => { const c = camRef.current; c.zoom = Math.max(0.4, c.zoom * 0.8); }}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-sm hover:bg-secondary">−</button>
          <button title="Reset view"
            onClick={() => { camRef.current = { x: 0, y: 0, zoom: 1 }; }}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-xs hover:bg-secondary">⌂</button>
        </div>
        {me && (
          <>
            <div className="h-10 w-px bg-border" />
            <div className="flex items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: me.color }} />
              <span className="font-medium">{me.name}</span>
              <span className="font-mono text-muted-foreground">{me.units}u · {me.pixels}t</span>
            </div>
            <div className="h-10 w-px bg-border" />
            <div className="flex flex-col items-center gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Build</span>
              <div className="flex flex-wrap gap-1 max-w-xs">
                {(["city","defense_post","port","fort","factory","missile_silo"] as BuildingType[]).map((btype) => {
                  const cost = BUILD_COST[btype];
                  const icons: Record<BuildingType, string> = {
                    city:"🏙", defense_post:"🛡", port:"⚓", fort:"🔶", factory:"🏭", missile_silo:"🚀"
                  };
                  const colors2: Record<BuildingType, string> = {
                    city:"amber", defense_post:"emerald", port:"cyan", fort:"orange", factory:"blue", missile_silo:"red"
                  };
                  const col = colors2[btype];
                  return (
                    <button
                      key={btype}
                      title={`${BUILDING_LABELS[btype]} — ${cost}u`}
                      disabled={me.units < cost}
                      onClick={() => {
                        const g = ownerGridRef.current;
                        const myI = playerIndexRef.current.get(playerId);
                        if (myI === undefined) return;
                        const owned2: number[] = [];
                        for (let k = 0; k < g.length; k++) if (g[k] === myI) owned2.push(k);
                        if (owned2.length === 0) { showNotif("No territory yet", "error"); return; }
                        const pick = owned2[Math.floor(Math.random() * owned2.length)];
                        doBuild(pick % GRID_W, Math.floor(pick / GRID_W), btype);
                      }}
                      className={`flex h-7 items-center gap-1 rounded border border-${col}-500/50 bg-${col}-500/10 px-2 text-xs text-${col}-400 hover:bg-${col}-500/20 disabled:opacity-40 disabled:cursor-not-allowed`}>
                      {icons[btype]} <span className="hidden sm:inline">{BUILDING_LABELS[btype]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[200px] overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
          style={{ top: ctxMenu.screenY, left: ctxMenu.screenX }}
        >
          <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
            Cube ({ctxMenu.gx}, {ctxMenu.gy})
          </div>

          {ctxMenu.isLand && !ctxMenu.isOwnTerritory && (
            <button onClick={() => {
              setCtxMenu(null);
              const meNow = playersRef.current.get(playerId);
              const myIdxNow = playerIndexRef.current.get(playerId);
              if (!meNow || myIdxNow === undefined) return;
              const sending = Math.max(1, Math.floor(meNow.units * sendPctRef.current / 100));
              const i = ctxMenu.gy * GRID_W + ctxMenu.gx;
              const r = executeAttack(i, sending, myIdxNow, playerId, meNow.units);
              if (r.unreachable) showNotif("No land path to that cube", "error");
              else if (r.captured === 0) showNotif("Attack repelled", "error");
              else showNotif(`Captured ${r.captured} cubes`, "success");
            }}
              className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-secondary text-left transition-colors">
              <span className="flex items-center gap-2"><Sword className="h-3.5 w-3.5" /> Attack</span>
              <span className="text-xs text-muted-foreground">{sendingUnits}u</span>
            </button>
          )}

          {ctxMenu.isOwnTerritory && (
            <>
              <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-t border-border flex items-center gap-1.5">
                <Hammer className="h-3 w-3" /> Build
              </div>
              <button
                disabled={!me || me.units < BUILD_COST.fort}
                onClick={() => doBuild(ctxMenu.gx, ctxMenu.gy, "fort")}
                className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-secondary text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <span className="flex items-center gap-2"><Shield className="h-3.5 w-3.5 text-amber-400" /> Fort <span className="text-[10px] text-muted-foreground">(3× defense)</span></span>
                <span className="text-xs text-muted-foreground">{BUILD_COST.fort}u</span>
              </button>
              <button
                disabled={!me || me.units < BUILD_COST.factory}
                onClick={() => doBuild(ctxMenu.gx, ctxMenu.gy, "factory")}
                className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-secondary text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <span className="flex items-center gap-2"><Factory className="h-3.5 w-3.5 text-blue-400" /> Factory <span className="text-[10px] text-muted-foreground">(+{FACTORY_INCOME} income)</span></span>
                <span className="text-xs text-muted-foreground">{BUILD_COST.factory}u</span>
              </button>
            </>
          )}

          {!ctxMenu.isLand && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Ocean — no actions</div>
          )}
        </div>
      )}

      {/* suppress unused warnings for myIdx */}
      <span className="hidden">{myIdx}</span>
    </div>
  );
}
