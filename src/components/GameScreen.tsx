import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { GRID_W, GRID_H, MAPS } from "@/game/constants";
import { loadLandMask } from "@/game/landMask";
import worldMap from "@/assets/map-world.jpg";
import { Button } from "@/components/ui/button";
import { LogOut, Anchor, Shield, Factory, Handshake, Zap, Hand } from "lucide-react";
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

// Building types
type BuildingType = "fort" | "factory" | "port";
type Building = {
  type: BuildingType;
  ownerIdx: number;
  gridIdx: number;
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

const DIFFICULTY_SPEED: Record<string, number> = {
  relaxed: 0.4,
  balanced: 0.7,
  intense: 1.1,
};

// How many units one tile claim costs (drains your army as you expand)
const COST_PER_CLAIM = 0.35;
// Cooldown between expansion waves (ms) — gives "pulse" feel
const ATTACK_INTERVAL_MS = 600;

// Building costs in units
const BUILD_COST: Record<BuildingType, number> = {
  fort: 150,      // Defense bonus — slows enemy capture
  factory: 200,   // Unit production bonus
  port: 250,      // Enables naval invasions from this tile
};

// Building bonuses
const FORT_DEFENSE = 3.0;    // multiplier making fort tiles very hard to capture
const FACTORY_BONUS = 2.5;   // extra units per tick from factory tile

type CtxMenu = {
  screenX: number;
  screenY: number;
  gx: number;
  gy: number;
  isOwnTerritory: boolean;
  isLand: boolean;
  nearOwnPort: boolean;
  enemyPlayerId: string | null; // for alliance proposals
} | null;

// Naval invasion mode state
type NavalMode = {
  active: boolean;
  portIdx: number; // source port grid index
} | null;

function findSpreadSpawns(mask: Uint8Array, count: number): number[] {
  const candidates: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) candidates.push(i);
  }
  if (candidates.length === 0) return [];

  const chosen: number[] = [];
  const minDist = Math.floor(Math.min(GRID_W, GRID_H) * 0.15);

  let attempts = 0;
  while (chosen.length < count && attempts < 50000) {
    attempts++;
    const idx = candidates[Math.floor(Math.random() * candidates.length)];
    const x = idx % GRID_W;
    const y = Math.floor(idx / GRID_W);
    let ok = true;
    for (const c of chosen) {
      const cx = c % GRID_W;
      const cy = Math.floor(c / GRID_W);
      if (Math.hypot(x - cx, y - cy) < minDist) { ok = false; break; }
    }
    if (ok) chosen.push(idx);
  }
  return chosen;
}

// Find nearest coast tile owned by player (adjacent to ocean)
function findOwnedCoast(
  mask: Uint8Array,
  grid: Int16Array,
  ownerIdx: number,
  fromX: number,
  fromY: number
): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== ownerIdx) continue;
    const x = i % GRID_W;
    const y = Math.floor(i / GRID_W);
    // Check if adjacent to ocean
    const isCoast = [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => {
      const nx = x + dx; const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) return true;
      return !mask[ny * GRID_W + nx];
    });
    if (!isCoast) continue;
    const dist = Math.hypot(x - fromX, y - fromY);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

// Check if a grid index is near (within range) a player's port
function isNearPort(
  buildings: Building[],
  gridIdx: number,
  ownerIdx: number,
  range = 30
): boolean {
  const tx = gridIdx % GRID_W;
  const ty = Math.floor(gridIdx / GRID_W);
  return buildings.some((b) => {
    if (b.type !== "port" || b.ownerIdx !== ownerIdx) return false;
    const bx = b.gridIdx % GRID_W;
    const by = Math.floor(b.gridIdx / GRID_W);
    return Math.hypot(tx - bx, ty - by) <= range;
  });
}

