import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { GRID_W, GRID_H } from "@/game/constants";
import { loadLandMask } from "@/game/landMask";
import worldMap from "@/assets/map-world.jpg";
import { Button } from "@/components/ui/button";
import { LogOut, X, Swords, Handshake, ArrowLeftRight, MessageSquare } from "lucide-react";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────────────
type Lobby = {
  id: string; code: string; host_id: string;
  map_id: string; difficulty: string;
};
type LobbyPlayer = {
  id: string; player_id: string; name: string; color: string;
  is_bot: boolean; dot_x: number; dot_y: number;
  units: number; coins: number; pixels: number; alive: boolean;
};

type BuildingType =
  | "city" | "defense_post" | "port" | "fort"
  | "factory" | "missile_silo" | "sam_launcher" | "naval_base";

type Building = { type: BuildingType; ownerIdx: number; gridIdx: number };
type BombType = "atom" | "hydrogen" | "dirty";
type UnitType = "infantry" | "tank" | "warship";

// A squad of troops marching toward a target grid cell
type Squad = {
  id: string;
  ownerIdx: number;
  ownerPid: string;
  unitType: UnitType;
  unitsStart: number;
  unitsCurrent: number;        // decreases as they fight
  targetGridIdx: number;
  targetName?: string;         // name of target player/territory
  progress: number;            // 0–1 march progress
  isNaval: boolean;
  fromGridIdx: number;         // spawn cell
  screenFromX: number;
  screenFromY: number;
  screenToX: number;
  screenToY: number;
};

type Ship = {
  id: string; ownerIdx: number;
  fromX: number; fromY: number; toX: number; toY: number;
  units: number; targetGridIdx: number; progress: number;
  distanceTiles: number;
};

type RadZone = { gridIdx: number; strength: number; decay: number };
type PlaceMode = { type: BuildingType } | null;
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };

// Right-click context menu
type ContextMenu = {
  x: number; y: number;
  targetPlayerIdx: number;
  targetPlayerPid: string;
  targetName: string;
};

// Hover panel data
type HoverPanel = {
  playerIdx: number;
  pid: string;
  name: string;
  color: string;
  units: number;
  coins: number;
  pixels: number;
  isBot: boolean;
  buildings: Building[];
  attackingTroops: number;
};

// ─── Constants ───────────────────────────────────────────────────────────────
const DIFFICULTY_REGEN: Record<string, number> = { relaxed: 0.6, balanced: 1.0, intense: 1.5 };
const FORT_DEFENSE   = 3.0;
const DEFPOST_MULT   = 1.8;
const MAX_STRENGTH   = 100;
const REGEN_RATE     = 0.3;

// Squad march speed — cells per second
const SQUAD_CELLS_PER_SEC = 8;
// Attrition per contested cell (fraction of squad lost)
const ATTRITION_NEUTRAL   = 0.002;  // very low for empty land
const ATTRITION_ENEMY     = 0.012;  // heavier vs defended tiles

const UNIT_MULT: Record<UnitType, number> = { infantry: 1.0, tank: 2.5, warship: 1.5 };
const UNIT_COST: Record<UnitType, number> = { infantry: 0, tank: 80, warship: 60 };

const FACTORY_UNITS  = 8;
const PORT_COINS     = 3;
const CITY_COINS     = 2;
const CITY_POP_CAP   = 500;
const STARTER_RADIUS = 2;
const SHIP_TILES_PER_MS = 0.004;

const BUILD_COST: Record<BuildingType, [number, number]> = {
  city: [80, 0], defense_post: [30, 20], port: [60, 0], fort: [40, 40],
  factory: [70, 0], missile_silo: [200, 0], sam_launcher: [90, 0], naval_base: [120, 0],
};
const BUILD_STAT: Record<BuildingType, string> = {
  city:          "+2💰/tick · +500 pop cap",
  defense_post:  "1.8× tile defense · checker pattern",
  port:          "+3💰/tick · enables naval attacks",
  fort:          "3× tile defense · coastal fortress",
  factory:       "+8 units/tick per factory",
  missile_silo:  "Enables nuclear & dirty bombs",
  sam_launcher:  "40% chance to intercept missiles",
  naval_base:    "1.7× ship speed",
};
const BOMB_COST:   Record<BombType, number> = { atom: 600, hydrogen: 1200, dirty: 400 };
const BOMB_RADIUS: Record<BombType, number> = { atom: 12, hydrogen: 22, dirty: 8 };
const BOMB_RAD:    Record<BombType, number> = { atom: 80, hydrogen: 160, dirty: 200 };

const BUILDING_LABELS: Record<BuildingType, string> = {
  city: "City", defense_post: "Defense Post", port: "Port", fort: "Fort",
  factory: "Factory", missile_silo: "Missile Silo", sam_launcher: "SAM Launcher", naval_base: "Naval Base",
};
const BUILDING_ICONS: Record<BuildingType, string> = {
  city: "🏙", defense_post: "🛡", port: "⚓", fort: "🔶",
  factory: "🏭", missile_silo: "🚀", sam_launcher: "📡", naval_base: "🛳",
};
const TOOLBAR: BuildingType[] = ["city", "factory", "port", "naval_base", "defense_post", "fort", "missile_silo", "sam_launcher"];

function hexRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}
function fmt(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`; }

interface GameScreenProps { lobby: Lobby; playerId: string; onLeave: () => void; }

// ─────────────────────────────────────────────────────────────────────────────
export function GameScreen({ lobby, playerId, onLeave }: GameScreenProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [players,      setPlayers]      = useState<LobbyPlayer[]>([]);
  const [,             setTick]         = useState(0);
  const [sendPct,      setSendPct]      = useState(20);
  const [placeMode,    setPlaceMode]    = useState<PlaceMode>(null);
  const [bombMode,     setBombMode]     = useState<BombType | null>(null);
  const [buildings,    setBuildings]    = useState<Building[]>([]);
  const [hasSpawned,   setHasSpawned]   = useState(false);
  const [isDead,       setIsDead]       = useState(false);
  const [isSpectating, setIsSpectating] = useState(false);
  const [unitType,     setUnitType]     = useState<UnitType>("infantry");
  const [mySquads,     setMySquads]     = useState<Squad[]>([]);
  const [hoverPanel,   setHoverPanel]   = useState<HoverPanel | null>(null);
  const [contextMenu,  setContextMenu]  = useState<ContextMenu | null>(null);

  const sendPctRef    = useRef(20);
  const buildingsRef  = useRef<Building[]>([]);
  const placeModeRef  = useRef<PlaceMode>(null);
  const bombModeRef   = useRef<BombType | null>(null);
  const unitTypeRef   = useRef<UnitType>("infantry");
  const keysRef       = useRef<Set<string>>(new Set());
  const squadsRef     = useRef<Squad[]>([]);
  const hoverGridRef  = useRef<number>(-1);

  useEffect(() => { sendPctRef.current  = sendPct;  }, [sendPct]);
  useEffect(() => { buildingsRef.current = buildings; }, [buildings]);
  useEffect(() => { placeModeRef.current = placeMode; }, [placeMode]);
  useEffect(() => { bombModeRef.current  = bombMode;  }, [bombMode]);
  useEffect(() => { unitTypeRef.current  = unitType;  }, [unitType]);

  // ── Grid state ────────────────────────────────────────────────────────────
  const ownerGridRef    = useRef<Int16Array>(new Int16Array(GRID_W * GRID_H).fill(-1));
  const strengthGridRef = useRef<Float32Array>(new Float32Array(GRID_W * GRID_H).fill(0));
  const landMaskRef     = useRef<Uint8Array | null>(null);
  const coastMaskRef    = useRef<Uint8Array | null>(null);
  const radZonesRef     = useRef<RadZone[]>([]);
  const shipsRef        = useRef<Ship[]>([]);
  const playersRef      = useRef<Map<string, LobbyPlayer>>(new Map());
  const playerIndexRef  = useRef<Map<string, number>>(new Map());
  const colorsRef       = useRef<[number, number, number][]>([]);
  const lastSyncRef     = useRef<number>(0);
  const lastBotRef      = useRef<number>(0);
  const channelRef      = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const eliminatedRef   = useRef<Set<number>>(new Set());

  const camRef       = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef      = useRef({ active: false, startX: 0, startY: 0, camX: 0, camY: 0 });
  const dragMovedRef = useRef(false);
  const mapRectRef   = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const particlesRef = useRef<Particle[]>([]);

  const notify = (msg: string, kind: "info" | "error" | "success" = "info") => {
    if (kind === "error") toast.error(msg);
    else if (kind === "success") toast.success(msg);
    else toast(msg);
  };

  function buildCoastMask(mask: Uint8Array): Uint8Array {
    const coast = new Uint8Array(GRID_W * GRID_H);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % GRID_W, y = Math.floor(i / GRID_W);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H || !mask[ny * GRID_W + nx]) {
          coast[i] = 1; break;
        }
      }
    }
    return coast;
  }

  const screenToGrid = useCallback((sx: number, sy: number) => {
    const canvas = canvasRef.current; if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = (sx - rect.left) * devicePixelRatio;
    const py = (sy - rect.top) * devicePixelRatio;
    const cam = camRef.current;
    const wx = (px - cam.x) / cam.zoom, wy = (py - cam.y) / cam.zoom;
    const mr = mapRectRef.current;
    const gx = Math.floor((wx - mr.x) / (mr.w / GRID_W));
    const gy = Math.floor((wy - mr.y) / (mr.h / GRID_H));
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return null;
    return { gx, gy };
  }, []);

  // ── Realtime ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    async function load() {
      const { data } = await supabase.from("lobby_players").select("*").eq("lobby_id", lobby.id);
      if (!active || !data) return;
      setPlayers(data);
      const map = new Map<string, LobbyPlayer>();
      data.forEach(p => map.set(p.player_id, p));
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
        payload => {
          if (payload.eventType === "DELETE") return;
          const p = payload.new as LobbyPlayer;
          playersRef.current.set(p.player_id, p);
          setPlayers(prev => { const i = prev.findIndex(x => x.player_id === p.player_id); if (i === -1) return [...prev, p]; const n = [...prev]; n[i] = p; return n; });
        })
      .on("broadcast", { event: "claim" }, ({ payload }) => {
        const claims = payload as { i: number; o: number; s: number }[];
        const grid = ownerGridRef.current, str = strengthGridRef.current;
        for (const c of claims) { grid[c.i] = c.o; str[c.i] = c.s ?? 0; }
      })
      .on("broadcast", { event: "building" }, ({ payload }) => {
        const b = payload as Building;
        if (!buildingsRef.current.some(x => x.gridIdx === b.gridIdx)) {
          buildingsRef.current = [...buildingsRef.current, b];
          setBuildings(prev => [...prev, b]);
        }
      })
      .on("broadcast", { event: "rad_zone" }, ({ payload }) => {
        radZonesRef.current = [...radZonesRef.current, ...(payload as RadZone[])];
      })
      .on("broadcast", { event: "ship" }, ({ payload }) => {
        const s = payload as Ship;
        if (!shipsRef.current.find(x => x.id === s.id)) shipsRef.current = [...shipsRef.current, s];
      })
      .on("broadcast", { event: "squad" }, ({ payload }) => {
        const s = payload as Squad;
        if (!squadsRef.current.find(x => x.id === s.id)) {
          squadsRef.current = [...squadsRef.current, s];
        }
      })
      .subscribe();
    channelRef.current = ch;
    return () => { active = false; supabase.removeChannel(ch); channelRef.current = null; };
  }, [lobby.id]);

  useEffect(() => {
    loadLandMask().then(m => { landMaskRef.current = m; coastMaskRef.current = buildCoastMask(m); });
  }, []);

  // ─── Render + sim loop ────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current, container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let lastFrame = performance.now();

    const off = document.createElement("canvas");
    off.width = GRID_W; off.height = GRID_H;
    const offCtx = off.getContext("2d")!;
    const imgData = offCtx.createImageData(GRID_W, GRID_H);
    const bgImg = new Image(); bgImg.src = worldMap;

    function computeMapRect() {
      const w = canvas!.width, h = canvas!.height;
      const ratio = 1920 / 960, cr = w / h;
      let mw, mh, mx, my: number;
      if (cr > ratio) { mh = h; mw = h * ratio; mx = (w - mw) / 2; my = 0; }
      else { mw = w; mh = w / ratio; mx = 0; my = (h - mh) / 2; }
      return { x: mx, y: my, w: mw, h: mh };
    }
    function resize() {
      const r = container!.getBoundingClientRect();
      canvas!.width = r.width * devicePixelRatio; canvas!.height = r.height * devicePixelRatio;
      canvas!.style.width = `${r.width}px`; canvas!.style.height = `${r.height}px`;
      mapRectRef.current = computeMapRect();
    }
    resize();
    const ro = new ResizeObserver(resize); ro.observe(container);

    // ── Regen only (no passive spread) ───────────────────────────────────
    function tickRegen(dt: number) {
      const grid = ownerGridRef.current;
      const str  = strengthGridRef.current;
      const regenMult = DIFFICULTY_REGEN[lobby.difficulty] ?? 1;
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] < 0) continue;
        str[i] = Math.min(MAX_STRENGTH, str[i] + REGEN_RATE * regenMult * dt * 0.06);
      }
    }

    // ── Squad advancement ─────────────────────────────────────────────────
    // Squads march cell by cell. Each step they contest/claim tiles along a path.
    // They lose units based on tile defense.
    function tickSquads(dt: number) {
      const mask = landMaskRef.current; if (!mask) return;
      const grid = ownerGridRef.current;
      const str  = strengthGridRef.current;
      const blds = buildingsRef.current;
      const mr   = mapRectRef.current;
      const claims: { i: number; o: number; s: number }[] = [];
      const dead: string[] = [];

      for (const squad of squadsRef.current) {
        if (squad.unitsCurrent <= 0) { dead.push(squad.id); continue; }

        // Advance progress
        const distCells = Math.abs(squad.targetGridIdx % GRID_W - squad.fromGridIdx % GRID_W) +
                          Math.abs(Math.floor(squad.targetGridIdx / GRID_W) - Math.floor(squad.fromGridIdx / GRID_W));
        const speed = SQUAD_CELLS_PER_SEC / Math.max(1, distCells) * (dt / 1000);
        squad.progress = Math.min(1, squad.progress + speed);

        // Current grid cell the squad is AT
        const fromX = squad.fromGridIdx % GRID_W, fromY = Math.floor(squad.fromGridIdx / GRID_W);
        const toX   = squad.targetGridIdx % GRID_W, toY = Math.floor(squad.targetGridIdx / GRID_W);
        const cx = Math.round(fromX + (toX - fromX) * squad.progress);
        const cy = Math.round(fromY + (toY - fromY) * squad.progress);
        const ci = cy * GRID_W + cx;
        if (ci < 0 || ci >= grid.length || !mask[ci]) continue;

        const curOwner = grid[ci];
        const uMult    = UNIT_MULT[squad.unitType];

        if (curOwner !== squad.ownerIdx) {
          const hasFort    = blds.some(b => b.gridIdx === ci && b.type === "fort");
          const hasDefPost = blds.some(b => b.gridIdx === ci && b.type === "defense_post");
          const defMult    = hasFort ? FORT_DEFENSE : hasDefPost ? DEFPOST_MULT : 1.0;
          const isNeutral  = curOwner < 0;
          const attrition  = (isNeutral ? ATTRITION_NEUTRAL : ATTRITION_ENEMY * defMult / uMult) * dt;
          squad.unitsCurrent = Math.max(0, squad.unitsCurrent - attrition * squad.unitsStart);

          // Flip tile if squad has enough strength
          const attackPow = (squad.unitsCurrent / squad.unitsStart) * uMult * 50;
          const defendPow = isNeutral ? 1 : str[ci] * defMult;
          if (attackPow > defendPow || Math.random() < 0.03) {
            const prevOwner = grid[ci];
            grid[ci] = squad.ownerIdx;
            str[ci]  = Math.max(5, attackPow - defendPow);
            claims.push({ i: ci, o: squad.ownerIdx, s: str[ci] });

            // Explosion particles
            const wx = mr.x + (cx + 0.5) / GRID_W * mr.w;
            const wy = mr.y + (cy + 0.5) / GRID_H * mr.h;
            const cam = camRef.current;
            const col = colorsRef.current[squad.ownerIdx];
            const colStr = col ? `rgb(${col.join(",")})` : "#fff";
            for (let pi = 0; pi < (isNeutral ? 1 : 3); pi++) {
              particlesRef.current.push({ x: cam.x + wx * cam.zoom, y: cam.y + wy * cam.zoom, vx: (Math.random() - 0.5) * 1.5, vy: (Math.random() - 0.5) * 1.5, life: 1, color: colStr });
            }

            // Check elimination
            if (!isNeutral && prevOwner >= 0 && !eliminatedRef.current.has(prevOwner)) {
              let survived = false;
              for (let k = 0; k < grid.length; k++) if (grid[k] === prevOwner) { survived = true; break; }
              if (!survived) {
                eliminatedRef.current.add(prevOwner);
                const col2 = colorsRef.current[squad.ownerIdx];
                if (col2) {
                  const killerPid = [...playerIndexRef.current.entries()].find(([, v]) => v === squad.ownerIdx)?.[0];
                  if (killerPid) {
                    const killer = playersRef.current.get(killerPid);
                    if (killer) {
                      killer.coins = (killer.coins || 0) + 500;
                      supabase.from("lobby_players").update({ coins: killer.coins }).eq("lobby_id", lobby.id).eq("player_id", killerPid);
                      if (killerPid === playerId) notify("Enemy eliminated! +500 coins", "success");
                    }
                  }
                }
                const myIdx = playerIndexRef.current.get(playerId);
                if (prevOwner === myIdx) setIsDead(true);
              }
            }
            blds.forEach(b => { if (b.gridIdx === ci && squad.ownerIdx >= 0) b.ownerIdx = squad.ownerIdx; });
          }
        }

        // Squad reached target
        if (squad.progress >= 1) {
          dead.push(squad.id);
          // Return surviving units to player
          const ownerPid = squad.ownerPid;
          const p = playersRef.current.get(ownerPid);
          if (p) {
            p.units = Math.min(99999, p.units + Math.floor(squad.unitsCurrent));
            supabase.from("lobby_players").update({ units: p.units }).eq("lobby_id", lobby.id).eq("player_id", ownerPid);
          }
        }
      }

      if (claims.length > 0) {
        for (let ci = 0; ci < claims.length; ci += 60) {
          channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims.slice(ci, ci + 60) });
        }
      }

      if (dead.length > 0) {
        squadsRef.current = squadsRef.current.filter(s => !dead.includes(s.id));
        setMySquads(squadsRef.current.filter(s => s.ownerPid === playerId));
      } else {
        // Update my squads display
        setMySquads([...squadsRef.current.filter(s => s.ownerPid === playerId)]);
      }
    }

    // ── Sync to DB ────────────────────────────────────────────────────────
    async function syncStats() {
      if (lobby.host_id !== playerId) return;
      const grid = ownerGridRef.current, blds = buildingsRef.current;
      blds.forEach(b => { const cur = grid[b.gridIdx]; if (cur >= 0 && cur !== b.ownerIdx) b.ownerIdx = cur; });

      const pixelCounts  = new Array(colorsRef.current.length).fill(0);
      const unitBonus    = new Array(colorsRef.current.length).fill(0);
      const coinBonus    = new Array(colorsRef.current.length).fill(0);
      const popCapBonus  = new Array(colorsRef.current.length).fill(0);
      for (let i = 0; i < grid.length; i++) { const o = grid[i]; if (o >= 0) pixelCounts[o]++; }
      blds.forEach(b => {
        const o = b.ownerIdx;
        if (b.type === "factory") unitBonus[o] = (unitBonus[o] || 0) + FACTORY_UNITS;
        if (b.type === "port")    coinBonus[o] = (coinBonus[o] || 0) + PORT_COINS;
        if (b.type === "city") { coinBonus[o] = (coinBonus[o] || 0) + CITY_COINS; popCapBonus[o] = (popCapBonus[o] || 0) + CITY_POP_CAP; }
      });

      const regenMult = DIFFICULTY_REGEN[lobby.difficulty] ?? 1;
      const updates: Promise<unknown>[] = [];
      playersRef.current.forEach(p => {
        const idx = playerIndexRef.current.get(p.player_id); if (idx === undefined) return;
        const px = pixelCounts[idx] ?? 0;
        if (!p.alive && p.is_bot) { if (!eliminatedRef.current.has(idx)) eliminatedRef.current.add(idx); return; }
        const passive  = Math.round(Math.sqrt(px) * 2 * regenMult);
        const newUnits = Math.min(9999 + (popCapBonus[idx] || 0), p.units + passive + (unitBonus[idx] || 0));
        const newCoins = Math.min(99999, (p.coins || 0) + (coinBonus[idx] || 0));
        const alive    = px > 0 || p.units > 0;
        p.units = newUnits; p.coins = newCoins;
        updates.push(supabase.from("lobby_players").update({ pixels: px, units: newUnits, coins: newCoins, alive }).eq("lobby_id", lobby.id).eq("player_id", p.player_id));
      });
      await Promise.all(updates);
    }

    // ── Draw building icon ────────────────────────────────────────────────
    function drawBldIcon(px: number, py: number, type: BuildingType, color: string, zoom: number) {
      ctx.save();
      const r = Math.max(3, Math.min(8, 5 * zoom));
      ctx.fillStyle = color; ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.lineWidth = 1;
      switch (type) {
        case "city":
          ctx.fillRect(px - r, py - r * 0.6, r * 2, r * 1.4); ctx.strokeRect(px - r, py - r * 0.6, r * 2, r * 1.4);
          ctx.fillRect(px - r, py - r * 1.5, r * 0.7, r * 0.9); ctx.strokeRect(px - r, py - r * 1.5, r * 0.7, r * 0.9);
          ctx.fillRect(px + r * 0.3, py - r * 1.8, r * 0.7, r * 1.2); ctx.strokeRect(px + r * 0.3, py - r * 1.8, r * 0.7, r * 1.2);
          break;
        case "defense_post":
          ctx.beginPath(); ctx.moveTo(px, py - r * 1.4); ctx.lineTo(px + r, py - r * 0.4); ctx.lineTo(px + r, py + r * 0.6);
          ctx.lineTo(px, py + r * 1.4); ctx.lineTo(px - r, py + r * 0.6); ctx.lineTo(px - r, py - r * 0.4);
          ctx.closePath(); ctx.fill(); ctx.stroke(); break;
        case "port":
          ctx.beginPath(); ctx.arc(px, py - r * 0.6, r * 0.55, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(px, py - r * 0.6); ctx.lineTo(px, py + r); ctx.moveTo(px - r * 0.8, py + r * 0.6); ctx.lineTo(px + r * 0.8, py + r * 0.6); ctx.stroke(); break;
        case "fort":
          ctx.beginPath();
          for (let a = 0; a < 6; a++) { const ang = (a / 6) * Math.PI * 2 - Math.PI / 6; a === 0 ? ctx.moveTo(px + Math.cos(ang) * r, py + Math.sin(ang) * r) : ctx.lineTo(px + Math.cos(ang) * r, py + Math.sin(ang) * r); }
          ctx.closePath(); ctx.fill(); ctx.stroke(); break;
        case "factory":
          ctx.fillRect(px - r, py - r * 0.6, r * 2, r * 1.4); ctx.strokeRect(px - r, py - r * 0.6, r * 2, r * 1.4);
          ctx.fillRect(px - r * 0.5, py - r * 1.5, r * 0.55, r); ctx.strokeRect(px - r * 0.5, py - r * 1.5, r * 0.55, r); break;
        case "missile_silo":
          ctx.beginPath(); ctx.moveTo(px, py - r * 1.5); ctx.lineTo(px + r * 0.75, py + r); ctx.lineTo(px - r * 0.75, py + r); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.fillStyle = "#f97316"; ctx.beginPath(); ctx.moveTo(px - r * 0.4, py + r); ctx.lineTo(px, py + r * 1.9); ctx.lineTo(px + r * 0.4, py + r); ctx.closePath(); ctx.fill(); break;
        case "sam_launcher":
          ctx.beginPath(); ctx.arc(px, py, r, Math.PI, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + r); ctx.stroke(); break;
        case "naval_base":
          ctx.beginPath(); ctx.moveTo(px - r, py + r * 0.3); ctx.lineTo(px + r, py + r * 0.3); ctx.lineTo(px + r * 0.7, py - r * 0.3); ctx.lineTo(px - r * 0.7, py - r * 0.3); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.fillRect(px - r * 0.15, py - r, r * 0.3, r * 0.7); break;
      }
      ctx.restore();
    }

    // ── Render ────────────────────────────────────────────────────────────
    function render() {
      const w = canvas!.width, h = canvas!.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0a1628"; ctx.fillRect(0, 0, w, h);
      const mr = computeMapRect(); mapRectRef.current = mr;
      const { x: mx, y: my, w: mw, h: mh } = mr;
      const cellW = mw / GRID_W, cellH = mh / GRID_H;
      const cam = camRef.current;

      ctx.save();
      ctx.translate(cam.x, cam.y); ctx.scale(cam.zoom, cam.zoom);

      if (bgImg.complete) ctx.drawImage(bgImg, mx, my, mw, mh);
      else { ctx.fillStyle = "#1a3050"; ctx.fillRect(mx, my, mw, mh); }

      // Territory
      const grid   = ownerGridRef.current;
      const str    = strengthGridRef.current;
      const colors = colorsRef.current;
      const data   = imgData.data;
      const defPostSet = new Set(buildingsRef.current.filter(b => b.type === "defense_post").map(b => b.gridIdx));
      const radMap = new Map<number, number>(); radZonesRef.current.forEach(rz => radMap.set(rz.gridIdx, rz.strength));

      for (let i = 0; i < grid.length; i++) {
        if (radMap.has(i)) {
          const s = radMap.get(i)!;
          data[i * 4] = 20; data[i * 4 + 1] = 220; data[i * 4 + 2] = 60;
          data[i * 4 + 3] = Math.min(200, 100 + s * 0.6); continue;
        }
        const o = grid[i];
        if (o < 0 || !colors[o]) { data[i * 4 + 3] = 0; continue; }
        const c = colors[o];
        const x = i % GRID_W, y = Math.floor(i / GRID_W);
        const checker = defPostSet.has(i) && (x + y) % 2 === 0;
        const alpha = 120 + (str[i] / MAX_STRENGTH) * 90;
        data[i * 4]     = checker ? Math.min(255, c[0] + 70) : c[0];
        data[i * 4 + 1] = checker ? Math.min(255, c[1] + 70) : c[1];
        data[i * 4 + 2] = checker ? Math.min(255, c[2] + 70) : c[2];
        data[i * 4 + 3] = alpha;
      }
      offCtx.putImageData(imgData, 0, 0);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(off, mx, my, mw, mh); ctx.imageSmoothingEnabled = true;

      // Border outlines
      for (let i = 0; i < grid.length; i++) {
        const o = grid[i]; if (o < 0) continue;
        const x = i % GRID_W, y = Math.floor(i / GRID_W);
        let isBorder = x === 0 || y === 0 || x === GRID_W - 1 || y === GRID_H - 1;
        if (!isBorder) isBorder = grid[i + 1] !== o || grid[i - 1] !== o || grid[i + GRID_W] !== o || grid[i - GRID_W] !== o;
        if (!isBorder) continue;
        const c = colors[o];
        ctx.strokeStyle = `rgba(${Math.min(255, c[0] + 90)},${Math.min(255, c[1] + 90)},${Math.min(255, c[2] + 90)},0.95)`;
        ctx.lineWidth = Math.max(0.6, cellW * 0.35);
        ctx.strokeRect(mx + x * cellW + 0.5, my + y * cellH + 0.5, cellW - 1, cellH - 1);
      }

      // Squads — draw marching icons on the map
      for (const squad of squadsRef.current) {
        const fromX = squad.fromGridIdx % GRID_W, fromY = Math.floor(squad.fromGridIdx / GRID_W);
        const toX   = squad.targetGridIdx % GRID_W, toY = Math.floor(squad.targetGridIdx / GRID_W);
        const cx2 = fromX + (toX - fromX) * squad.progress;
        const cy2 = fromY + (toY - fromY) * squad.progress;
        const sx = mx + (cx2 + 0.5) * cellW, sy = my + (cy2 + 0.5) * cellH;
        const col = colorsRef.current[squad.ownerIdx];
        const colStr = col ? `rgb(${col.join(",")})` : "#fff";
        const healthPct = squad.unitsCurrent / squad.unitsStart;
        const icons: Record<UnitType, string> = { infantry: "🪖", tank: "🚜", warship: "🚢" };

        ctx.save();
        // Shadow circle
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = colStr;
        ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fill();
        // Icon
        ctx.globalAlpha = 1;
        ctx.font = `${Math.max(7, 10)}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(icons[squad.unitType], sx, sy);
        // Health bar below icon
        const barW = 16, barH = 3, barX = sx - barW / 2, barY = sy + 9;
        ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
        ctx.fillStyle = healthPct > 0.5 ? "#22c55e" : healthPct > 0.25 ? "#f59e0b" : "#ef4444";
        ctx.fillRect(barX, barY, barW * healthPct, barH);
        ctx.restore();
      }

      // Buildings
      buildingsRef.current.forEach(b => {
        const curOwner = grid[b.gridIdx];
        const entry = [...playerIndexRef.current.entries()].find(([, v]) => v === curOwner);
        const col = entry ? playersRef.current.get(entry[0])?.color ?? "#fff" : "#fff";
        drawBldIcon(mx + (b.gridIdx % GRID_W) / GRID_W * mw + cellW / 2, my + Math.floor(b.gridIdx / GRID_W) / GRID_H * mh + cellH / 2, b.type, col, cam.zoom);
      });

      // Ships
      shipsRef.current.forEach(ship => {
        const sx = ship.fromX + (ship.toX - ship.fromX) * ship.progress;
        const sy = ship.fromY + (ship.toY - ship.fromY) * ship.progress;
        const entry = [...playerIndexRef.current.entries()].find(([, v]) => v === ship.ownerIdx);
        const col = entry ? playersRef.current.get(entry[0])?.color ?? "#4af" : "#4af";
        const angle = Math.atan2(ship.toY - ship.fromY, ship.toX - ship.fromX);
        ctx.save();
        ctx.translate(sx, sy); ctx.rotate(angle);
        ctx.fillStyle = col; ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.ellipse(0, 0, 7, 3.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 0.25; ctx.strokeStyle = "#aef"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(-9, 2); ctx.lineTo(-18, 4); ctx.moveTo(-9, -2); ctx.lineTo(-18, -4); ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.fillStyle = "#fff"; ctx.font = `bold ${Math.max(7, 9)}px monospace`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 3;
        ctx.fillText(`${ship.units}`, sx, sy - 11); ctx.restore();
      });

      // Nameplates
      {
        const sumX = new Float64Array(colors.length), sumY = new Float64Array(colors.length), cnt = new Int32Array(colors.length);
        for (let i = 0; i < grid.length; i++) { const o = grid[i]; if (o < 0 || o >= colors.length) continue; sumX[o] += i % GRID_W; sumY[o] += Math.floor(i / GRID_W); cnt[o]++; }
        ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const bf = Math.max(6, Math.min(16, 11 / cam.zoom));
        playerIndexRef.current.forEach((idx, pid) => {
          if (cnt[idx] < 5) return;
          const p = playersRef.current.get(pid); if (!p || !p.alive) return;
          const sx = mx + (sumX[idx] / cnt[idx] / GRID_W) * mw;
          const sy = my + (sumY[idx] / cnt[idx] / GRID_H) * mh;
          ctx.font = `bold ${bf}px sans-serif`; ctx.shadowColor = "rgba(0,0,0,0.95)"; ctx.shadowBlur = 4;
          ctx.fillStyle = "#fff"; ctx.fillText(p.name, sx, sy - bf * 0.65);
          ctx.font = `${bf * 0.85}px monospace`; ctx.fillStyle = "rgba(255,255,200,0.9)";
          ctx.fillText(fmt(p.units), sx, sy + bf * 0.65); ctx.shadowBlur = 0;
        });
        ctx.restore();
      }

      ctx.restore(); // end camera

      // Particles (screen-space)
      for (const p of particlesRef.current) {
        ctx.globalAlpha = p.life * 0.75; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1 + p.life * 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Mode hint — top center
      if (placeModeRef.current || bombModeRef.current) {
        ctx.save(); ctx.font = `${14 * devicePixelRatio}px sans-serif`;
        ctx.fillStyle = "rgba(255,255,100,0.9)"; ctx.textAlign = "center";
        ctx.fillText(
          placeModeRef.current
            ? `Click to place ${BUILDING_LABELS[placeModeRef.current.type]}  ·  Right-click to cancel`
            : `Click to drop ${bombModeRef.current} bomb  ·  Right-click to cancel`,
          canvas!.width / 2, 28 * devicePixelRatio
        );
        ctx.restore();
      }
    }

    // ── Main loop ─────────────────────────────────────────────────────────
    function loop(now: number) {
      const dt = Math.min(now - lastFrame, 100); lastFrame = now;

      // WASD + Arrow keys camera pan
      const cam = camRef.current; const ks = keysRef.current;
      if (ks.has("w") || ks.has("arrowup"))    cam.y += 5;
      if (ks.has("s") || ks.has("arrowdown"))  cam.y -= 5;
      if (ks.has("a") || ks.has("arrowleft"))  cam.x += 5;
      if (ks.has("d") || ks.has("arrowright")) cam.x -= 5;

      tickRegen(dt);
      tickSquads(dt);

      // Ships
      const navalBoost = new Set(buildingsRef.current.filter(b => b.type === "naval_base").map(b => b.ownerIdx));
      shipsRef.current = shipsRef.current.filter(ship => {
        const speed = SHIP_TILES_PER_MS / Math.max(1, ship.distanceTiles) * (navalBoost.has(ship.ownerIdx) ? 1.7 : 1);
        ship.progress = Math.min(1, ship.progress + speed * dt);
        if (ship.progress >= 1) {
          const mask2 = landMaskRef.current; const coast2 = coastMaskRef.current;
          if (mask2 && coast2) {
            const gr = ownerGridRef.current, st = strengthGridRef.current;
            const ltx = ship.targetGridIdx % GRID_W, lty = Math.floor(ship.targetGridIdx / GRID_W);
            for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
              if (Math.abs(dx) + Math.abs(dy) > 4) continue;
              const nx = ltx + dx, ny = lty + dy;
              if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
              const ni = ny * GRID_W + nx;
              if (!mask2[ni]) continue;
              if (gr[ni] !== ship.ownerIdx) { gr[ni] = ship.ownerIdx; st[ni] = Math.min(MAX_STRENGTH, Math.max(5, ship.units * 0.15)); }
            }
          }
          return false;
        }
        return true;
      });

      // Radiation decay
      radZonesRef.current = radZonesRef.current.filter(rz => { rz.strength = Math.max(0, rz.strength - rz.decay * dt * 0.01); return rz.strength > 0; });

      // Particles
      particlesRef.current = particlesRef.current.filter(p => { p.x += p.vx; p.y += p.vy; p.life -= 0.025; return p.life > 0; });
      if (particlesRef.current.length > 1000) particlesRef.current = particlesRef.current.slice(-500);

      render();

      if (now - lastSyncRef.current > 1500) { lastSyncRef.current = now; syncStats(); }

      // Bot AI (simple — bots still use old spread, keeping them functional)
      if (lobby.host_id === playerId && now - lastBotRef.current > 2200) {
        lastBotRef.current = now;
        const mask2 = landMaskRef.current; if (mask2) {
          const gr = ownerGridRef.current;
          playersRef.current.forEach(bot => {
            if (!bot.is_bot || !bot.alive) return;
            const idx = playerIndexRef.current.get(bot.player_id);
            if (idx === undefined || eliminatedRef.current.has(idx)) return;
            const owned: number[] = [];
            for (let i = 0; i < gr.length; i++) if (gr[i] === idx) owned.push(i);
            if (owned.length === 0) {
              const cands: number[] = [];
              for (let i = 0; i < mask2.length; i++) if (mask2[i] && gr[i] === -1) cands.push(i);
              if (cands.length === 0) return;
              plantStarter(cands[Math.floor(Math.random() * cands.length)], idx); return;
            }
            if (bot.units < 30) return;
            const neutral: number[] = [], enemy: number[] = [];
            for (const i of owned) {
              const x2 = i % GRID_W, y2 = Math.floor(i / GRID_W);
              for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                const nx = x2 + dx, ny = y2 + dy;
                if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
                const ni = ny * GRID_W + nx; if (!mask2[ni]) continue;
                if (gr[ni] === -1) neutral.push(ni); else if (gr[ni] !== idx) enemy.push(ni);
              }
            }
            let target = -1;
            if (neutral.length > 0 && bot.units > 30) target = neutral[Math.floor(Math.random() * neutral.length)];
            else if (enemy.length > 0 && bot.units > 100) target = enemy[Math.floor(Math.random() * enemy.length)];
            if (target === -1) return;
            // Bot launches a squad
            const border = owned.reduce((best, i) => {
              const d = Math.abs(i % GRID_W - target % GRID_W) + Math.abs(Math.floor(i / GRID_W) - Math.floor(target / GRID_W));
              return d < best.d ? { i, d } : best;
            }, { i: owned[0], d: Infinity });
            const sendUnits = Math.max(5, Math.floor(bot.units * 0.2));
            const mr2 = mapRectRef.current;
            const botSquad: Squad = {
              id: crypto.randomUUID(), ownerIdx: idx, ownerPid: bot.player_id,
              unitType: "infantry", unitsStart: sendUnits, unitsCurrent: sendUnits,
              targetGridIdx: target, progress: 0, isNaval: false, fromGridIdx: border.i,
              screenFromX: mr2.x + (border.i % GRID_W + 0.5) / GRID_W * mr2.w,
              screenFromY: mr2.y + (Math.floor(border.i / GRID_W) + 0.5) / GRID_H * mr2.h,
              screenToX: mr2.x + (target % GRID_W + 0.5) / GRID_W * mr2.w,
              screenToY: mr2.y + (Math.floor(target / GRID_W) + 0.5) / GRID_H * mr2.h,
            };
            squadsRef.current = [...squadsRef.current, botSquad];
            bot.units = Math.max(0, bot.units - sendUnits);
          });
        }
      }

      setTick(t => (t + 1) % 1000000);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    // ── Input ─────────────────────────────────────────────────────────────
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const r = canvas!.getBoundingClientRect();
      const mx2 = (e.clientX - r.left) * devicePixelRatio, my2 = (e.clientY - r.top) * devicePixelRatio;
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const c = camRef.current, newZoom = Math.min(10, Math.max(0.3, c.zoom * factor));
      c.x = mx2 - (mx2 - c.x) * (newZoom / c.zoom); c.y = my2 - (my2 - c.y) * (newZoom / c.zoom); c.zoom = newZoom;
    }
    function onMouseDown(e: MouseEvent) {
      if (e.button === 1 || e.button === 2) {
        e.preventDefault(); dragMovedRef.current = false;
        dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, camX: camRef.current.x, camY: camRef.current.y };
      }
    }
    function onMouseMove(e: MouseEvent) {
      if (dragRef.current.active) {
        const dx = (e.clientX - dragRef.current.startX) * devicePixelRatio;
        const dy = (e.clientY - dragRef.current.startY) * devicePixelRatio;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMovedRef.current = true;
        camRef.current.x = dragRef.current.camX + dx; camRef.current.y = dragRef.current.camY + dy;
      }

      // Hover panel
      const rect = canvas!.getBoundingClientRect();
      const px = (e.clientX - rect.left) * devicePixelRatio;
      const py = (e.clientY - rect.top) * devicePixelRatio;
      const cam = camRef.current;
      const wx = (px - cam.x) / cam.zoom, wy = (py - cam.y) / cam.zoom;
      const mr2 = mapRectRef.current;
      const gx = Math.floor((wx - mr2.x) / (mr2.w / GRID_W));
      const gy = Math.floor((wy - mr2.y) / (mr2.h / GRID_H));
      if (gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H) {
        const gi = gy * GRID_W + gx;
        if (gi !== hoverGridRef.current) {
          hoverGridRef.current = gi;
          const ownerIdx = ownerGridRef.current[gi];
          if (ownerIdx >= 0) {
            const entry = [...playerIndexRef.current.entries()].find(([, v]) => v === ownerIdx);
            if (entry) {
              const [pid] = entry;
              const p = playersRef.current.get(pid);
              if (p) {
                const myPid = playerId;
                const myIdx2 = playerIndexRef.current.get(myPid);
                const attackingTroops = squadsRef.current
                  .filter(s => s.ownerIdx === myIdx2 && ownerIdx !== myIdx2)
                  .reduce((sum, s) => sum + s.unitsCurrent, 0);
                setHoverPanel({
                  playerIdx: ownerIdx, pid, name: p.name, color: p.color,
                  units: p.units, coins: p.coins || 0, pixels: p.pixels,
                  isBot: p.is_bot,
                  buildings: buildingsRef.current.filter(b => b.ownerIdx === ownerIdx),
                  attackingTroops: Math.floor(attackingTroops),
                });
              }
            }
          } else {
            setHoverPanel(null);
          }
        }
      } else {
        if (hoverGridRef.current !== -1) { hoverGridRef.current = -1; setHoverPanel(null); }
      }
    }
    function onMouseUp() { dragRef.current.active = false; }
    function onKeyDown(e: KeyboardEvent) {
      keysRef.current.add(e.key.toLowerCase());
      if (e.key === "c" || e.key === "C") {
        const myIdx2 = playerIndexRef.current.get(playerId); if (myIdx2 === undefined) return;
        const gr = ownerGridRef.current; let sx = 0, sy = 0, cnt = 0;
        for (let i = 0; i < gr.length; i++) if (gr[i] === myIdx2) { sx += i % GRID_W; sy += Math.floor(i / GRID_W); cnt++; }
        if (cnt === 0) return;
        const mr2 = mapRectRef.current;
        const wx = mr2.x + (sx / cnt / GRID_W) * mr2.w, wy = mr2.y + (sy / cnt / GRID_H) * mr2.h;
        camRef.current.x = canvas!.width / 2 - wx * camRef.current.zoom;
        camRef.current.y = canvas!.height / 2 - wy * camRef.current.zoom;
      }
      if (e.key === "Escape") {
        setPlaceMode(null); placeModeRef.current = null;
        setBombMode(null); bombModeRef.current = null;
        setContextMenu(null);
      }
      const num = parseInt(e.key);
      if (num >= 1 && num <= 8) {
        const btype = TOOLBAR[num - 1];
        if (btype) {
          if (placeModeRef.current?.type === btype) { setPlaceMode(null); placeModeRef.current = null; }
          else { setPlaceMode({ type: btype }); placeModeRef.current = { type: btype }; setBombMode(null); bombModeRef.current = null; }
        }
      }
      if (e.key === "q" || e.key === "Q") { setUnitType("infantry"); unitTypeRef.current = "infantry"; }
      if (e.key === "e" || e.key === "E") { setUnitType("tank"); unitTypeRef.current = "tank"; }
      if (e.key === "r" || e.key === "R") { setUnitType("warship"); unitTypeRef.current = "warship"; }
    }
    function onKeyUp(e: KeyboardEvent) { keysRef.current.delete(e.key.toLowerCase()); }

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      canvas.removeEventListener("wheel", onWheel); canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby.id, lobby.host_id, lobby.difficulty, playerId]);

  // ── Plant starter ─────────────────────────────────────────────────────────
  function plantStarter(centerIdx: number, ownerIdx: number) {
    const mask = landMaskRef.current; if (!mask) return;
    const grid = ownerGridRef.current, str = strengthGridRef.current;
    const cx = centerIdx % GRID_W, cy = Math.floor(centerIdx / GRID_W);
    const claims: { i: number; o: number; s: number }[] = [];
    for (let dy = -STARTER_RADIUS; dy <= STARTER_RADIUS; dy++) {
      for (let dx = -STARTER_RADIUS; dx <= STARTER_RADIUS; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
        const i = y * GRID_W + x;
        if (mask[i] && grid[i] === -1) { grid[i] = ownerIdx; str[i] = MAX_STRENGTH; claims.push({ i, o: ownerIdx, s: MAX_STRENGTH }); }
      }
    }
    if (claims.length > 0) channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });
  }

  // ── Launch squad (land attack) ────────────────────────────────────────────
  function launchSquad(targetGridIdx: number, fromGridIdx: number, ownerIdx: number, ownerPid: string, targetName?: string) {
    const me = playersRef.current.get(ownerPid); if (!me) return;
    const sendUnits = Math.max(1, Math.floor(me.units * sendPctRef.current / 100));
    if (sendUnits < 1) { notify("Not enough units", "error"); return; }

    const mr = mapRectRef.current;
    const squad: Squad = {
      id: crypto.randomUUID(), ownerIdx, ownerPid,
      unitType: unitTypeRef.current,
      unitsStart: sendUnits, unitsCurrent: sendUnits,
      targetGridIdx, fromGridIdx, progress: 0, isNaval: false,
      targetName,
      screenFromX: mr.x + (fromGridIdx % GRID_W + 0.5) / GRID_W * mr.w,
      screenFromY: mr.y + (Math.floor(fromGridIdx / GRID_W) + 0.5) / GRID_H * mr.h,
      screenToX:   mr.x + (targetGridIdx % GRID_W + 0.5) / GRID_W * mr.w,
      screenToY:   mr.y + (Math.floor(targetGridIdx / GRID_W) + 0.5) / GRID_H * mr.h,
    };
    squadsRef.current = [...squadsRef.current, squad];
    setMySquads([...squadsRef.current.filter(s => s.ownerPid === playerId)]);
    channelRef.current?.send({ type: "broadcast", event: "squad", payload: squad });
    me.units = Math.max(0, me.units - sendUnits);
    supabase.from("lobby_players").update({ units: me.units }).eq("lobby_id", lobby.id).eq("player_id", ownerPid);
    if (targetName) notify(`${sendUnits} troops sent to attack ${targetName}!`, "success");
    else notify(`${sendUnits} troops marching!`, "success");
  }

  // ── Naval attack ──────────────────────────────────────────────────────────
  function launchShip(targetIdx: number, ownerIdx: number, ownerPid: string) {
    const coast = coastMaskRef.current; if (!coast) return;
    const mask = landMaskRef.current; if (!mask) return;

    const grid = ownerGridRef.current;
    // Departure: nearest own coast tile
    let bestFrom = -1, bestDist = Infinity;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] !== ownerIdx || !coast[i]) continue;
      const d = Math.abs(i % GRID_W - targetIdx % GRID_W) + Math.abs(Math.floor(i / GRID_W) - Math.floor(targetIdx / GRID_W));
      if (d < bestDist) { bestDist = d; bestFrom = i; }
    }
    if (bestFrom === -1) { notify("Need a coastal tile to launch ships", "error"); return; }

    // Landing: find nearest coast on target area (enemy or neutral)
    let landingIdx = targetIdx;
    if (!coast[targetIdx]) {
      let nearestCoast = -1, nearestDist = Infinity;
      const tx = targetIdx % GRID_W, ty = Math.floor(targetIdx / GRID_W);
      for (let i = 0; i < coast.length; i++) {
        if (!coast[i] || grid[i] === ownerIdx) continue;
        const d = Math.abs(i % GRID_W - tx) + Math.abs(Math.floor(i / GRID_W) - ty);
        if (d < nearestDist) { nearestDist = d; nearestCoast = i; }
      }
      if (nearestCoast !== -1 && nearestDist < 30) landingIdx = nearestCoast;
    }

    const mr = mapRectRef.current, cW = mr.w / GRID_W, cH = mr.h / GRID_H;
    const me = playersRef.current.get(ownerPid); if (!me) return;
    const sendUnits = Math.max(1, Math.floor(me.units * sendPctRef.current / 100));
    const dist = Math.abs(bestFrom % GRID_W - landingIdx % GRID_W) + Math.abs(Math.floor(bestFrom / GRID_W) - Math.floor(landingIdx / GRID_W));

    const ship: Ship = {
      id: crypto.randomUUID(), ownerIdx,
      fromX: mr.x + (bestFrom % GRID_W + 0.5) * cW, fromY: mr.y + (Math.floor(bestFrom / GRID_W) + 0.5) * cH,
      toX:   mr.x + (landingIdx % GRID_W + 0.5) * cW, toY: mr.y + (Math.floor(landingIdx / GRID_W) + 0.5) * cH,
      units: sendUnits, targetGridIdx: landingIdx, progress: 0, distanceTiles: Math.max(1, dist),
    };
    shipsRef.current = [...shipsRef.current, ship];
    channelRef.current?.send({ type: "broadcast", event: "ship", payload: ship });
    me.units = Math.max(0, me.units - sendUnits);
    supabase.from("lobby_players").update({ units: me.units }).eq("lobby_id", lobby.id).eq("player_id", ownerPid);
    const etaSec = Math.round(dist / (SHIP_TILES_PER_MS * 1000));
    notify(`Fleet of ${sendUnits} launched — ETA ~${etaSec}s`, "success");
  }

  // ── Drop bomb ─────────────────────────────────────────────────────────────
  function dropBomb(targetIdx: number, btype: BombType, ownerPid: string) {
    const me = playersRef.current.get(ownerPid); if (!me) return;
    const cost = BOMB_COST[btype];
    if ((me.coins || 0) < cost) { notify(`Need ${cost} coins`, "error"); return; }
    const myIdx = playerIndexRef.current.get(ownerPid);
    const grid = ownerGridRef.current, str = strengthGridRef.current;
    const tx = targetIdx % GRID_W, ty = Math.floor(targetIdx / GRID_W), radius = BOMB_RADIUS[btype];
    let intercepted = false;
    buildingsRef.current.forEach(b => {
      if (b.type !== "sam_launcher") return;
      const cur = grid[b.gridIdx]; if (cur === myIdx || cur === -1) return;
      const bx = b.gridIdx % GRID_W, by = Math.floor(b.gridIdx / GRID_W);
      if (Math.abs(bx - tx) + Math.abs(by - ty) < radius * 3 && Math.random() < 0.4) intercepted = true;
    });
    if (intercepted) { notify("Intercepted by SAM!", "error"); return; }
    me.coins = (me.coins || 0) - cost;
    supabase.from("lobby_players").update({ coins: me.coins }).eq("lobby_id", lobby.id).eq("player_id", ownerPid);
    const mask = landMaskRef.current; if (!mask) return;
    const affected: number[] = [];
    for (let dy2 = -radius; dy2 <= radius; dy2++) for (let dx2 = -radius; dx2 <= radius; dx2++) {
      if (Math.abs(dx2) + Math.abs(dy2) > radius) continue;
      const nx = tx + dx2, ny = ty + dy2;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H || !mask[ny * GRID_W + nx]) continue;
      affected.push(ny * GRID_W + nx);
    }
    const destroyed = buildingsRef.current.filter(b => affected.includes(b.gridIdx));
    buildingsRef.current = buildingsRef.current.filter(b => !affected.includes(b.gridIdx));
    setBuildings(prev => prev.filter(b => !affected.includes(b.gridIdx)));
    if (destroyed.length > 0) notify(`${destroyed.length} building(s) destroyed!`, "info");
    affected.forEach(i => { grid[i] = -1; str[i] = 0; });
    channelRef.current?.send({ type: "broadcast", event: "claim", payload: affected.map(i => ({ i, o: -1, s: 0 })) });
    const radStr = BOMB_RAD[btype];
    const newZones: RadZone[] = affected.map(i => ({ gridIdx: i, strength: radStr, decay: btype === "dirty" ? 0.05 : 0.3 }));
    radZonesRef.current = [...radZonesRef.current, ...newZones];
    channelRef.current?.send({ type: "broadcast", event: "rad_zone", payload: newZones });
    const mr = mapRectRef.current, cam = camRef.current;
    const scx = cam.x + (mr.x + (tx + 0.5) / GRID_W * mr.w) * cam.zoom;
    const scy = cam.y + (mr.y + (ty + 0.5) / GRID_H * mr.h) * cam.zoom;
    const bombCol = btype === "dirty" ? "#22c55e" : btype === "hydrogen" ? "#818cf8" : "#f97316";
    for (let pi = 0; pi < 80; pi++) {
      const ang = Math.random() * Math.PI * 2, spd = 1 + Math.random() * 5;
      particlesRef.current.push({ x: scx, y: scy, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, life: 1, color: bombCol });
    }
    notify(`${btype.charAt(0).toUpperCase() + btype.slice(1)} bomb detonated!`, "success");
  }

  function getBuildCost(type: BuildingType, ownerIdx: number): [number, number] {
    const [bc, bu] = BUILD_COST[type];
    const n = buildingsRef.current.filter(b => b.ownerIdx === ownerIdx && b.type === type).length;
    return [Math.round(bc * (1 + n * 0.5)), Math.round(bu * (1 + n * 0.5))];
  }

  function doPlaceBuilding(gx: number, gy: number, type: BuildingType) {
    setPlaceMode(null); placeModeRef.current = null;
    const me = playersRef.current.get(playerId); if (!me) return;
    const myIdx = playerIndexRef.current.get(playerId); if (myIdx === undefined) return;
    const gridIdx = gy * GRID_W + gx;
    if (ownerGridRef.current[gridIdx] !== myIdx) { notify("Build on your own territory", "error"); return; }
    if (buildingsRef.current.some(b => b.gridIdx === gridIdx)) { notify("Already a building here", "error"); return; }
    if (type === "port" || type === "naval_base") {
      const coast = coastMaskRef.current;
      if (!coast || !coast[gridIdx]) { notify("Ports need a coastal tile", "error"); return; }
    }
    const [cc, cu] = getBuildCost(type, myIdx);
    if ((me.coins || 0) < cc) { notify(`Need ${cc} coins`, "error"); return; }
    if (me.units < cu) { notify(`Need ${cu} units`, "error"); return; }
    const building: Building = { type, ownerIdx: myIdx, gridIdx };
    setBuildings(prev => [...prev, building]); buildingsRef.current = [...buildingsRef.current, building];
    channelRef.current?.send({ type: "broadcast", event: "building", payload: building });
    me.coins = (me.coins || 0) - cc; me.units -= cu;
    supabase.from("lobby_players").update({ coins: me.coins, units: me.units }).eq("lobby_id", lobby.id).eq("player_id", playerId);
    notify(`${BUILDING_LABELS[type]} built!`, "success");
  }

  // ── Click handler ─────────────────────────────────────────────────────────
  function handleClick(e: React.MouseEvent) {
    if (dragMovedRef.current) { dragMovedRef.current = false; return; }
    setContextMenu(null);
    const coords = screenToGrid(e.clientX, e.clientY); if (!coords) return;
    const { gx, gy } = coords;
    const me = playersRef.current.get(playerId); if (!me) return;
    const myIdx = playerIndexRef.current.get(playerId); if (myIdx === undefined) return;
    const i = gy * GRID_W + gx;
    const mask = landMaskRef.current; if (!mask) return;

    if (bombModeRef.current) {
      dropBomb(i, bombModeRef.current, playerId);
      setBombMode(null); bombModeRef.current = null; return;
    }
    if (placeModeRef.current) {
      if (!mask[i]) { notify("Click on land", "error"); return; }
      doPlaceBuilding(gx, gy, placeModeRef.current.type); return;
    }

    const grid = ownerGridRef.current;
    let hasTerritory = false;
    for (let k = 0; k < grid.length; k++) if (grid[k] === myIdx) { hasTerritory = true; break; }
    if (!hasTerritory) {
      if (!mask[i]) { notify("Click on land to start", "error"); return; }
      if (grid[i] !== -1) { notify("Pick an unclaimed tile", "error"); return; }
      plantStarter(i, myIdx); setHasSpawned(true);
      notify("Empire founded! Click enemy territory to send troops.", "success"); return;
    }

    // Click own territory — do nothing (cancel would be right-click)
    if (grid[i] === myIdx) return;
    if (!mask[i]) { notify("Click on land", "error"); return; }

    // Determine attack target name
    const targetOwnerIdx = grid[i];
    let targetName: string | undefined;
    if (targetOwnerIdx >= 0) {
      const entry = [...playerIndexRef.current.entries()].find(([, v]) => v === targetOwnerIdx);
      if (entry) targetName = playersRef.current.get(entry[0])?.name;
    }

    // Warship — only if target is sea or you have port and it's overseas
    if (unitTypeRef.current === "warship") {
      const hasPort = buildingsRef.current.some(b => b.ownerIdx === myIdx && b.type === "port");
      if (!hasPort) { notify("Build a Port to use warships", "error"); return; }
      launchShip(i, myIdx, playerId); return;
    }

    // Check land reachability
    let reachable = false;
    {
      const reach = new Uint8Array(grid.length); const q: number[] = [];
      for (let k = 0; k < grid.length; k++) {
        if (grid[k] !== myIdx) continue;
        const x2 = k % GRID_W, y2 = Math.floor(k / GRID_W);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x2 + dx, ny = y2 + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const ni = ny * GRID_W + nx;
          if (!reach[ni] && mask[ni] && grid[ni] !== myIdx) { reach[ni] = 1; q.push(ni); }
        }
      }
      let h = 0;
      while (h < q.length) {
        const cur = q[h++]; if (cur === i) { reachable = true; break; }
        const x2 = cur % GRID_W, y2 = Math.floor(cur / GRID_W);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x2 + dx, ny = y2 + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const ni = ny * GRID_W + nx;
          if (!reach[ni] && mask[ni]) { reach[ni] = 1; q.push(ni); }
        }
      }
    }

    if (reachable) {
      // Find nearest border cell as launch point
      const owned: number[] = [];
      for (let k = 0; k < grid.length; k++) if (grid[k] === myIdx) owned.push(k);
      const border = owned.reduce((best, k) => {
        const d = Math.abs(k % GRID_W - i % GRID_W) + Math.abs(Math.floor(k / GRID_W) - Math.floor(i / GRID_W));
        return d < best.d ? { k, d } : best;
      }, { k: owned[0], d: Infinity });
      launchSquad(i, border.k, myIdx, playerId, targetName);
    } else {
      const hasPort = buildingsRef.current.some(b => b.ownerIdx === myIdx && b.type === "port");
      if (hasPort) { launchShip(i, myIdx, playerId); }
      else { notify("No land path — build a Port for naval attacks, or switch to Warship [R]", "error"); }
    }
  }

  // ── Right click — context menu ────────────────────────────────────────────
  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if (placeModeRef.current || bombModeRef.current) {
      setPlaceMode(null); setBombMode(null); placeModeRef.current = null; bombModeRef.current = null; return;
    }

    const coords = screenToGrid(e.clientX, e.clientY);
    if (!coords) { setContextMenu(null); return; }
    const { gx, gy } = coords;
    const i = gy * GRID_W + gx;
    const grid = ownerGridRef.current;
    const myIdx = playerIndexRef.current.get(playerId);
    const targetOwnerIdx = grid[i];
    if (targetOwnerIdx < 0 || targetOwnerIdx === myIdx) { setContextMenu(null); return; }
    const entry = [...playerIndexRef.current.entries()].find(([, v]) => v === targetOwnerIdx);
    if (!entry) { setContextMenu(null); return; }
    const [targetPid] = entry;
    const targetPlayer = playersRef.current.get(targetPid);
    if (!targetPlayer) { setContextMenu(null); return; }
    setContextMenu({ x: e.clientX, y: e.clientY, targetPlayerIdx: targetOwnerIdx, targetPlayerPid: targetPid, targetName: targetPlayer.name });
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const sortedPlayers = [...players].sort((a, b) => b.pixels - a.pixels);
  const me = playersRef.current.get(playerId);
  const myIdx = playerIndexRef.current.get(playerId);
  const hasSilo = myIdx !== undefined && buildingsRef.current.some(b => b.ownerIdx === myIdx && b.type === "missile_silo");

  // ── Game Over ─────────────────────────────────────────────────────────────
  if (isDead && !isSpectating) {
    return (
      <div className="relative h-screen w-screen overflow-hidden bg-[#0a1628] flex items-center justify-center">
        <div className="flex flex-col items-center gap-6 rounded-2xl border border-red-500/40 bg-card/95 px-10 py-8 shadow-2xl backdrop-blur-md text-center max-w-sm">
          <div className="text-6xl">💀</div>
          <div>
            <div className="text-2xl font-bold text-red-400 mb-1">Eliminated</div>
            <div className="text-sm text-muted-foreground">Your empire has fallen. Watch the remaining players or leave.</div>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setIsSpectating(true)} className="gap-2">👁 Spectate</Button>
            <Button variant="destructive" onClick={onLeave} className="gap-2"><LogOut className="h-4 w-4" /> Leave</Button>
          </div>
          <div className="w-full mt-2 border-t border-border/40 pt-3">
            <div className="text-xs font-semibold text-muted-foreground mb-2">Still alive</div>
            {sortedPlayers.filter(p => p.alive).map(p => (
              <div key={p.id} className="flex items-center gap-2 text-xs py-0.5">
                <span className="h-2 w-2 rounded-sm flex-shrink-0" style={{ backgroundColor: p.color }} />
                <span className="flex-1 text-left truncate">{p.name}</span>
                <span className="font-mono text-muted-foreground">{fmt(p.units)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-screen w-screen overflow-hidden bg-[#0a1628]" onClick={() => setContextMenu(null)}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: "default" }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      />

      {isSpectating && (
        <div className="absolute top-0 left-0 right-0 flex items-center justify-center gap-4 bg-black/70 py-2 text-sm text-yellow-300 font-bold z-20">
          👁 Spectating
          <Button size="sm" variant="destructive" onClick={onLeave} className="h-6 px-2 text-xs gap-1"><LogOut className="h-3 w-3" />Leave</Button>
        </div>
      )}

      {/* Spawn prompt */}
      {me && !hasSpawned && !isDead && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 rounded-xl border border-primary/60 bg-card/95 px-6 py-4 text-center shadow-2xl backdrop-blur-md pointer-events-none">
          <div className="text-lg font-bold mb-1">Pick your starting tile</div>
          <div className="text-sm text-muted-foreground">Click any unclaimed land tile to found your empire</div>
        </div>
      )}

      {/* Leaderboard */}
      <div className="absolute left-3 top-3 w-56 rounded-xl border border-border/60 bg-card/85 p-2 shadow-lg backdrop-blur-md z-10">
        <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Leaderboard</div>
        {sortedPlayers.slice(0, 10).map((p, i) => (
          <div key={p.id} className={`flex items-center gap-2 rounded px-2 py-0.5 text-xs ${p.player_id === playerId ? "bg-primary/15" : ""} ${!p.alive ? "opacity-40 line-through" : ""}`}>
            <span className="w-4 text-right font-mono text-muted-foreground">{i + 1}</span>
            <span className="h-2 w-2 rounded-sm flex-shrink-0" style={{ backgroundColor: p.color }} />
            <span className="flex-1 truncate font-medium">{p.name}</span>
            <span className="font-mono text-muted-foreground text-[10px]">{p.alive ? `${p.pixels}t` : "☠"}</span>
          </div>
        ))}
      </div>

      {/* Hover panel — right side */}
      {hoverPanel && hoverPanel.playerIdx !== myIdx && (
        <div className="absolute right-3 top-3 w-64 rounded-xl border border-border/60 bg-card/92 p-3 shadow-xl backdrop-blur-md z-10 pointer-events-none">
          <div className="flex items-center gap-2 mb-2">
            <span className="h-3 w-3 rounded-sm flex-shrink-0" style={{ backgroundColor: hoverPanel.color }} />
            <span className="font-bold text-sm truncate">{hoverPanel.name}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">{hoverPanel.isBot ? "Bot" : "Player"} · Neutral</span>
          </div>
          <div className="grid grid-cols-2 gap-1 text-xs mb-2">
            <div className="rounded bg-background/60 px-2 py-1">
              <div className="text-muted-foreground text-[9px]">TROOPS</div>
              <div className="font-mono font-bold">{fmt(hoverPanel.units)}</div>
            </div>
            <div className="rounded bg-yellow-500/10 border border-yellow-500/30 px-2 py-1">
              <div className="text-muted-foreground text-[9px]">GOLD</div>
              <div className="font-mono font-bold text-yellow-400">{fmt(hoverPanel.coins)}</div>
            </div>
            <div className="rounded bg-background/60 px-2 py-1">
              <div className="text-muted-foreground text-[9px]">TILES</div>
              <div className="font-mono font-bold">{hoverPanel.pixels}</div>
            </div>
            {mySquads.filter(s => s.targetName === hoverPanel.name).length > 0 && (
              <div className="rounded bg-red-500/10 border border-red-500/30 px-2 py-1">
                <div className="text-muted-foreground text-[9px]">YOUR ATTACK</div>
                <div className="font-mono font-bold text-red-400">
                  {fmt(mySquads.filter(s => s.targetName === hoverPanel.name).reduce((sum, s) => sum + Math.floor(s.unitsCurrent), 0))}
                </div>
              </div>
            )}
          </div>
          {hoverPanel.buildings.length > 0 && (
            <div className="border-t border-border/40 pt-2">
              <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Buildings</div>
              {hoverPanel.buildings.map((b, bi) => (
                <div key={bi} className="flex items-center gap-1 text-[10px] py-0.5">
                  <span>{BUILDING_ICONS[b.type]}</span>
                  <span className="flex-1">{BUILDING_LABELS[b.type]}</span>
                  <span className="text-muted-foreground text-[9px] truncate max-w-[100px]">{BUILD_STAT[b.type]}</span>
                </div>
              ))}
            </div>
          )}
          <div className="text-[9px] text-muted-foreground mt-2 border-t border-border/40 pt-1">Right-click for options</div>
        </div>
      )}

      {/* Active squads progress bars — bottom left stack */}
      {!isSpectating && mySquads.length > 0 && (
        <div className="absolute left-3 bottom-32 flex flex-col gap-1.5 z-10 max-w-[220px]">
          {mySquads.map(sq => {
            const healthPct = sq.unitsCurrent / sq.unitsStart;
            const icons: Record<UnitType, string> = { infantry: "🪖", tank: "🚜", warship: "🚢" };
            return (
              <div key={sq.id} className="rounded-lg border border-border/60 bg-card/90 backdrop-blur-md px-2.5 py-1.5 shadow">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-sm">{icons[sq.unitType]}</span>
                  <span className="text-xs font-bold truncate flex-1">{sq.targetName ?? "Territory"}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{Math.floor(sq.unitsCurrent)}/{sq.unitsStart}</span>
                  <button
                    onClick={() => { squadsRef.current = squadsRef.current.filter(s => s.id !== sq.id); setMySquads(prev => prev.filter(s => s.id !== sq.id)); }}
                    className="h-4 w-4 rounded text-muted-foreground hover:text-destructive flex items-center justify-center">
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
                {/* Progress bar */}
                <div className="relative h-1.5 w-full rounded-full bg-muted overflow-hidden mb-0.5">
                  <div className="absolute left-0 top-0 h-full rounded-full bg-blue-500 transition-all" style={{ width: `${sq.progress * 100}%` }} />
                </div>
                {/* Health bar */}
                <div className="relative h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div className="absolute left-0 top-0 h-full rounded-full transition-all"
                    style={{ width: `${healthPct * 100}%`, backgroundColor: healthPct > 0.5 ? "#22c55e" : healthPct > 0.25 ? "#f59e0b" : "#ef4444" }} />
                </div>
                <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5">
                  <span>March {Math.round(sq.progress * 100)}%</span>
                  <span>HP {Math.round(healthPct * 100)}%</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="absolute z-50 rounded-xl border border-border/80 bg-card/98 shadow-2xl backdrop-blur-md overflow-hidden min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <div className="px-3 py-2 border-b border-border/40 text-xs font-bold text-muted-foreground">{contextMenu.targetName}</div>
          {[
            { icon: <Swords className="h-3.5 w-3.5" />, label: "Attack", color: "text-red-400", action: () => {
              const myIdx2 = playerIndexRef.current.get(playerId); if (myIdx2 === undefined) return;
              const grid = ownerGridRef.current;
              const owned: number[] = [];
              for (let k = 0; k < grid.length; k++) if (grid[k] === myIdx2) owned.push(k);
              const enemyTiles: number[] = [];
              for (let k = 0; k < grid.length; k++) if (grid[k] === contextMenu.targetPlayerIdx) enemyTiles.push(k);
              if (enemyTiles.length === 0 || owned.length === 0) return;
              const target = enemyTiles[Math.floor(enemyTiles.length / 2)];
              const border = owned.reduce((best, k) => { const d = Math.abs(k % GRID_W - target % GRID_W) + Math.abs(Math.floor(k / GRID_W) - Math.floor(target / GRID_W)); return d < best.d ? { k, d } : best; }, { k: owned[0], d: Infinity });
              launchSquad(target, border.k, myIdx2, playerId, contextMenu.targetName);
              setContextMenu(null);
            }},
            { icon: <Handshake className="h-3.5 w-3.5" />, label: "Request Alliance", color: "text-green-400", action: () => {
              notify(`Alliance request sent to ${contextMenu.targetName}`, "info");
              channelRef.current?.send({ type: "broadcast", event: "alliance_req", payload: { from: playerId, to: contextMenu.targetPlayerPid } });
              setContextMenu(null);
            }},
            { icon: <ArrowLeftRight className="h-3.5 w-3.5" />, label: "Propose Trade", color: "text-yellow-400", action: () => {
              notify(`Trade proposal sent to ${contextMenu.targetName}`, "info");
              channelRef.current?.send({ type: "broadcast", event: "trade_req", payload: { from: playerId, to: contextMenu.targetPlayerPid } });
              setContextMenu(null);
            }},
            { icon: <MessageSquare className="h-3.5 w-3.5" />, label: "Send Message", color: "text-blue-400", action: () => {
              const msg = prompt(`Message to ${contextMenu.targetName}:`);
              if (msg) {
                channelRef.current?.send({ type: "broadcast", event: "player_msg", payload: { from: playerId, to: contextMenu.targetPlayerPid, text: msg } });
                notify("Message sent", "success");
              }
              setContextMenu(null);
            }},
          ].map(item => (
            <button key={item.label} onClick={item.action}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs hover:bg-secondary/80 transition-colors ${item.color}`}>
              {item.icon}
              <span className="font-medium">{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {!isSpectating && (
        <Button onClick={onLeave} variant="secondary" size="sm" className="absolute right-3 bottom-3 gap-1.5 bg-card/85 backdrop-blur-md z-10">
          <LogOut className="h-3.5 w-3.5" />Leave
        </Button>
      )}

      {/* Bottom HUD */}
      {!isSpectating && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-10">
          {/* Building toolbar */}
          <div className="flex gap-1 rounded-lg border border-border/60 bg-card/90 px-2 py-1.5 backdrop-blur-md shadow-lg">
            {TOOLBAR.map((btype, idx) => {
              const [cc, cu] = myIdx !== undefined ? getBuildCost(btype, myIdx) : [BUILD_COST[btype][0], BUILD_COST[btype][1]];
              const count = myIdx !== undefined ? buildingsRef.current.filter(b => b.ownerIdx === myIdx && b.type === btype).length : 0;
              const canAfford = me && (me.coins || 0) >= cc && me.units >= cu;
              const isActive = placeMode?.type === btype;
              return (
                <button key={btype}
                  title={`[${idx + 1}] ${BUILDING_LABELS[btype]}\n${BUILD_STAT[btype]}\nCost: ${cc}💰${cu > 0 ? ` ${cu}⚔` : ""}`}
                  disabled={!canAfford}
                  onClick={() => {
                    if (isActive) { setPlaceMode(null); placeModeRef.current = null; return; }
                    setPlaceMode({ type: btype }); placeModeRef.current = { type: btype };
                    setBombMode(null); bombModeRef.current = null;
                  }}
                  className={`flex flex-col items-center justify-center w-14 h-14 rounded border transition-all relative ${isActive ? "border-yellow-400 bg-yellow-400/20" : "border-border/60 bg-background/60 hover:bg-secondary/80"} disabled:opacity-35 disabled:cursor-not-allowed`}>
                  <span className="absolute top-0.5 left-1 text-[9px] text-muted-foreground font-mono">{idx + 1}</span>
                  <span className="text-lg">{BUILDING_ICONS[btype]}</span>
                  <span className="text-[9px] font-mono text-muted-foreground leading-tight">{count > 0 ? `${count}× ` : ""}{cc}💰</span>
                  <span className="text-[8px] text-muted-foreground/70 leading-none truncate w-full text-center px-0.5">{BUILD_STAT[btype].split("·")[0].trim()}</span>
                </button>
              );
            })}
            {hasSilo && (["atom", "hydrogen", "dirty"] as BombType[]).map(bt => {
              const cost = BOMB_COST[bt]; const isActive = bombMode === bt;
              const icons: Record<BombType, string> = { atom: "☢", hydrogen: "💥", dirty: "☣" };
              return (
                <button key={bt} title={`${bt} bomb — ${cost}💰`} disabled={!me || (me.coins || 0) < cost}
                  onClick={() => {
                    if (isActive) { setBombMode(null); bombModeRef.current = null; return; }
                    setBombMode(bt); bombModeRef.current = bt;
                    setPlaceMode(null); placeModeRef.current = null;
                  }}
                  className={`flex flex-col items-center justify-center w-14 h-14 rounded border transition-all ${isActive ? "border-red-400 bg-red-400/20" : "border-red-800/60 bg-background/60 hover:bg-red-900/30"} disabled:opacity-35 disabled:cursor-not-allowed`}>
                  <span className="text-lg">{icons[bt]}</span>
                  <span className="text-[9px] font-mono text-red-400">{cost}💰</span>
                </button>
              );
            })}
          </div>

          {/* Control bar */}
          <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/90 px-4 py-2 backdrop-blur-md shadow-lg">
            {me && (
              <div className="flex items-center gap-2 text-xs">
                <span className="h-3 w-3 rounded-sm flex-shrink-0" style={{ backgroundColor: me.color }} />
                <div className="flex flex-col">
                  <span className="font-bold leading-none">{me.name}</span>
                  <span className="font-mono text-muted-foreground text-[10px]">⚔{fmt(me.units)} · 💰{fmt(me.coins || 0)} · {me.pixels}t</span>
                </div>
              </div>
            )}
            <div className="h-8 w-px bg-border" />

            {/* Unit type */}
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Unit [Q/E/R]</span>
              <div className="flex gap-1">
                {(["infantry", "tank", "warship"] as UnitType[]).map((ut, ki) => {
                  const icons: Record<UnitType, string> = { infantry: "🪖", tank: "🚜", warship: "🚢" };
                  const keys = ["Q", "E", "R"];
                  const hints: Record<UnitType, string> = { infantry: "1× power", tank: "2.5× power", warship: "Naval only · needs Port" };
                  return (
                    <button key={ut} title={`[${keys[ki]}] ${ut} — ${hints[ut]}`}
                      onClick={() => { setUnitType(ut); unitTypeRef.current = ut; }}
                      className={`flex flex-col items-center justify-center w-9 h-9 rounded border text-sm transition-all relative ${unitType === ut ? "border-primary bg-primary/20" : "border-border/60 bg-background/60 hover:bg-secondary/80"}`}>
                      <span className="absolute top-0 left-0.5 text-[8px] text-muted-foreground">{keys[ki]}</span>
                      {icons[ut]}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="h-8 w-px bg-border" />

            {/* Send percentage */}
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Send %</span>
              <div className="flex items-center gap-1.5">
                <input type="range" min={5} max={100} step={5} value={sendPct}
                  onChange={e => { setSendPct(+e.target.value); sendPctRef.current = +e.target.value; }}
                  className="w-24 accent-primary" />
                <span className="w-10 text-right font-mono text-xs font-bold text-primary">{sendPct}%</span>
              </div>
              {me && <span className="text-[9px] text-muted-foreground">{fmt(Math.floor(me.units * sendPct / 100))} troops</span>}
            </div>
            <div className="h-8 w-px bg-border" />

            {/* Camera */}
            <div className="flex gap-1">
              {[
                { title: "Zoom in", label: "+", fn: () => { const c = camRef.current; c.zoom = Math.min(10, c.zoom * 1.25); } },
                { title: "Zoom out", label: "−", fn: () => { const c = camRef.current; c.zoom = Math.max(0.3, c.zoom * 0.8); } },
                { title: "Reset view", label: "⌂", fn: () => { camRef.current = { x: 0, y: 0, zoom: 1 }; } },
                { title: "Center on me [C]", label: "C", fn: () => {
                    const myIdx2 = playerIndexRef.current.get(playerId); if (myIdx2 === undefined) return;
                    const gr = ownerGridRef.current; let sx = 0, sy = 0, cnt = 0;
                    for (let i = 0; i < gr.length; i++) if (gr[i] === myIdx2) { sx += i % GRID_W; sy += Math.floor(i / GRID_W); cnt++; }
                    if (cnt === 0) return;
                    const mr2 = mapRectRef.current; const cv = canvasRef.current;
                    const wx = mr2.x + (sx / cnt / GRID_W) * mr2.w, wy = mr2.y + (sy / cnt / GRID_H) * mr2.h;
                    camRef.current.x = (cv?.width ?? 0) / 2 - wx * camRef.current.zoom;
                    camRef.current.y = (cv?.height ?? 0) / 2 - wy * camRef.current.zoom;
                  }},
              ].map(b => (
                <button key={b.label} title={b.title} onClick={b.fn}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-sm hover:bg-secondary">
                  {b.label}
                </button>
              ))}
            </div>
            <div className="h-8 w-px bg-border" />
            <div className="text-[9px] text-muted-foreground leading-tight">
              <div>WASD/Arrows: pan</div>
              <div>Esc: cancel · C: center</div>
              <div>Right-click: options</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