export function GameScreen({ lobby, playerId, onLeave }: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [tick, setTick] = useState(0);
  const [sendPct, setSendPct] = useState(50);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null);
  const [navalMode, setNavalMode] = useState<NavalMode>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [notification, setNotification] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(true);
  const [allies, setAllies] = useState<string[]>([]); // playerIds we are allied with
  const [pendingAlliances, setPendingAlliances] = useState<string[]>([]); // incoming proposals
  const [attackCooldown, setAttackCooldown] = useState(0); // 0..1 progress until next pulse

  const sendPctRef = useRef(50);
  const navalModeRef = useRef<NavalMode>(null);
  const buildingsRef = useRef<Building[]>([]);
  const autoModeRef = useRef(true);
  const alliesRef = useRef<string[]>([]);
  const lastAttackRef = useRef<number>(0);

  useEffect(() => { sendPctRef.current = sendPct; }, [sendPct]);
  useEffect(() => { navalModeRef.current = navalMode; }, [navalMode]);
  useEffect(() => { buildingsRef.current = buildings; }, [buildings]);
  useEffect(() => { autoModeRef.current = autoMode; }, [autoMode]);
  useEffect(() => { alliesRef.current = allies; }, [allies]);

  function showNotif(msg: string) {
    setNotification(msg);
    toast(msg);
    setTimeout(() => setNotification(null), 2500);
  }


  const ownerGridRef = useRef<Int16Array>(new Int16Array(GRID_W * GRID_H).fill(-1));
  const landMaskRef = useRef<Uint8Array | null>(null);
  const playersRef = useRef<Map<string, LobbyPlayer>>(new Map());
  const playerIndexRef = useRef<Map<string, number>>(new Map());
  const colorsRef = useRef<[number, number, number][]>([]);
  const lastTickRef = useRef<number>(performance.now());
  const lastSyncRef = useRef<number>(0);
  const lastBotMoveRef = useRef<number>(0);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const spawnedRef = useRef(false);

  const camRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; camX: number; camY: number }>({
    active: false, startX: 0, startY: 0, camX: 0, camY: 0,
  });
  // Track whether a drag occurred to distinguish click vs pan
  const dragMovedRef = useRef(false);

  // Map render rect is computed fresh each frame from canvas size + camera
  // We store it so click handlers can read it synchronously
  const mapRectRef = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // Compute map rect from current canvas size (no camera offset — just base layout)
  const getMapRect = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0, w: 0, h: 0 };
    const w = canvas.width;
    const h = canvas.height;
    const mapRatio = 1920 / 960;
    const canvasRatio = w / h;
    let mw: number, mh: number, mx: number, my: number;
    if (canvasRatio > mapRatio) { mh = h; mw = h * mapRatio; mx = (w - mw) / 2; my = 0; }
    else { mw = w; mh = w / mapRatio; mx = 0; my = (h - mh) / 2; }
    return { x: mx, y: my, w: mw, h: mh };
  }, []);

  // Convert screen coords → grid coords, accounting for camera + devicePixelRatio
  const screenToGrid = useCallback((sx: number, sy: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    // Physical pixels
    const px = (sx - rect.left) * devicePixelRatio;
    const py = (sy - rect.top) * devicePixelRatio;
    const cam = camRef.current;
    // Undo camera translate + scale
    const wx = (px - cam.x) / cam.zoom;
    const wy = (py - cam.y) / cam.zoom;
    // Undo map layout offset
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
        setBuildings((prev) => {
          if (prev.some((x) => x.gridIdx === b.gridIdx)) return prev;
          return [...prev, b];
        });
        buildingsRef.current = [...buildingsRef.current, b];
      })
      .on("broadcast", { event: "alliance" }, ({ payload }) => {
        const { from, to, action } = payload as { from: string; to: string; action: "propose" | "accept" | "break" };
        if (to !== playerId) return;
        if (action === "propose") {
          setPendingAlliances((prev) => prev.includes(from) ? prev : [...prev, from]);
          const fromName = playersRef.current.get(from)?.name ?? "Player";
          toast(`${fromName} proposes alliance — right-click their dot to accept`);
        } else if (action === "accept") {
          setAllies((prev) => prev.includes(from) ? prev : [...prev, from]);
          const fromName = playersRef.current.get(from)?.name ?? "Player";
          toast.success(`Alliance with ${fromName} formed!`);
        } else if (action === "break") {
          setAllies((prev) => prev.filter((x) => x !== from));
          setPendingAlliances((prev) => prev.filter((x) => x !== from));
          toast(`Alliance broken`);
        }
      })
      .subscribe();
    channelRef.current = ch;
    return () => { active = false; supabase.removeChannel(ch); channelRef.current = null; };
  }, [lobby.id]);

  useEffect(() => {
    loadLandMask().then((m) => { landMaskRef.current = m; });
  }, []);

  // Spawn all players (host only)
  useEffect(() => {
    if (lobby.host_id !== playerId || spawnedRef.current) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      const mask = landMaskRef.current;
      if (!mask || playersRef.current.size === 0) return;
      if (spawnedRef.current) { clearInterval(interval); return; }
      spawnedRef.current = true;
      clearInterval(interval);

      const allPlayers = [...playersRef.current.values()];
      const spawns = findSpreadSpawns(mask, allPlayers.length);
      const grid = ownerGridRef.current;
      const claims: { i: number; o: number }[] = [];

      for (let pi = 0; pi < allPlayers.length; pi++) {
        const p = allPlayers[pi];
        const spawn = spawns[pi];
        if (spawn === undefined) continue;
        const myIdx = playerIndexRef.current.get(p.player_id);
        if (myIdx === undefined) continue;
        const sx = spawn % GRID_W;
        const sy = Math.floor(spawn / GRID_W);
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const x = sx + dx; const y = sy + dy;
            if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
            const i = y * GRID_W + x;
            if (mask[i] && grid[i] === -1) { grid[i] = myIdx; claims.push({ i, o: myIdx }); }
          }
        }
        if (cancelled) return;
        await supabase.from("lobby_players")
          .update({ dot_x: sx / GRID_W, dot_y: sy / GRID_H })
          .eq("lobby_id", lobby.id).eq("player_id", p.player_id);
      }
      if (claims.length > 0)
        channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });
    }, 400);
    return () => { cancelled = true; clearInterval(interval); };
  }, [lobby.id, lobby.host_id, playerId]);

  // Render + simulation loop
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
      // Keep mapRect in sync immediately after resize
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

    // Per-player accumulated unit cost from the current attack pulse
    const pulseSpend = new Map<string, number>();
    const speed = DIFFICULTY_SPEED[lobby.difficulty] ?? 1;
    let lastUiCooldown = 0;

    function simulate(_dt: number) {
      void _dt;
      const mask = landMaskRef.current;
      if (!mask) return;
      const grid = ownerGridRef.current;
      const colors = colorsRef.current;
      if (colors.length === 0) return;
      const blds = buildingsRef.current;

      const now = performance.now();
      // Pulse cooldown progress (used by UI)
      const since = now - lastAttackRef.current;
      const progress = Math.min(1, since / ATTACK_INTERVAL_MS);
      if (Math.abs(progress - lastUiCooldown) > 0.08) {
        lastUiCooldown = progress;
        setAttackCooldown(progress);
      }
      if (since < ATTACK_INTERVAL_MS) return;
      lastAttackRef.current = now;
      pulseSpend.clear();


      const claims: { i: number; o: number }[] = [];
      const ally = alliesRef.current;
      const myPid = playerId;
      const localAuto = autoModeRef.current;

      playersRef.current.forEach((p) => {
        if (!p.alive) return;
        const myIdx = playerIndexRef.current.get(p.player_id);
        if (myIdx === undefined) return;

        // Human in manual mode does NOT auto-expand — only attacks via context menu
        if (p.player_id === myPid && !localAuto) return;

        // Strength scales with army size, but is much gentler than before.
        // Also capped so big empires don't snowball as fast.
        const sizeFactor = Math.sqrt(Math.max(1, p.units)) / 6;
        const strength = Math.min(14, sizeFactor * speed);
        // Each "attempt" is one tile-claim attempt that costs COST_PER_CLAIM units on success
        const attempts = Math.floor(strength) + (Math.random() < strength % 1 ? 1 : 0);
        if (attempts <= 0) return;

        // How many units this player can spend this pulse (cap at 30% of army)
        const budget = Math.max(1, Math.floor(p.units * 0.3));
        let spent = 0;

        const dotX = Math.floor(p.dot_x * GRID_W);
        const dotY = Math.floor(p.dot_y * GRID_H);

        for (let a = 0; a < attempts; a++) {
          if (spent >= budget) break;
          let sx: number, sy: number;
          if (Math.random() < 0.5) {
            // Expand from near the dot — feels like troops marching from the leader
            sx = dotX + Math.floor((Math.random() - 0.5) * 8);
            sy = dotY + Math.floor((Math.random() - 0.5) * 8);
          } else {
            let found = -1;
            for (let t = 0; t < 40; t++) {
              const ti = Math.floor(Math.random() * grid.length);
              if (grid[ti] === myIdx) { found = ti; break; }
            }
            if (found === -1) continue;
            sx = found % GRID_W;
            sy = Math.floor(found / GRID_W);
          }
          const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
          const d = dirs[Math.floor(Math.random() * dirs.length)];
          const nx = sx + d[0]; const ny = sy + d[1];
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const ni = ny * GRID_W + nx;
          if (!mask[ni]) continue;
          const cur = grid[ni];
          if (cur === myIdx) continue;
          // Don't claim allied tiles (only check from human player's POV; bots ignore)
          if (cur >= 0 && p.player_id === myPid) {
            const enemyEntry = [...playerIndexRef.current.entries()].find(([, v]) => v === cur);
            if (enemyEntry && ally.includes(enemyEntry[0])) continue;
          }
          if (cur === -1) {
            grid[ni] = myIdx;
            claims.push({ i: ni, o: myIdx });
            spent += COST_PER_CLAIM;
          } else {
            const defEntry = [...playerIndexRef.current.entries()].find(([, v]) => v === cur);
            const def = defEntry ? playersRef.current.get(defEntry[0]) : null;
            if (!def) continue;
            const hasFort = blds.some((b) => b.type === "fort" && b.gridIdx === ni);
            const defBonus = hasFort ? FORT_DEFENSE : 1;
            if (p.units > def.units * 1.4 * defBonus && Math.random() < 0.18) {
              grid[ni] = myIdx;
              claims.push({ i: ni, o: myIdx });
              spent += COST_PER_CLAIM * 2; // contested tiles cost more
            }
          }
        }
        if (spent > 0) pulseSpend.set(p.player_id, spent);
      });

      // Apply unit drain to local mirror (DB sync happens in syncStats)
      pulseSpend.forEach((cost, pid) => {
        const pl = playersRef.current.get(pid);
        if (pl) pl.units = Math.max(0, pl.units - Math.round(cost));
      });

      if (claims.length > 0)
        channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });
    }

    async function syncStats() {
      if (lobby.host_id !== playerId) return;
      const grid = ownerGridRef.current;
      const blds = buildingsRef.current;
      const counts = new Array(colorsRef.current.length).fill(0);
      for (let i = 0; i < grid.length; i++) { const o = grid[i]; if (o >= 0) counts[o]++; }

      // Factory bonus: each factory adds FACTORY_BONUS units per sync
      const factoryBonus = new Array(colorsRef.current.length).fill(0);
      blds.forEach((b) => {
        if (b.type === "factory") factoryBonus[b.ownerIdx] = (factoryBonus[b.ownerIdx] || 0) + FACTORY_BONUS;
      });

      const updates: Promise<unknown>[] = [];
      playersRef.current.forEach((p) => {
        const idx = playerIndexRef.current.get(p.player_id);
        if (idx === undefined) return;
        const px = counts[idx] ?? 0;
        const base = Math.max(1, Math.round(px / 3));
        const bonus = Math.round(factoryBonus[idx] || 0);
        const newUnits = Math.min(9999, p.units + base + bonus);
        const alive = px > 0 || p.units > 0;
        updates.push(Promise.resolve(supabase.from("lobby_players")
          .update({ pixels: px, units: newUnits, alive })
          .eq("lobby_id", lobby.id).eq("player_id", p.player_id)));
      });
      await Promise.all(updates);
    }

    // Building icons via canvas (simple symbols)
    function drawBuildingIcon(x: number, y: number, type: BuildingType, color: string) {
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.lineWidth = 1.5;
      if (type === "fort") {
        // Shield shape
        ctx.beginPath();
        ctx.moveTo(x, y - 8);
        ctx.lineTo(x + 7, y - 4);
        ctx.lineTo(x + 7, y + 3);
        ctx.lineTo(x, y + 8);
        ctx.lineTo(x - 7, y + 3);
        ctx.lineTo(x - 7, y - 4);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      } else if (type === "factory") {
        // Gear-ish square
        ctx.fillRect(x - 7, y - 7, 14, 14);
        ctx.strokeRect(x - 7, y - 7, 14, 14);
        // Chimney
        ctx.fillRect(x - 4, y - 12, 3, 6);
        ctx.strokeRect(x - 4, y - 12, 3, 6);
      } else if (type === "port") {
        // Anchor symbol
        ctx.beginPath();
        ctx.arc(x, y - 4, 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8);
        ctx.moveTo(x - 6, y + 4); ctx.lineTo(x + 6, y + 4);
        ctx.moveTo(x - 6, y + 4);
        ctx.quadraticCurveTo(x - 8, y + 8, x, y + 8);
        ctx.moveTo(x + 6, y + 4);
        ctx.quadraticCurveTo(x + 8, y + 8, x, y + 8);
        ctx.stroke();
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
      mapRectRef.current = mr; // keep in sync every frame
      const { x: mx, y: my, w: mw, h: mh } = mr;

      const cam = camRef.current;
      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.zoom, cam.zoom);

      if (bgImg.complete) ctx.drawImage(bgImg, mx, my, mw, mh);
      else { ctx.fillStyle = "#1a3050"; ctx.fillRect(mx, my, mw, mh); }

      // Territory overlay
      const grid = ownerGridRef.current;
      const colors = colorsRef.current;
      const data = imgData.data;
      for (let i = 0; i < grid.length; i++) {
        const o = grid[i];
        if (o < 0 || !colors[o]) { data[i * 4 + 3] = 0; }
        else {
          const c = colors[o];
          data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2];
          data[i * 4 + 3] = 165;
        }
      }
      offCtx.putImageData(imgData, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low";
      ctx.drawImage(off, mx, my, mw, mh);

      // Draw buildings
      const blds = buildingsRef.current;
      blds.forEach((b) => {
        const bx = (b.gridIdx % GRID_W) / GRID_W;
        const by = Math.floor(b.gridIdx / GRID_W) / GRID_H;
        const px = mx + bx * mw;
        const py = my + by * mh;
        const ownerEntry = [...playerIndexRef.current.entries()].find(([, v]) => v === b.ownerIdx);
        const owner = ownerEntry ? playersRef.current.get(ownerEntry[0]) : null;
        drawBuildingIcon(px, py, b.type, owner?.color ?? "#fff");
      });

      // Naval mode highlight: show own coast + valid landing zones
      const naval = navalModeRef.current;
      if (naval?.active) {
        const mask = landMaskRef.current;
        if (mask) {
          const myIdx = playerIndexRef.current.get(playerId);
          if (myIdx !== undefined) {
            ctx.save();
            // Pulse
            const alpha = 0.3 + 0.2 * Math.sin(performance.now() / 300);
            ctx.fillStyle = `rgba(0,200,255,${alpha})`;
            for (let i = 0; i < grid.length; i++) {
              // Highlight enemy/neutral coast reachable by sea
              if (grid[i] === myIdx) continue;
              if (!mask[i]) continue;
              const x = i % GRID_W; const y = Math.floor(i / GRID_W);
              const isCoast = [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => {
                const nx2 = x+dx; const ny2 = y+dy;
                if (nx2<0||ny2<0||nx2>=GRID_W||ny2>=GRID_H) return false;
                return !mask[ny2*GRID_W+nx2];
              });
              if (!isCoast) continue;
              const px2 = mx + (x / GRID_W) * mw;
              const py2 = my + (y / GRID_H) * mh;
              const cellW = mw / GRID_W;
              const cellH = mh / GRID_H;
              ctx.fillRect(px2, py2, cellW, cellH);
            }
            ctx.restore();
          }
        }
      }

      const t = performance.now();
      playersRef.current.forEach((p) => {
        if (!p.alive) return;
        const px = mx + p.dot_x * mw;
        const py = my + p.dot_y * mh;
        const isMe = p.player_id === playerId;

        if (isMe) {
          for (let r = 0; r < 3; r++) {
            const phase = ((t / 700) + r / 3) % 1;
            const alpha = (1 - phase) * 0.55;
            const radius = 14 + phase * 35;
            ctx.beginPath();
            ctx.arc(px, py, radius, 0, Math.PI * 2);
            ctx.strokeStyle = `${p.color}${Math.floor(alpha * 255).toString(16).padStart(2, "0")}`;
            ctx.lineWidth = 2.5;
            ctx.stroke();
          }
        }

        ctx.beginPath();
        ctx.arc(px, py, 14, 0, Math.PI * 2);
        ctx.fillStyle = `${p.color}44`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(px, py, isMe ? 9 : 7, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Alliance shield ring
        if (!isMe && alliesRef.current.includes(p.player_id)) {
          ctx.beginPath();
          ctx.arc(px, py, 12, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(120,200,255,0.95)";
          ctx.lineWidth = 2;
          ctx.setLineDash([3, 2]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        ctx.beginPath();
        ctx.arc(px, py, isMe ? 3.5 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fill();

        ctx.font = `bold ${isMe ? 11 : 9}px ui-sans-serif, system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.strokeStyle = "rgba(0,0,0,0.9)";
        ctx.lineWidth = 3;
        ctx.strokeText(String(p.units), px, py - 12);
        ctx.fillStyle = "white";
        ctx.fillText(String(p.units), px, py - 12);

        if (isMe) {
          ctx.font = `bold 9px ui-sans-serif, system-ui`;
          ctx.fillStyle = "rgba(255,255,255,0.7)";
          ctx.fillText(p.name, px, py - 23);
        }
      });

      ctx.restore();
    }

    function loop(now: number) {
      const dt = Math.min(now - lastTickRef.current, 100);
      lastTickRef.current = now;
      simulate(dt);
      render();

      if (now - lastSyncRef.current > 1500) { lastSyncRef.current = now; syncStats(); }

      if (lobby.host_id === playerId && now - lastBotMoveRef.current > 3500) {
        lastBotMoveRef.current = now;
        const mask = landMaskRef.current;
        if (mask) {
          const grid = ownerGridRef.current;
          playersRef.current.forEach(async (bot) => {
            if (!bot.is_bot || !bot.alive) return;
            const idx = playerIndexRef.current.get(bot.player_id);
            if (idx === undefined) return;
            const frontier: number[] = [];
            for (let i = 0; i < grid.length; i++) {
              if (grid[i] !== idx) continue;
              const x = i % GRID_W; const y = Math.floor(i / GRID_W);
              const hasEdge = [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => {
                const nx2 = x+dx; const ny2 = y+dy;
                if (nx2<0||ny2<0||nx2>=GRID_W||ny2>=GRID_H) return false;
                return grid[ny2*GRID_W+nx2] !== idx;
              });
              if (hasEdge) frontier.push(i);
            }
            if (frontier.length === 0) return;
            const pick = frontier[Math.floor(Math.random() * frontier.length)];
            await supabase.from("lobby_players")
              .update({ dot_x: (pick % GRID_W) / GRID_W, dot_y: Math.floor(pick / GRID_W) / GRID_H })
              .eq("lobby_id", lobby.id).eq("player_id", bot.player_id);
          });
        }
      }

      if (Math.floor(now / 500) !== Math.floor((now - dt) / 500)) setTick((t) => t + 1);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    // Zoom with wheel
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const r = canvas!.getBoundingClientRect();
      const mx2 = (e.clientX - r.left) * devicePixelRatio;
      const my2 = (e.clientY - r.top) * devicePixelRatio;
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const cam = camRef.current;
      const newZoom = Math.min(6, Math.max(0.4, cam.zoom * factor));
      cam.x = mx2 - (mx2 - cam.x) * (newZoom / cam.zoom);
      cam.y = my2 - (my2 - cam.y) * (newZoom / cam.zoom);
      cam.zoom = newZoom;
    }

    // Middle mouse / right mouse drag
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
  }, [lobby.id, lobby.host_id, lobby.difficulty, playerId]);

  // LEFT CLICK — move dot to own land OR execute naval invasion if in naval mode
  function handleClick(e: React.MouseEvent) {
    // Ignore if this was the end of a pan drag
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

    // Naval invasion click
    const naval = navalModeRef.current;
    if (naval?.active) {
      // Must click on enemy/neutral coast or inland
      if (!mask || !mask[i]) { showNotif("Click an enemy coastline to invade"); return; }
      if (grid[i] === myIdx) { showNotif("That's your own territory"); return; }
      doNavalInvasion(gx, gy, naval.portIdx);
      setNavalMode(null);
      return;
    }

    // Normal click: must click own territory to move dot
    if (grid[i] !== myIdx) {
      // Show hint instead of silently failing
      showNotif("Click your own territory (colored) to move your dot");
      return;
    }

    me.dot_x = gx / GRID_W;
    me.dot_y = gy / GRID_H;
    supabase.from("lobby_players")
      .update({ dot_x: me.dot_x, dot_y: me.dot_y })
      .eq("lobby_id", lobby.id).eq("player_id", playerId);
  }

  // RIGHT CLICK — context menu with context-aware options
  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if (navalModeRef.current?.active) { setNavalMode(null); return; }

    const coords = screenToGrid(e.clientX, e.clientY);
    if (!coords) return;
    const { gx, gy } = coords;
    const myIdx = playerIndexRef.current.get(playerId);
    const i = gy * GRID_W + gx;
    const grid = ownerGridRef.current;
    const mask = landMaskRef.current;

    const isOwnTerritory = myIdx !== undefined && grid[i] === myIdx;
    const isLand = mask ? !!mask[i] : false;
    const nearOwnPort = myIdx !== undefined && isNearPort(buildingsRef.current, i, myIdx);

    // Find nearest enemy dot within ~6 grid cells for alliance proposals
    let enemyPlayerId: string | null = null;
    let bestD = 6;
    playersRef.current.forEach((p) => {
      if (p.player_id === playerId || !p.alive) return;
      const px = p.dot_x * GRID_W;
      const py = p.dot_y * GRID_H;
      const d = Math.hypot(px - gx, py - gy);
      if (d < bestD) { bestD = d; enemyPlayerId = p.player_id; }
    });

    setCtxMenu({ screenX: e.clientX, screenY: e.clientY, gx, gy, isOwnTerritory, isLand, nearOwnPort, enemyPlayerId });
  }

  // Alliance helpers
  function proposeAlliance(targetId: string) {
    setCtxMenu(null);
    channelRef.current?.send({ type: "broadcast", event: "alliance", payload: { from: playerId, to: targetId, action: "propose" } });
    showNotif("Alliance proposed");
  }
  function acceptAlliance(targetId: string) {
    setCtxMenu(null);
    setAllies((prev) => prev.includes(targetId) ? prev : [...prev, targetId]);
    setPendingAlliances((prev) => prev.filter((x) => x !== targetId));
    channelRef.current?.send({ type: "broadcast", event: "alliance", payload: { from: playerId, to: targetId, action: "accept" } });
    showNotif("Alliance formed");
  }
  function breakAlliance(targetId: string) {
    setCtxMenu(null);
    setAllies((prev) => prev.filter((x) => x !== targetId));
    channelRef.current?.send({ type: "broadcast", event: "alliance", payload: { from: playerId, to: targetId, action: "break" } });
    showNotif("Alliance broken");
  }


  // Attack from context menu
  async function doAttack(gx: number, gy: number) {
    setCtxMenu(null);
    const me = playersRef.current.get(playerId);
    if (!me || !me.alive) return;
    const myIdx = playerIndexRef.current.get(playerId);
    if (myIdx === undefined) return;
    const i = gy * GRID_W + gx;
    const grid = ownerGridRef.current;
    const targetOwnerIdx = grid[i];

    if (targetOwnerIdx === myIdx || targetOwnerIdx === -1) return;

    const defEntry = [...playerIndexRef.current.entries()].find(([, v]) => v === targetOwnerIdx);
    const def = defEntry ? playersRef.current.get(defEntry[0]) : null;
    if (!def) return;

    // Block attacks on allies
    if (alliesRef.current.includes(def.player_id)) {
      showNotif(`${def.name} is your ally — break alliance first`);
      return;
    }

    const sending = Math.max(1, Math.floor(me.units * sendPctRef.current / 100));
    const mask = landMaskRef.current;
    const hasFort = buildingsRef.current.some((b) => b.type === "fort" && b.gridIdx === i);
    const defBonus = hasFort ? FORT_DEFENSE : 1;

    const claims: { i: number; o: number }[] = [];
    if (mask && sending > def.units * 1.4 * defBonus) {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = gx + dx; const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const ni = ny * GRID_W + nx;
          if (mask[ni] && grid[ni] === targetOwnerIdx) { grid[ni] = myIdx; claims.push({ i: ni, o: myIdx }); }
        }
      }
      if (claims.length > 0)
        channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });
    } else if (sending <= def.units * 1.4 * defBonus) {
      showNotif(hasFort ? "Enemy fort is heavily fortified! Need more units." : "Need more units to attack!");
    }

    const newMyUnits = Math.max(1, me.units - sending);
    await supabase.from("lobby_players").update({ units: newMyUnits }).eq("lobby_id", lobby.id).eq("player_id", playerId);
  }

  // Build a structure
  async function doBuild(gx: number, gy: number, type: BuildingType) {
    setCtxMenu(null);
    const me = playersRef.current.get(playerId);
    if (!me) return;
    const myIdx = playerIndexRef.current.get(playerId);
    if (myIdx === undefined) return;
    const cost = BUILD_COST[type];
    if (me.units < cost) { showNotif(`Need ${cost} units to build ${type}`); return; }
    const gridIdx = gy * GRID_W + gx;
    if (buildingsRef.current.some((b) => b.gridIdx === gridIdx)) { showNotif("Already a building here"); return; }

    const building: Building = { type, ownerIdx: myIdx, gridIdx };
    setBuildings((prev) => [...prev, building]);
    buildingsRef.current = [...buildingsRef.current, building];
    channelRef.current?.send({ type: "broadcast", event: "building", payload: building });

    const newUnits = me.units - cost;
    await supabase.from("lobby_players").update({ units: newUnits }).eq("lobby_id", lobby.id).eq("player_id", playerId);
    showNotif(`${type.charAt(0).toUpperCase() + type.slice(1)} built!`);
  }

  // Naval invasion: launch troops from a port to enemy coast
  async function doNavalInvasion(targetGx: number, targetGy: number, portIdx: number) {
    const me = playersRef.current.get(playerId);
    if (!me || !me.alive) return;
    const myIdx = playerIndexRef.current.get(playerId);
    if (myIdx === undefined) return;

    const sending = Math.max(1, Math.floor(me.units * sendPctRef.current / 100));
    const mask = landMaskRef.current;
    if (!mask) return;

    const grid = ownerGridRef.current;
    const claims: { i: number; o: number }[] = [];

    // Claim a beachhead around the target
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const nx = targetGx + dx; const ny = targetGy + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const ni = ny * GRID_W + nx;
        if (!mask[ni]) continue;
        const cur = grid[ni];
        if (cur === myIdx) continue;
        // Check fort
        const hasFort = buildingsRef.current.some((b) => b.type === "fort" && b.gridIdx === ni);
        const defBonus = hasFort ? FORT_DEFENSE : 1;
        const defEntry = cur >= 0 ? [...playerIndexRef.current.entries()].find(([, v]) => v === cur) : null;
        const def = defEntry ? playersRef.current.get(defEntry[0]) : null;
        if (cur === -1 || (def && sending > def.units * 1.2 * defBonus)) {
          grid[ni] = myIdx;
          claims.push({ i: ni, o: myIdx });
        }
      }
    }

    if (claims.length === 0) { showNotif("Naval invasion failed — too well defended!"); return; }
    channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });

    // Move dot to beachhead
    const me2 = playersRef.current.get(playerId);
    if (me2) {
      me2.dot_x = targetGx / GRID_W;
      me2.dot_y = targetGy / GRID_H;
    }
    const newUnits = Math.max(1, me.units - sending);
    await supabase.from("lobby_players")
      .update({ units: newUnits, dot_x: targetGx / GRID_W, dot_y: targetGy / GRID_H })
      .eq("lobby_id", lobby.id).eq("player_id", playerId);

    showNotif(`Naval invasion landed! Claimed ${claims.length} tiles.`);
  }

  // Initiate naval invasion mode (pick a port first)
  function startNavalMode() {
    setCtxMenu(null);
    const myIdx = playerIndexRef.current.get(playerId);
    if (myIdx === undefined) return;
    const myPorts = buildingsRef.current.filter((b) => b.type === "port" && b.ownerIdx === myIdx);
    if (myPorts.length === 0) { showNotif("Build a port first!"); return; }
    // Use first port for simplicity; could show picker
    setNavalMode({ active: true, portIdx: myPorts[0].gridIdx });
    showNotif("Naval invasion mode: click enemy coast to land");
  }

  const sortedPlayers = [...players].sort((a, b) => b.pixels - a.pixels);
  const me = playersRef.current.get(playerId);
  const myIdx = playerIndexRef.current.get(playerId);
  const myBuildings = buildings.filter((b) => b.ownerIdx === myIdx);
  const myPorts = myBuildings.filter((b) => b.type === "port");

  return (
    <div ref={containerRef} className="relative h-screen w-screen overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: navalMode?.active ? "crosshair" : ctxMenu ? "default" : "crosshair" }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      />

      {/* Naval mode banner */}
      {navalMode?.active && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-cyan-400/60 bg-cyan-950/90 px-5 py-2.5 text-cyan-300 text-sm font-semibold shadow-lg backdrop-blur-md">
          <Anchor className="h-4 w-4" />
          Naval invasion mode — click enemy coast to land troops
          <button onClick={() => setNavalMode(null)} className="ml-2 text-cyan-400 hover:text-white text-xs underline">Cancel</button>
        </div>
      )}

      {/* Notification toast */}
      {notification && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 rounded-xl border border-border/60 bg-card/95 px-5 py-2 text-sm text-foreground shadow-lg backdrop-blur-md pointer-events-none">
          {notification}
        </div>
      )}

      {/* Leaderboard */}
      <div className="absolute right-3 top-3 w-56 rounded-xl border border-border/60 bg-card/85 p-2 shadow-lg backdrop-blur-md">
        <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Leaderboard</div>
        <div className="space-y-0.5">
          {sortedPlayers.slice(0, 10).map((p, i) => (
            <div key={p.id} className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${p.player_id === playerId ? "bg-primary/15" : ""}`}>
              <span className="w-3 text-right text-muted-foreground">{i + 1}</span>
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />
              <span className="flex-1 truncate font-medium">{p.name}</span>
              <span className="font-mono text-muted-foreground">{p.pixels}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Leave */}
      <Button onClick={onLeave} variant="secondary" size="sm" className="absolute left-3 top-3 gap-1.5 bg-card/85 backdrop-blur-md">
        <LogOut className="h-3.5 w-3.5" /> Leave
      </Button>

      {/* Buildings panel (if player has buildings) */}
      {myBuildings.length > 0 && (
        <div className="absolute left-3 top-14 rounded-xl border border-border/60 bg-card/85 p-2 shadow-lg backdrop-blur-md text-xs space-y-1">
          <div className="px-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Your buildings</div>
          {myBuildings.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5 px-1 py-0.5">
              {b.type === "fort" && <Shield className="h-3 w-3 text-amber-400" />}
              {b.type === "factory" && <Factory className="h-3 w-3 text-blue-400" />}
              {b.type === "port" && <Anchor className="h-3 w-3 text-cyan-400" />}
              <span className="capitalize text-muted-foreground">{b.type}</span>
            </div>
          ))}
        </div>
      )}

      {/* Bottom bar */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-4 rounded-xl border border-border/60 bg-card/85 px-5 py-2.5 backdrop-blur-md shadow-lg">
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Force</span>
          <div className="flex items-center gap-2">
            <input type="range" min={10} max={100} step={10} value={sendPct}
              onChange={e => setSendPct(+e.target.value)}
              className="w-28 accent-primary" />
            <span className="w-10 text-right font-mono text-sm font-bold text-primary">{sendPct}%</span>
          </div>
        </div>
        <div className="h-8 w-px bg-border" />
        {/* Auto / Manual mode toggle */}
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Mode</span>
          <div className="flex overflow-hidden rounded border border-border">
            <button
              onClick={() => setAutoMode(true)}
              className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors ${autoMode ? "bg-primary text-primary-foreground" : "bg-background/60 hover:bg-secondary"}`}
            >
              <Zap className="h-3 w-3" /> Auto
            </button>
            <button
              onClick={() => setAutoMode(false)}
              className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors ${!autoMode ? "bg-primary text-primary-foreground" : "bg-background/60 hover:bg-secondary"}`}
            >
              <Hand className="h-3 w-3" /> Manual
            </button>
          </div>
        </div>
        <div className="h-8 w-px bg-border" />
        {/* Attack-pulse cooldown bar */}
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Pulse</span>
          <div className="h-2 w-24 overflow-hidden rounded-full bg-background/60 border border-border">
            <div className="h-full bg-primary transition-[width] duration-100" style={{ width: `${Math.round(attackCooldown * 100)}%` }} />
          </div>
        </div>
        <div className="h-8 w-px bg-border" />
        <div className="flex gap-1">
          <button
            onClick={() => { const c = camRef.current; c.zoom = Math.min(6, c.zoom * 1.2); }}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-sm hover:bg-secondary">+</button>
          <button
            onClick={() => { const c = camRef.current; c.zoom = Math.max(0.4, c.zoom * 0.83); }}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-sm hover:bg-secondary">−</button>
          <button
            onClick={() => { camRef.current = { x: 0, y: 0, zoom: 1 }; }}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-xs hover:bg-secondary">⌂</button>
        </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[180px] overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
          style={{ top: ctxMenu.screenY, left: ctxMenu.screenX }}
        >
          <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
            Actions
          </div>

          {/* Movement — only on own territory */}
          {ctxMenu.isOwnTerritory && (
            <button onClick={() => {
              setCtxMenu(null);
              const me2 = playersRef.current.get(playerId);
              const myIdx2 = playerIndexRef.current.get(playerId);
              if (!me2 || myIdx2 === undefined) return;
              const i = ctxMenu.gy * GRID_W + ctxMenu.gx;
              if (ownerGridRef.current[i] !== myIdx2) return;
              me2.dot_x = ctxMenu.gx / GRID_W; me2.dot_y = ctxMenu.gy / GRID_H;
              supabase.from("lobby_players").update({ dot_x: me2.dot_x, dot_y: me2.dot_y }).eq("lobby_id", lobby.id).eq("player_id", playerId);
            }}
              className="flex w-full items-center px-3 py-2 text-sm hover:bg-secondary text-left transition-colors">
              🏁 Move Here
            </button>
          )}

          {/* Attack — only on enemy territory */}
          {ctxMenu.isLand && !ctxMenu.isOwnTerritory && (
            <button onClick={() => doAttack(ctxMenu.gx, ctxMenu.gy)}
              className="flex w-full items-center px-3 py-2 text-sm hover:bg-secondary text-left transition-colors">
              ⚔️ Attack ({sendPct}%)
            </button>
          )}

          {/* Build submenu — only on own territory */}
          {ctxMenu.isOwnTerritory && (
            <>
              <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-t border-border">
                Build
              </div>
              <button onClick={() => doBuild(ctxMenu.gx, ctxMenu.gy, "fort")}
                className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-secondary text-left transition-colors">
                <span>🛡️ Fort</span>
                <span className="text-xs text-muted-foreground">{BUILD_COST.fort}u</span>
              </button>
              <button onClick={() => doBuild(ctxMenu.gx, ctxMenu.gy, "factory")}
                className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-secondary text-left transition-colors">
                <span>🏭 Factory</span>
                <span className="text-xs text-muted-foreground">{BUILD_COST.factory}u</span>
              </button>
              <button onClick={() => doBuild(ctxMenu.gx, ctxMenu.gy, "port")}
                className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-secondary text-left transition-colors">
                <span>⚓ Port</span>
                <span className="text-xs text-muted-foreground">{BUILD_COST.port}u</span>
              </button>
            </>
          )}

          {/* Naval invasion from near a port */}
          {ctxMenu.nearOwnPort && !ctxMenu.isOwnTerritory && ctxMenu.isLand && (
            <button onClick={() => {
              setCtxMenu(null);
              const myIdx2 = playerIndexRef.current.get(playerId);
              if (myIdx2 === undefined) return;
              const myPorts2 = buildingsRef.current.filter((b) => b.type === "port" && b.ownerIdx === myIdx2);
              if (myPorts2.length === 0) return;
              doNavalInvasion(ctxMenu.gx, ctxMenu.gy, myPorts2[0].gridIdx);
            }}
              className="flex w-full items-center px-3 py-2 text-sm hover:bg-secondary text-left transition-colors border-t border-border">
              ⚓ Naval Invasion ({sendPct}%)
            </button>
          )}

          <button onClick={() => setCtxMenu(null)}
            className="flex w-full items-center px-3 py-2 text-sm hover:bg-secondary text-left transition-colors border-t border-border text-muted-foreground">
            ❌ Cancel
          </button>
        </div>
      )}

      {/* Lobby code watermark */}
      <div className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 rounded-md bg-card/70 px-3 py-1 font-mono text-xs tracking-widest text-muted-foreground backdrop-blur-md">
        {lobby.code}
      </div>

      <span className="hidden">{tick}</span>
    </div>
  );
}
