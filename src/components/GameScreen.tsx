import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { GRID_W, GRID_H } from "@/game/constants";
import { loadLandMask } from "@/game/landMask";
import worldMap from "@/assets/map-world.jpg";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────
type Lobby = { id: string; code: string; host_id: string; map_id: string; difficulty: string };
type LobbyPlayer = {
  id: string; player_id: string; name: string; color: string;
  is_bot: boolean; dot_x: number; dot_y: number;
  units: number; coins: number; pixels: number; alive: boolean;
};
type BuildingType = "city" | "defense_post" | "port" | "fort" | "factory" | "missile_silo" | "sam_launcher" | "naval_base";
type Building = { type: BuildingType; ownerIdx: number; gridIdx: number };
type BombType = "atom" | "hydrogen" | "dirty";
type Ship = { id: string; ownerIdx: number; fromX: number; fromY: number; toX: number; toY: number; units: number; targetGridIdx: number; progress: number; distanceTiles: number };
type RadZone = { gridIdx: number; strength: number; decay: number };
type PlaceMode = { type: BuildingType } | null;
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };

// ─── The Real Territorial.io Engine ──────────────────────────────────────────
//
// ONE number per player: BALANCE (troops/money/pop — it's all the same thing).
// Balance grows via compound interest every tick, scaled by territory size.
// Attack slider = % of balance put on the ENTIRE border simultaneously.
// Border tiles flip when attack pressure > defense. Defense is 2× stronger.
// Border set is maintained INCREMENTALLY — never scan the full grid.
//
// This is exactly how territorial.io works and why it feels alive.

// Interest: starts at 7% per tick, decays to ~1% over 107s. After that, territory size matters.
const TICK_MS            = 560;      // territorial.io ticks every 560ms
const INTEREST_INITIAL   = 0.07;     // 7% interest at game start
const INTEREST_FLOOR     = 0.01;     // 1% floor
const INTEREST_DECAY_MS  = 107_000;  // decay over 107 seconds
const SOFT_CAP_MULT      = 100;      // balance soft cap = 100 × pixels
const HARD_CAP_MULT      = 150;      // balance hard cap = 150 × pixels
const DEFENSE_MULT       = 2.0;      // defense is 2× attack (territorial.io rule)
const FORT_DEFENSE_BONUS = 3.0;
const DEFPOST_BONUS      = 1.8;
const STARTER_RADIUS     = 5;
const SHIP_TILES_PER_MS  = 0.003;

// Buildings
const BUILD_COST: Record<BuildingType, [number, number]> = {
  city: [80, 0], defense_post: [30, 20], port: [60, 0], fort: [40, 40],
  factory: [70, 0], missile_silo: [200, 0], sam_launcher: [90, 0], naval_base: [120, 0],
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
const DIFFICULTY_MULT: Record<string, number> = { relaxed: 0.6, balanced: 1.0, intense: 1.5 };

function hexRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}
function fmt(n: number) { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${Math.floor(n)}`; }

interface GameScreenProps { lobby: Lobby; playerId: string; onLeave: () => void }

// ─────────────────────────────────────────────────────────────────────────────
export function GameScreen({ lobby, playerId, onLeave }: GameScreenProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [players,      setPlayers]      = useState<LobbyPlayer[]>([]);
  const [,             setTick]         = useState(0);
  const [attackPct,    setAttackPct]    = useState(20);   // % of balance on border — territorial.io default
  const [placeMode,    setPlaceMode]    = useState<PlaceMode>(null);
  const [bombMode,     setBombMode]     = useState<BombType | null>(null);
  const [buildings,    setBuildings]    = useState<Building[]>([]);
  const [hasSpawned,   setHasSpawned]   = useState(false);
  const [isDead,       setIsDead]       = useState(false);
  const [isSpectating, setIsSpectating] = useState(false);
  const [attackingPlayer, setAttackingPlayer] = useState<string | null>(null);

  // Keep refs in sync with state for use inside rAF loops
  const attackPctRef   = useRef(20);
  const buildingsRef   = useRef<Building[]>([]);
  const placeModeRef   = useRef<PlaceMode>(null);
  const bombModeRef    = useRef<BombType | null>(null);

  useEffect(() => { attackPctRef.current  = attackPct;  }, [attackPct]);
  useEffect(() => { buildingsRef.current  = buildings;  }, [buildings]);
  useEffect(() => { placeModeRef.current  = placeMode;  }, [placeMode]);
  useEffect(() => { bombModeRef.current   = bombMode;   }, [bombMode]);

  // ── Grid state ────────────────────────────────────────────────────────────
  // ownerGrid: which player owns each tile (-1 = unclaimed)
  // balanceGrid: each tile stores the owner's current balance (for rendering strength)
  const ownerGridRef    = useRef<Int16Array>(new Int16Array(GRID_W * GRID_H).fill(-1));
  const landMaskRef     = useRef<Uint8Array | null>(null);
  const coastMaskRef    = useRef<Uint8Array | null>(null);

  // THE KEY DATA STRUCTURE: border tile sets per player
  // Instead of scanning the full grid, we maintain which tiles are on each player's border
  // A border tile = owned tile that has at least one non-owned land neighbor
  const borderTilesRef  = useRef<Map<number, Set<number>>>(new Map()); // ownerIdx → Set<gridIdx>

  // Per-player balance (the single resource — equivalent to territorial.io "balance")
  const balanceRef      = useRef<Map<number, number>>(new Map()); // ownerIdx → balance
  // Per-player pixel count (maintained incrementally)
  const pixelCountRef   = useRef<Map<number, number>>(new Map()); // ownerIdx → pixel count

  // Bot attack targets: which player/direction each bot is attacking
  const botTargetsRef   = useRef<Map<number, number>>(new Map()); // botOwnerIdx → targetOwnerIdx (-1 = neutral)
  // Human player attack target
  const myAttackTargetRef = useRef<number>(-1); // ownerIdx to attack (-1 = neutral/all)

  const radZonesRef     = useRef<RadZone[]>([]);
  const shipsRef        = useRef<Ship[]>([]);
  const playersRef      = useRef<Map<string, LobbyPlayer>>(new Map());
  const playerIndexRef  = useRef<Map<string, number>>(new Map());
  const colorsRef       = useRef<[number, number, number][]>([]);
  const eliminatedRef   = useRef<Set<number>>(new Set());
  const gameStartRef    = useRef<number>(performance.now());
  const lastTickRef     = useRef<number>(0);
  const lastSyncRef     = useRef<number>(0);
  const lastBotRef      = useRef<number>(0);
  const channelRef      = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const camRef       = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef      = useRef({ active: false, startX: 0, startY: 0, camX: 0, camY: 0 });
  const dragMovedRef = useRef(false);
  const mapRectRef   = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const particlesRef = useRef<Particle[]>([]);
  const keysRef      = useRef<Set<string>>(new Set());

  const notify = (msg: string, kind: "info" | "error" | "success" = "info") => {
    if (kind === "error") toast.error(msg);
    else if (kind === "success") toast.success(msg);
    else toast(msg);
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  function buildCoastMask(mask: Uint8Array): Uint8Array {
    const coast = new Uint8Array(GRID_W * GRID_H);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % GRID_W, y = Math.floor(i / GRID_W);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
        const nx = x+dx, ny = y+dy;
        if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H||!mask[ny*GRID_W+nx]) { coast[i]=1; break; }
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

  // ── Update border set when a tile changes owner ───────────────────────────
  // This is called INSTEAD of scanning the whole grid.
  // O(1) per flip, not O(n) per frame.
  function updateBorderOnFlip(gridIdx: number, oldOwner: number, newOwner: number) {
    const mask = landMaskRef.current; if (!mask) return;
    const grid = ownerGridRef.current;
    const x = gridIdx % GRID_W, y = Math.floor(gridIdx / GRID_W);
    const DIRS = [[1,0],[-1,0],[0,1],[0,-1]] as const;

    // Remove from old owner's border set
    if (oldOwner >= 0) {
      borderTilesRef.current.get(oldOwner)?.delete(gridIdx);
    }

    // Add to new owner's border set if it has non-owned land neighbors
    if (newOwner >= 0) {
      if (!borderTilesRef.current.has(newOwner)) borderTilesRef.current.set(newOwner, new Set());
      let isBorder = false;
      for (const [dx,dy] of DIRS) {
        const nx=x+dx, ny=y+dy;
        if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
        const ni = ny*GRID_W+nx;
        if (mask[ni] && grid[ni] !== newOwner) { isBorder = true; break; }
      }
      if (isBorder) borderTilesRef.current.get(newOwner)!.add(gridIdx);
    }

    // Re-evaluate all 4 neighbors
    for (const [dx,dy] of DIRS) {
      const nx=x+dx, ny=y+dy;
      if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
      const ni = ny*GRID_W+nx;
      if (!mask[ni]) continue;
      const nOwner = grid[ni];
      if (nOwner < 0) continue;
      if (!borderTilesRef.current.has(nOwner)) borderTilesRef.current.set(nOwner, new Set());
      const bs = borderTilesRef.current.get(nOwner)!;
      // Check if this neighbor is still a border tile
      let stillBorder = false;
      const nnx2 = nx, nny2 = ny;
      for (const [dx2,dy2] of DIRS) {
        const nx2=nnx2+dx2, ny2=nny2+dy2;
        if (nx2<0||ny2<0||nx2>=GRID_W||ny2>=GRID_H) continue;
        const ni2 = ny2*GRID_W+nx2;
        if (mask[ni2] && grid[ni2] !== nOwner) { stillBorder = true; break; }
      }
      if (stillBorder) bs.add(ni); else bs.delete(ni);
    }
  }

  // ── Flip a tile (core operation) ──────────────────────────────────────────
  // Returns a claim record for broadcasting
  function flipTile(gridIdx: number, newOwner: number): { i: number; o: number } {
    const grid = ownerGridRef.current;
    const oldOwner = grid[gridIdx];
    grid[gridIdx] = newOwner;

    // Update pixel counts
    if (oldOwner >= 0) pixelCountRef.current.set(oldOwner, (pixelCountRef.current.get(oldOwner) ?? 1) - 1);
    if (newOwner >= 0) pixelCountRef.current.set(newOwner, (pixelCountRef.current.get(newOwner) ?? 0) + 1);

    updateBorderOnFlip(gridIdx, oldOwner, newOwner);
    return { i: gridIdx, o: newOwner };
  }

  // ── Check elimination ─────────────────────────────────────────────────────
  function checkElimination(lostOwnerIdx: number, killerIdx: number) {
    if (eliminatedRef.current.has(lostOwnerIdx)) return;
    if ((pixelCountRef.current.get(lostOwnerIdx) ?? 0) > 0) return;
    eliminatedRef.current.add(lostOwnerIdx);

    // Give killer 500 balance bonus
    const killerBal = balanceRef.current.get(killerIdx) ?? 0;
    balanceRef.current.set(killerIdx, killerBal + 500);

    const killerEntry = [...playerIndexRef.current.entries()].find(([,v]) => v === killerIdx);
    if (killerEntry?.[0] === playerId) notify("Enemy eliminated! +500 balance", "success");

    const myIdx = playerIndexRef.current.get(playerId);
    if (lostOwnerIdx === myIdx) setIsDead(true);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // THE REAL ENGINE: tickGame()
  //
  // Called every TICK_MS (560ms) — same cadence as territorial.io.
  //
  // For each player with territory:
  //   1. Compute interest income based on balance and pixel count
  //   2. Apply income, clamp to hard cap
  //   3. Compute attack pressure = balance × attackPct%
  //   4. Distribute attack pressure across all border tiles
  //   5. For each border tile: if pressure > neighbor defense → flip
  //
  // The magic: because we iterate actual border tiles (not the whole grid),
  // this is fast. 500 border tiles × 5 players = 2500 checks per tick.
  // Not 500,000 checks per frame.
  // ─────────────────────────────────────────────────────────────────────────
  function tickGame() {
    const mask = landMaskRef.current; if (!mask) return;
    const grid = ownerGridRef.current;
    const blds = buildingsRef.current;
    const diffMult = DIFFICULTY_MULT[lobby.difficulty] ?? 1;
    const elapsed = performance.now() - gameStartRef.current;

    const claims: { i: number; o: number }[] = [];
    const spawnParticles = (gridIdx: number, ownerIdx: number, count: number) => {
      const col = colorsRef.current[ownerIdx];
      if (!col) return;
      const mr = mapRectRef.current, cam = camRef.current;
      const wx = mr.x + ((gridIdx % GRID_W) + 0.5) / GRID_W * mr.w;
      const wy = mr.y + (Math.floor(gridIdx / GRID_W) + 0.5) / GRID_H * mr.h;
      const sx = cam.x + wx * cam.zoom, sy = cam.y + wy * cam.zoom;
      for (let k = 0; k < count; k++) {
        particlesRef.current.push({
          x: sx, y: sy,
          vx: (Math.random()-0.5)*2, vy: (Math.random()-0.5)*2,
          life: 1, color: `rgb(${col[0]},${col[1]},${col[2]})`,
        });
      }
    };

    // Interest rate: decays from 7% to 1% over 107s (territorial.io formula)
    const decayFactor = Math.max(0, 1 - elapsed / INTEREST_DECAY_MS);
    const baseInterest = INTEREST_FLOOR + (INTEREST_INITIAL - INTEREST_FLOOR) * decayFactor;

    playersRef.current.forEach((player, pid) => {
      const idx = playerIndexRef.current.get(pid); if (idx === undefined) return;
      if (!player.alive || eliminatedRef.current.has(idx)) return;

      const pixels = pixelCountRef.current.get(idx) ?? 0;
      if (pixels === 0 && idx === playerIndexRef.current.get(playerId)) return;

      let balance = balanceRef.current.get(idx) ?? 0;
      const softCap = pixels * SOFT_CAP_MULT;
      const hardCap = pixels * HARD_CAP_MULT;

      // ── Interest income (territorial.io compound interest) ──────────────
      // Interest reduces when above soft cap, hits 0 at hard cap
      let effectiveInterest = baseInterest * diffMult;
      if (balance > softCap && softCap > 0) {
        const capFraction = Math.min(1, (balance - softCap) / (hardCap - softCap));
        effectiveInterest *= (1 - capFraction);
      }
      // Territory income: flat bonus every tick based on pixel count
      const territoryIncome = Math.sqrt(pixels) * 2 * diffMult;

      // Building bonuses
      let buildingBonus = 0;
      blds.forEach(b => {
        if (b.ownerIdx !== idx) return;
        if (b.type === "factory") buildingBonus += 8;
        if (b.type === "city")    buildingBonus += 5;
        if (b.type === "port")    buildingBonus += 3;
      });

      balance = Math.min(hardCap, balance * (1 + effectiveInterest) + territoryIncome + buildingBonus);
      balanceRef.current.set(idx, balance);

      // ── Attack phase ─────────────────────────────────────────────────────
      const pct = pid === playerId ? attackPctRef.current / 100 : 0.25; // bots use 25%
      const attackBudget = balance * pct;
      if (attackBudget < 1) return;

      const borderSet = borderTilesRef.current.get(idx);
      if (!borderSet || borderSet.size === 0) return;

      // Determine attack target direction for this player
      const myTarget = pid === playerId ? myAttackTargetRef.current : (botTargetsRef.current.get(idx) ?? -1);

      // Attack pressure per border tile
      // Split budget across border tiles, weighted toward target direction
      const borderArr = [...borderSet];
      const pressurePerTile = attackBudget / Math.max(1, borderArr.length);

      let totalBalanceLost = 0;

      for (const borderIdx of borderArr) {
        const bx = borderIdx % GRID_W, by = Math.floor(borderIdx / GRID_W);
        const DIRS = [[1,0],[-1,0],[0,1],[0,-1]] as const;

        for (const [dx,dy] of DIRS) {
          const nx=bx+dx, ny=by+dy;
          if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
          const ni = ny*GRID_W+nx;
          if (!mask[ni] || grid[ni] === idx) continue;

          const neighborOwner = grid[ni];

          // If we have a specific target, skip tiles that don't touch it (unless neutral)
          if (myTarget >= 0 && neighborOwner !== myTarget && neighborOwner !== -1) continue;

          // Defense value: base = defender's balance / their border length
          // (simulates "defense is spread over border" just like attack is)
          let defenseVal = 0;
          if (neighborOwner >= 0) {
            const defBalance = balanceRef.current.get(neighborOwner) ?? 0;
            const defBorder = borderTilesRef.current.get(neighborOwner)?.size ?? 1;
            defenseVal = (defBalance / Math.max(1, defBorder)) * DEFENSE_MULT;
          }

          // Building defense bonuses
          const hasFort    = blds.some(b => b.gridIdx === ni && b.type === "fort");
          const hasDefPost = blds.some(b => b.gridIdx === ni && b.type === "defense_post");
          if (hasFort)    defenseVal *= FORT_DEFENSE_BONUS;
          if (hasDefPost) defenseVal *= DEFPOST_BONUS;

          if (pressurePerTile > defenseVal) {
            // WIN — flip the tile
            const excess = pressurePerTile - defenseVal;
            claims.push(flipTile(ni, idx));
            spawnParticles(ni, idx, neighborOwner >= 0 ? 3 : 1);

            // Cost: attacker loses the defense value from their balance
            totalBalanceLost += Math.max(1, defenseVal * 0.5);

            // Defender loses some balance too
            if (neighborOwner >= 0) {
              const defBal = balanceRef.current.get(neighborOwner) ?? 0;
              balanceRef.current.set(neighborOwner, Math.max(0, defBal - excess * 0.3));
            }

            // Update building ownership
            blds.forEach(b => { if (b.gridIdx === ni) b.ownerIdx = idx; });

            checkElimination(neighborOwner, idx);
            break; // one flip per border tile per tick (territorial.io style)
          }
        }
      }

      // Deduct attack cost from attacker
      balanceRef.current.set(idx, Math.max(0, balance - totalBalanceLost));
    });

    // Broadcast flips
    if (claims.length > 0) {
      for (let ci = 0; ci < claims.length; ci += 80) {
        channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims.slice(ci, ci+80) });
      }
    }
  }

  // ── Realtime setup ────────────────────────────────────────────────────────
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
      const cols: [number,number,number][] = [];
      data.forEach((p, i) => {
        idx.set(p.player_id, i);
        cols.push(hexRgb(p.color));
        balanceRef.current.set(i, p.units || 100);
        pixelCountRef.current.set(i, 0);
        borderTilesRef.current.set(i, new Set());
      });
      playerIndexRef.current = idx;
      colorsRef.current = cols;
    }
    load();

    const ch = supabase
      .channel(`game-${lobby.id}`, { config: { broadcast: { self: false } } })
      .on("postgres_changes", { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobby.id}` }, payload => {
        if (payload.eventType === "DELETE") return;
        const p = payload.new as LobbyPlayer;
        playersRef.current.set(p.player_id, p);
        setPlayers(prev => { const i = prev.findIndex(x => x.player_id === p.player_id); if (i === -1) return [...prev, p]; const n = [...prev]; n[i] = p; return n; });
      })
      .on("broadcast", { event: "claim" }, ({ payload }) => {
        const claimsIn = payload as { i: number; o: number }[];
        const grid = ownerGridRef.current;
        for (const c of claimsIn) {
          const old = grid[c.i];
          grid[c.i] = c.o;
          if (old >= 0) pixelCountRef.current.set(old, Math.max(0, (pixelCountRef.current.get(old)??0)-1));
          if (c.o >= 0) pixelCountRef.current.set(c.o, (pixelCountRef.current.get(c.o)??0)+1);
          updateBorderOnFlip(c.i, old, c.o);
        }
      })
      .on("broadcast", { event: "building" }, ({ payload }) => {
        const b = payload as Building;
        if (!buildingsRef.current.some(x => x.gridIdx === b.gridIdx)) {
          buildingsRef.current = [...buildingsRef.current, b];
          setBuildings(prev => [...prev, b]);
        }
      })
      .on("broadcast", { event: "bot_target" }, ({ payload }) => {
        const { ownerIdx, targetIdx } = payload as { ownerIdx: number; targetIdx: number };
        botTargetsRef.current.set(ownerIdx, targetIdx);
      })
      .on("broadcast", { event: "balance" }, ({ payload }) => {
        const { idx: oi, balance } = payload as { idx: number; balance: number };
        balanceRef.current.set(oi, balance);
      })
      .on("broadcast", { event: "rad_zone" }, ({ payload }) => {
        radZonesRef.current = [...radZonesRef.current, ...(payload as RadZone[])];
      })
      .on("broadcast", { event: "ship" }, ({ payload }) => {
        const s = payload as Ship;
        if (!shipsRef.current.find(x => x.id === s.id)) shipsRef.current = [...shipsRef.current, s];
      })
      .subscribe();
    channelRef.current = ch;
    return () => { active = false; supabase.removeChannel(ch); channelRef.current = null; };
  }, [lobby.id]);

  useEffect(() => {
    loadLandMask().then(m => { landMaskRef.current = m; coastMaskRef.current = buildCoastMask(m); });
  }, []);

  // ─── Render + main loop ───────────────────────────────────────────────────
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
      const ratio = 1920/960, cr = w/h;
      let mw, mh, mx, my: number;
      if (cr > ratio) { mh=h; mw=h*ratio; mx=(w-mw)/2; my=0; }
      else { mw=w; mh=w/ratio; mx=0; my=(h-mh)/2; }
      return { x:mx, y:my, w:mw, h:mh };
    }
    function resize() {
      const r = container!.getBoundingClientRect();
      canvas!.width = r.width * devicePixelRatio; canvas!.height = r.height * devicePixelRatio;
      canvas!.style.width = `${r.width}px`; canvas!.style.height = `${r.height}px`;
      mapRectRef.current = computeMapRect();
    }
    resize();
    const ro = new ResizeObserver(resize); ro.observe(container);

    // ── DB sync ───────────────────────────────────────────────────────────
    async function syncStats() {
      if (lobby.host_id !== playerId) return;
      const updates: Promise<unknown>[] = [];
      playersRef.current.forEach((p, pid) => {
        const idx = playerIndexRef.current.get(pid); if (idx === undefined) return;
        if (!p.alive) return;
        const px = pixelCountRef.current.get(idx) ?? 0;
        const bal = Math.floor(balanceRef.current.get(idx) ?? 0);
        const alive = px > 0 || bal > 0;
        p.units = bal; p.pixels = px;
        updates.push(supabase.from("lobby_players").update({ pixels: px, units: bal, alive }).eq("lobby_id", lobby.id).eq("player_id", pid));
      });
      await Promise.all(updates);
    }

    // ── Draw building icon ────────────────────────────────────────────────
    function drawBldIcon(px: number, py: number, type: BuildingType, color: string, zoom: number) {
      ctx.save();
      const r = Math.max(3, Math.min(9, 6 * zoom));
      ctx.fillStyle = color; ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.lineWidth = 1;
      switch (type) {
        case "city":
          ctx.fillRect(px-r,py-r*0.6,r*2,r*1.4); ctx.strokeRect(px-r,py-r*0.6,r*2,r*1.4);
          ctx.fillRect(px-r,py-r*1.5,r*0.7,r*0.9); ctx.strokeRect(px-r,py-r*1.5,r*0.7,r*0.9);
          ctx.fillRect(px+r*0.3,py-r*1.8,r*0.7,r*1.2); ctx.strokeRect(px+r*0.3,py-r*1.8,r*0.7,r*1.2); break;
        case "defense_post":
          ctx.beginPath(); ctx.moveTo(px,py-r*1.4); ctx.lineTo(px+r,py-r*0.4); ctx.lineTo(px+r,py+r*0.6);
          ctx.lineTo(px,py+r*1.4); ctx.lineTo(px-r,py+r*0.6); ctx.lineTo(px-r,py-r*0.4);
          ctx.closePath(); ctx.fill(); ctx.stroke(); break;
        case "port":
          ctx.beginPath(); ctx.arc(px,py-r*0.6,r*0.55,0,Math.PI*2); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(px,py-r*0.6); ctx.lineTo(px,py+r);
          ctx.moveTo(px-r*0.8,py+r*0.6); ctx.lineTo(px+r*0.8,py+r*0.6); ctx.stroke(); break;
        case "fort":
          ctx.beginPath();
          for (let a=0;a<6;a++) { const ang=(a/6)*Math.PI*2-Math.PI/6; a===0?ctx.moveTo(px+Math.cos(ang)*r,py+Math.sin(ang)*r):ctx.lineTo(px+Math.cos(ang)*r,py+Math.sin(ang)*r); }
          ctx.closePath(); ctx.fill(); ctx.stroke(); break;
        case "factory":
          ctx.fillRect(px-r,py-r*0.6,r*2,r*1.4); ctx.strokeRect(px-r,py-r*0.6,r*2,r*1.4);
          ctx.fillRect(px-r*0.5,py-r*1.5,r*0.55,r); ctx.strokeRect(px-r*0.5,py-r*1.5,r*0.55,r); break;
        case "missile_silo":
          ctx.beginPath(); ctx.moveTo(px,py-r*1.5); ctx.lineTo(px+r*0.75,py+r); ctx.lineTo(px-r*0.75,py+r); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.fillStyle="#f97316"; ctx.beginPath(); ctx.moveTo(px-r*0.4,py+r); ctx.lineTo(px,py+r*1.9); ctx.lineTo(px+r*0.4,py+r); ctx.closePath(); ctx.fill(); break;
        case "sam_launcher":
          ctx.beginPath(); ctx.arc(px,py,r,Math.PI,Math.PI*2); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(px,py+r); ctx.stroke(); break;
        case "naval_base":
          ctx.beginPath(); ctx.moveTo(px-r,py+r*0.3); ctx.lineTo(px+r,py+r*0.3); ctx.lineTo(px+r*0.7,py-r*0.3); ctx.lineTo(px-r*0.7,py-r*0.3); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.fillRect(px-r*0.15,py-r,r*0.3,r*0.7); break;
      }
      ctx.restore();
    }

    // ── Render ────────────────────────────────────────────────────────────
    function render() {
      const w = canvas!.width, h = canvas!.height;
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle="#0a1628"; ctx.fillRect(0,0,w,h);
      const mr = computeMapRect(); mapRectRef.current = mr;
      const { x:mx, y:my, w:mw, h:mh } = mr;
      const cellW = mw/GRID_W, cellH = mh/GRID_H;
      const cam = camRef.current;

      ctx.save();
      ctx.translate(cam.x, cam.y); ctx.scale(cam.zoom, cam.zoom);

      if (bgImg.complete) ctx.drawImage(bgImg,mx,my,mw,mh);
      else { ctx.fillStyle="#1a3050"; ctx.fillRect(mx,my,mw,mh); }

      const grid = ownerGridRef.current;
      const colors = colorsRef.current;
      const data = imgData.data;
      const radMap = new Map<number,number>();
      radZonesRef.current.forEach(rz => radMap.set(rz.gridIdx, rz.strength));

      // Build per-player balance-relative strength for rendering
      // Tiles render brighter when balance is higher relative to cap
      const strengthByOwner = new Map<number,number>();
      balanceRef.current.forEach((bal, idx) => {
        const px = pixelCountRef.current.get(idx) ?? 1;
        const softCap = Math.max(1, px * SOFT_CAP_MULT);
        strengthByOwner.set(idx, Math.min(1, bal / softCap));
      });

      for (let i = 0; i < grid.length; i++) {
        if (radMap.has(i)) {
          const s = radMap.get(i)!;
          data[i*4]=20; data[i*4+1]=220; data[i*4+2]=60; data[i*4+3]=Math.min(200,100+s*0.6); continue;
        }
        const o = grid[i];
        if (o < 0 || !colors[o]) { data[i*4+3]=0; continue; }
        const c = colors[o];
        const strength = strengthByOwner.get(o) ?? 0.5;
        // Alpha: 100 (weak) → 210 (at peak income) — gives visual feedback on balance
        data[i*4]   = c[0]; data[i*4+1] = c[1]; data[i*4+2] = c[2];
        data[i*4+3] = Math.floor(100 + strength * 110);
      }
      offCtx.putImageData(imgData,0,0);
      ctx.imageSmoothingEnabled=false; ctx.drawImage(off,mx,my,mw,mh); ctx.imageSmoothingEnabled=true;

      // Border outlines — only draw actual border tiles (from our border set)
      borderTilesRef.current.forEach((bs, ownerIdx) => {
        if (!colors[ownerIdx]) return;
        const c = colors[ownerIdx];
        ctx.strokeStyle = `rgba(${Math.min(255,c[0]+100)},${Math.min(255,c[1]+100)},${Math.min(255,c[2]+100)},0.9)`;
        ctx.lineWidth = Math.max(0.5, cellW * 0.3);
        for (const gi of bs) {
          const bx = gi % GRID_W, by = Math.floor(gi / GRID_W);
          ctx.strokeRect(mx+bx*cellW+0.5, my+by*cellH+0.5, cellW-1, cellH-1);
        }
      });

      // Attack target crosshair
      const myTarget = myAttackTargetRef.current;
      if (myTarget >= 0) {
        // Draw highlight on all tiles belonging to target
        ctx.save();
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
        ctx.strokeStyle = `rgba(255,255,80,${0.5 + pulse * 0.5})`;
        ctx.lineWidth = 1.2;
        for (let i = 0; i < grid.length; i++) {
          if (grid[i] !== myTarget) continue;
          const bx = i % GRID_W, by = Math.floor(i / GRID_W);
          // Only draw on border tiles for perf
          const borderSet = borderTilesRef.current.get(myTarget);
          if (!borderSet?.has(i)) continue;
          ctx.strokeRect(mx+bx*cellW, my+by*cellH, cellW, cellH);
        }
        ctx.restore();
      }

      // Buildings
      buildingsRef.current.forEach(b => {
        const curOwner = grid[b.gridIdx];
        const entry = [...playerIndexRef.current.entries()].find(([,v]) => v === curOwner);
        const col = entry ? playersRef.current.get(entry[0])?.color ?? "#fff" : "#fff";
        drawBldIcon(mx+(b.gridIdx%GRID_W)/GRID_W*mw+cellW/2, my+Math.floor(b.gridIdx/GRID_W)/GRID_H*mh+cellH/2, b.type, col, cam.zoom);
      });

      // Ships
      shipsRef.current.forEach(ship => {
        const sx = ship.fromX + (ship.toX - ship.fromX) * ship.progress;
        const sy = ship.fromY + (ship.toY - ship.fromY) * ship.progress;
        const entry = [...playerIndexRef.current.entries()].find(([,v]) => v === ship.ownerIdx);
        const col = entry ? playersRef.current.get(entry[0])?.color ?? "#4af" : "#4af";
        const angle = Math.atan2(ship.toY - ship.fromY, ship.toX - ship.fromX);
        ctx.save();
        ctx.translate(sx,sy); ctx.rotate(angle);
        ctx.fillStyle=col; ctx.strokeStyle="rgba(255,255,255,0.8)"; ctx.lineWidth=0.8;
        ctx.beginPath(); ctx.ellipse(0,0,7,3.5,0,0,Math.PI*2); ctx.fill(); ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.fillStyle="#fff"; ctx.font=`bold ${Math.max(7,9*cam.zoom)}px monospace`;
        ctx.textAlign="center"; ctx.textBaseline="middle";
        ctx.shadowColor="rgba(0,0,0,0.9)"; ctx.shadowBlur=3;
        ctx.fillText(`${ship.units}`,sx,sy-11); ctx.restore();
      });

      // Nameplates — show player name + balance on their territory centroid
      {
        const sumX = new Float64Array(colors.length);
        const sumY = new Float64Array(colors.length);
        const cnt  = new Int32Array(colors.length);
        // Sample: iterate grid for centroid (still needed for label placement, but only for render)
        for (let i = 0; i < grid.length; i++) {
          const o = grid[i]; if (o < 0 || o >= colors.length) continue;
          sumX[o] += i % GRID_W; sumY[o] += Math.floor(i/GRID_W); cnt[o]++;
        }
        ctx.save(); ctx.textAlign="center"; ctx.textBaseline="middle";
        const bf = Math.max(6, Math.min(16, 11/cam.zoom));
        playerIndexRef.current.forEach((idx, pid) => {
          if (cnt[idx] < 5) return;
          const p = playersRef.current.get(pid); if (!p || !p.alive) return;
          const sx2 = mx + (sumX[idx]/cnt[idx]/GRID_W)*mw;
          const sy2 = my + (sumY[idx]/cnt[idx]/GRID_H)*mh;
          const bal = balanceRef.current.get(idx) ?? 0;
          const px2 = pixelCountRef.current.get(idx) ?? 0;
          const atCap = bal >= px2 * SOFT_CAP_MULT * 0.9;
          ctx.font=`bold ${bf}px sans-serif`; ctx.shadowColor="rgba(0,0,0,0.95)"; ctx.shadowBlur=4;
          ctx.fillStyle="#fff"; ctx.fillText(p.name, sx2, sy2-bf*0.65);
          ctx.font=`${bf*0.85}px monospace`;
          ctx.fillStyle = atCap ? "#ff4444" : "rgba(255,255,200,0.9)"; // red = at cap, need to attack!
          ctx.fillText(fmt(bal), sx2, sy2+bf*0.65);
          ctx.shadowBlur=0;
        });
        ctx.restore();
      }

      ctx.restore(); // end camera transform

      // Particles
      for (const p of particlesRef.current) {
        ctx.globalAlpha = p.life * 0.75; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x,p.y,1+p.life*2,0,Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (placeModeRef.current || bombModeRef.current) {
        ctx.save(); ctx.font=`${14*devicePixelRatio}px sans-serif`;
        ctx.fillStyle="rgba(255,255,100,0.9)"; ctx.textAlign="center";
        ctx.fillText(
          placeModeRef.current
            ? `Click to place ${BUILDING_LABELS[placeModeRef.current.type]}  ·  Right-click to cancel`
            : `Click to drop ${bombModeRef.current} bomb  ·  Right-click to cancel`,
          canvas!.width/2, 28*devicePixelRatio
        );
        ctx.restore();
      }
    }

    // ── Main loop ─────────────────────────────────────────────────────────
    function loop(now: number) {
      const dt = Math.min(now - lastFrame, 100); lastFrame = now;

      // Keyboard camera pan
      const cam = camRef.current; const ks = keysRef.current;
      if (ks.has("w")||ks.has("arrowup"))    cam.y += 5;
      if (ks.has("s")||ks.has("arrowdown"))  cam.y -= 5;
      if (ks.has("a")||ks.has("arrowleft"))  cam.x += 5;
      if (ks.has("d")||ks.has("arrowright")) cam.x -= 5;

      // Game tick — fires every TICK_MS (560ms), not every frame
      if (now - lastTickRef.current >= TICK_MS) {
        lastTickRef.current = now;
        tickGame();
      }

      // Ships
      const navalBoost = new Set(buildingsRef.current.filter(b=>b.type==="naval_base").map(b=>b.ownerIdx));
      shipsRef.current = shipsRef.current.filter(ship => {
        const spd = SHIP_TILES_PER_MS / Math.max(1, ship.distanceTiles) * (navalBoost.has(ship.ownerIdx) ? 1.7 : 1);
        ship.progress = Math.min(1, ship.progress + spd * dt);
        if (ship.progress >= 1) {
          const mask2 = landMaskRef.current; if (!mask2) return false;
          const gr = ownerGridRef.current;
          const ltx = ship.targetGridIdx % GRID_W, lty = Math.floor(ship.targetGridIdx / GRID_W);
          for (let dy=-4; dy<=4; dy++) for (let dx=-4; dx<=4; dx++) {
            if (Math.abs(dx)+Math.abs(dy)>4) continue;
            const nx=ltx+dx, ny=lty+dy;
            if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
            const ni = ny*GRID_W+nx;
            if (!mask2[ni] || gr[ni] === ship.ownerIdx) continue;
            flipTile(ni, ship.ownerIdx);
          }
          return false;
        }
        return true;
      });

      // Radiation decay
      radZonesRef.current = radZonesRef.current.filter(rz => { rz.strength = Math.max(0, rz.strength - rz.decay * dt * 0.01); return rz.strength > 0; });

      // Particles
      particlesRef.current = particlesRef.current.filter(p => { p.x+=p.vx; p.y+=p.vy; p.life-=0.025; return p.life>0; });
      if (particlesRef.current.length > 1200) particlesRef.current = particlesRef.current.slice(-600);

      render();

      // DB sync
      if (now - lastSyncRef.current > 1500) { lastSyncRef.current = now; syncStats(); }

      // Bot AI (only host runs bots)
      if (lobby.host_id === playerId && now - lastBotRef.current > 2500) {
        lastBotRef.current = now;
        const mask2 = landMaskRef.current; if (mask2) {
          const gr = ownerGridRef.current;
          playersRef.current.forEach(bot => {
            if (!bot.is_bot || !bot.alive) return;
            const idx = playerIndexRef.current.get(bot.player_id);
            if (idx === undefined || eliminatedRef.current.has(idx)) return;

            const pixels = pixelCountRef.current.get(idx) ?? 0;
            if (pixels === 0) {
              // Bot needs to spawn
              const cands: number[] = [];
              for (let i = 0; i < mask2.length; i++) if (mask2[i] && gr[i]===-1) cands.push(i);
              if (cands.length === 0) return;
              plantStarter(cands[Math.floor(Math.random()*cands.length)], idx); return;
            }

            // Bot building
            const bal = balanceRef.current.get(idx) ?? 0;
            if (bal > 80 && buildingsRef.current.filter(b=>b.ownerIdx===idx).length < 5) {
              const owned: number[] = [];
              for (let i=0;i<gr.length;i++) if (gr[i]===idx) owned.push(i);
              const free = owned.filter(k=>!buildingsRef.current.some(b=>b.gridIdx===k));
              if (free.length > 0) {
                const pick = free[Math.floor(Math.random()*free.length)];
                const btype: BuildingType = bal>200 ? "factory" : bal>120 ? "defense_post" : "city";
                const [cc] = BUILD_COST[btype];
                if (bal >= cc) {
                  const bld: Building = { type:btype, ownerIdx:idx, gridIdx:pick };
                  buildingsRef.current=[...buildingsRef.current,bld]; setBuildings(prev=>[...prev,bld]);
                  channelRef.current?.send({ type:"broadcast", event:"building", payload:bld });
                  balanceRef.current.set(idx, bal-cc);
                }
              }
            }

            // Bot picks attack target: prefer neutral, then weakest enemy
            const borderSet = borderTilesRef.current.get(idx);
            if (!borderSet || borderSet.size === 0) return;
            let targetOwner = -1; // -1 = neutral
            const neighborOwners = new Map<number, number>(); // owner → tile count
            for (const bi of borderSet) {
              for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
                const nx=(bi%GRID_W)+dx, ny=Math.floor(bi/GRID_W)+dy;
                if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
                const ni=ny*GRID_W+nx;
                if (!mask2[ni]) continue;
                const no=gr[ni]; if (no===idx) continue;
                neighborOwners.set(no, (neighborOwners.get(no)??0)+1);
              }
            }
            if (neighborOwners.size > 0) {
              // Prefer neutral first
              if (neighborOwners.has(-1)) { targetOwner = -1; }
              else {
                // Pick weakest enemy by balance
                let weakest = Infinity, weakestOwner = -1;
                neighborOwners.forEach((_, no) => {
                  if (no < 0) return;
                  const b = balanceRef.current.get(no) ?? 0;
                  if (b < weakest) { weakest = b; weakestOwner = no; }
                });
                targetOwner = weakestOwner;
              }
            }
            botTargetsRef.current.set(idx, targetOwner);
            channelRef.current?.send({ type:"broadcast", event:"bot_target", payload:{ ownerIdx:idx, targetIdx:targetOwner } });
          });
        }
      }

      setTick(t => (t+1) % 1_000_000);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    // ── Input ─────────────────────────────────────────────────────────────
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const r = canvas!.getBoundingClientRect();
      const mx2=(e.clientX-r.left)*devicePixelRatio, my2=(e.clientY-r.top)*devicePixelRatio;
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const c = camRef.current, newZoom = Math.min(12, Math.max(0.25, c.zoom * factor));
      c.x = mx2-(mx2-c.x)*(newZoom/c.zoom); c.y = my2-(my2-c.y)*(newZoom/c.zoom); c.zoom = newZoom;
    }
    function onMouseDown(e: MouseEvent) {
      if (e.button === 1 || e.button === 2) {
        e.preventDefault(); dragMovedRef.current = false;
        dragRef.current = { active:true, startX:e.clientX, startY:e.clientY, camX:camRef.current.x, camY:camRef.current.y };
      }
    }
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current.active) return;
      const dx=(e.clientX-dragRef.current.startX)*devicePixelRatio;
      const dy=(e.clientY-dragRef.current.startY)*devicePixelRatio;
      if (Math.abs(dx)>3||Math.abs(dy)>3) dragMovedRef.current=true;
      camRef.current.x=dragRef.current.camX+dx; camRef.current.y=dragRef.current.camY+dy;
    }
    function onMouseUp() { dragRef.current.active=false; }
    function onKeyDown(e: KeyboardEvent) {
      keysRef.current.add(e.key.toLowerCase());
      if (e.key==="c"||e.key==="C") centerCamera();
      if (e.key==="Escape") {
        setPlaceMode(null); placeModeRef.current=null;
        setBombMode(null); bombModeRef.current=null;
        myAttackTargetRef.current=-1; setAttackingPlayer(null);
      }
      const num = parseInt(e.key);
      if (num>=1&&num<=8) {
        const btype = TOOLBAR[num-1];
        if (btype) {
          if (placeModeRef.current?.type===btype) { setPlaceMode(null); placeModeRef.current=null; }
          else { setPlaceMode({type:btype}); placeModeRef.current={type:btype}; setBombMode(null); bombModeRef.current=null; }
        }
      }
    }
    function onKeyUp(e: KeyboardEvent) { keysRef.current.delete(e.key.toLowerCase()); }

    canvas.addEventListener("wheel", onWheel, { passive:false });
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

  // ── Plant starter territory ───────────────────────────────────────────────
  function plantStarter(centerIdx: number, ownerIdx: number) {
    const mask = landMaskRef.current; if (!mask) return;
    const claims: { i: number; o: number }[] = [];
    const cx = centerIdx % GRID_W, cy = Math.floor(centerIdx / GRID_W);
    for (let dy=-STARTER_RADIUS; dy<=STARTER_RADIUS; dy++) {
      for (let dx=-STARTER_RADIUS; dx<=STARTER_RADIUS; dx++) {
        const x=cx+dx, y=cy+dy;
        if (x<0||y<0||x>=GRID_W||y>=GRID_H) continue;
        const i = y*GRID_W+x;
        if (mask[i] && ownerGridRef.current[i]===-1) {
          claims.push(flipTile(i, ownerIdx));
        }
      }
    }
    balanceRef.current.set(ownerIdx, 200); // starting balance
    if (claims.length > 0) channelRef.current?.send({ type:"broadcast", event:"claim", payload:claims });
  }

  // ── Center camera on own territory ───────────────────────────────────────
  function centerCamera() {
    const myIdx = playerIndexRef.current.get(playerId); if (myIdx === undefined) return;
    const grid = ownerGridRef.current;
    let sx=0, sy=0, cnt=0;
    for (let i=0;i<grid.length;i++) if (grid[i]===myIdx) { sx+=i%GRID_W; sy+=Math.floor(i/GRID_W); cnt++; }
    if (cnt===0) return;
    const mr = mapRectRef.current; const cv = canvasRef.current;
    const wx = mr.x+(sx/cnt/GRID_W)*mr.w, wy = mr.y+(sy/cnt/GRID_H)*mr.h;
    camRef.current.x = (cv?.width??0)/2 - wx*camRef.current.zoom;
    camRef.current.y = (cv?.height??0)/2 - wy*camRef.current.zoom;
  }

  // ── Naval attack ──────────────────────────────────────────────────────────
  function launchShip(targetIdx: number, ownerIdx: number, pid: string) {
    const coast = coastMaskRef.current, mask = landMaskRef.current;
    if (!coast || !mask || !mask[targetIdx]) { notify("Ships can only attack land tiles", "error"); return; }
    const grid = ownerGridRef.current;
    let bestFrom=-1, bestDist=Infinity;
    for (let i=0; i<grid.length; i++) {
      if (grid[i]!==ownerIdx || !coast[i]) continue;
      const d = Math.abs(i%GRID_W-targetIdx%GRID_W)+Math.abs(Math.floor(i/GRID_W)-Math.floor(targetIdx/GRID_W));
      if (d < bestDist) { bestDist=d; bestFrom=i; }
    }
    if (bestFrom===-1) { notify("Need a coastal tile to launch ships", "error"); return; }
    const mr=mapRectRef.current, cW=mr.w/GRID_W, cH=mr.h/GRID_H;
    const bal = balanceRef.current.get(ownerIdx) ?? 0;
    const sendBal = Math.floor(bal * attackPctRef.current / 100);
    const dist = Math.abs(bestFrom%GRID_W-targetIdx%GRID_W)+Math.abs(Math.floor(bestFrom/GRID_W)-Math.floor(targetIdx/GRID_W));
    const ship: Ship = {
      id: crypto.randomUUID(), ownerIdx,
      fromX: mr.x+(bestFrom%GRID_W+0.5)*cW, fromY: mr.y+(Math.floor(bestFrom/GRID_W)+0.5)*cH,
      toX: mr.x+(targetIdx%GRID_W+0.5)*cW,   toY: mr.y+(Math.floor(targetIdx/GRID_W)+0.5)*cH,
      units: sendBal, targetGridIdx: targetIdx, progress: 0, distanceTiles: Math.max(1, dist),
    };
    shipsRef.current=[...shipsRef.current, ship];
    channelRef.current?.send({ type:"broadcast", event:"ship", payload:ship });
    balanceRef.current.set(ownerIdx, Math.max(0, bal - sendBal));
    const etaSec = Math.round(dist/(SHIP_TILES_PER_MS*1000));
    notify(`Fleet of ${fmt(sendBal)} launched — ETA ~${etaSec}s`, "success");
  }

  // ── Drop bomb ─────────────────────────────────────────────────────────────
  function dropBomb(targetIdx: number, btype: BombType, pid: string) {
    const myIdx = playerIndexRef.current.get(pid); if (myIdx === undefined) return;
    const cost = BOMB_COST[btype];
    const bal = balanceRef.current.get(myIdx) ?? 0;
    if (bal < cost) { notify(`Need ${cost} balance`, "error"); return; }
    const grid = ownerGridRef.current;
    const tx = targetIdx%GRID_W, ty = Math.floor(targetIdx/GRID_W), radius = BOMB_RADIUS[btype];
    let intercepted = false;
    buildingsRef.current.forEach(b => {
      if (b.type!=="sam_launcher") return;
      const cur=grid[b.gridIdx]; if (cur===myIdx||cur===-1) return;
      const bx=b.gridIdx%GRID_W, by2=Math.floor(b.gridIdx/GRID_W);
      if (Math.abs(bx-tx)+Math.abs(by2-ty)<radius*3 && Math.random()<0.4) intercepted=true;
    });
    if (intercepted) { notify("Intercepted by SAM!", "error"); return; }
    balanceRef.current.set(myIdx, bal - cost);
    const mask=landMaskRef.current; if (!mask) return;
    const affected: number[] = [];
    for (let dy2=-radius;dy2<=radius;dy2++) for (let dx2=-radius;dx2<=radius;dx2++) {
      if (Math.abs(dx2)+Math.abs(dy2)>radius) continue;
      const nx=tx+dx2, ny=ty+dy2;
      if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H||!mask[ny*GRID_W+nx]) continue;
      affected.push(ny*GRID_W+nx);
    }
    buildingsRef.current=buildingsRef.current.filter(b=>!affected.includes(b.gridIdx));
    setBuildings(prev=>prev.filter(b=>!affected.includes(b.gridIdx)));
    affected.forEach(i => flipTile(i, -1));
    channelRef.current?.send({ type:"broadcast", event:"claim", payload:affected.map(i=>({i,o:-1})) });
    const radStr=BOMB_RAD[btype];
    const newZones: RadZone[] = affected.map(i=>({ gridIdx:i, strength:radStr, decay:btype==="dirty"?0.05:0.3 }));
    radZonesRef.current=[...radZonesRef.current,...newZones];
    channelRef.current?.send({ type:"broadcast", event:"rad_zone", payload:newZones });
    const mr=mapRectRef.current, cam=camRef.current;
    const scx=cam.x+(mr.x+(tx+0.5)/GRID_W*mr.w)*cam.zoom;
    const scy=cam.y+(mr.y+(ty+0.5)/GRID_H*mr.h)*cam.zoom;
    const bombCol=btype==="dirty"?"#22c55e":btype==="hydrogen"?"#818cf8":"#f97316";
    for (let pi=0;pi<80;pi++) {
      const ang=Math.random()*Math.PI*2, spd=1+Math.random()*5;
      particlesRef.current.push({ x:scx, y:scy, vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd, life:1, color:bombCol });
    }
    notify(`${btype.charAt(0).toUpperCase()+btype.slice(1)} bomb detonated!`, "success");
  }

  // ── Place building ────────────────────────────────────────────────────────
  function getBuildCost(type: BuildingType, ownerIdx: number): number {
    const [bc] = BUILD_COST[type];
    const n = buildingsRef.current.filter(b=>b.ownerIdx===ownerIdx&&b.type===type).length;
    return Math.round(bc * (1 + n * 0.5));
  }

  function doPlaceBuilding(gx: number, gy: number, type: BuildingType) {
    setPlaceMode(null); placeModeRef.current=null;
    const myIdx = playerIndexRef.current.get(playerId); if (myIdx === undefined) return;
    const gridIdx = gy*GRID_W+gx;
    if (ownerGridRef.current[gridIdx] !== myIdx) { notify("Build on your own territory", "error"); return; }
    if (buildingsRef.current.some(b=>b.gridIdx===gridIdx)) { notify("Already a building here", "error"); return; }
    if (type==="port"||type==="naval_base") {
      if (!coastMaskRef.current?.[gridIdx]) { notify("Ports need a coastal tile", "error"); return; }
    }
    const cost = getBuildCost(type, myIdx);
    const bal = balanceRef.current.get(myIdx) ?? 0;
    if (bal < cost) { notify(`Need ${cost} balance`, "error"); return; }
    const building: Building = { type, ownerIdx:myIdx, gridIdx };
    setBuildings(prev=>[...prev,building]); buildingsRef.current=[...buildingsRef.current,building];
    channelRef.current?.send({ type:"broadcast", event:"building", payload:building });
    balanceRef.current.set(myIdx, bal - cost);
    notify(`${BUILDING_LABELS[type]} built!`, "success");
  }

  // ── Click handler ─────────────────────────────────────────────────────────
  function handleClick(e: React.MouseEvent) {
    if (dragMovedRef.current) { dragMovedRef.current=false; return; }
    const coords = screenToGrid(e.clientX, e.clientY); if (!coords) return;
    const { gx, gy } = coords;
    const myIdx = playerIndexRef.current.get(playerId); if (myIdx === undefined) return;
    const i = gy*GRID_W+gx;
    const mask = landMaskRef.current; if (!mask) return;

    if (bombModeRef.current) {
      dropBomb(i, bombModeRef.current, playerId);
      setBombMode(null); bombModeRef.current=null; return;
    }
    if (placeModeRef.current) {
      if (!mask[i]) { notify("Click on land", "error"); return; }
      doPlaceBuilding(gx, gy, placeModeRef.current.type); return;
    }

    const grid = ownerGridRef.current;
    const pixels = pixelCountRef.current.get(myIdx) ?? 0;

    // First click = spawn
    if (pixels === 0 && !hasSpawned) {
      if (!mask[i]) { notify("Click on land to start", "error"); return; }
      if (grid[i] !== -1) { notify("Pick an unclaimed tile", "error"); return; }
      plantStarter(i, myIdx); setHasSpawned(true);
      notify("Empire founded! Click enemy territory to attack.", "success"); return;
    }

    // Click own territory = cancel attack
    if (grid[i] === myIdx) {
      myAttackTargetRef.current = -1;
      setAttackingPlayer(null);
      notify("Attack cancelled — troops defending all borders", "info"); return;
    }

    if (!mask[i]) { notify("Click on land", "error"); return; }

    const clickedOwner = grid[i];

    // Check land reachability via BFS from border
    let reachable = false;
    {
      const reach = new Uint8Array(grid.length);
      const q: number[] = [];
      for (let k=0;k<grid.length;k++) {
        if (grid[k]!==myIdx) continue;
        const x2=k%GRID_W, y2=Math.floor(k/GRID_W);
        for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
          const nx=x2+dx, ny=y2+dy;
          if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
          const ni=ny*GRID_W+nx;
          if (!reach[ni]&&mask[ni]&&grid[ni]!==myIdx) { reach[ni]=1; q.push(ni); }
        }
      }
      let h=0;
      while (h<q.length) {
        const cur=q[h++]; if (cur===i) { reachable=true; break; }
        const x2=cur%GRID_W, y2=Math.floor(cur/GRID_W);
        for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
          const nx=x2+dx, ny=y2+dy;
          if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
          const ni=ny*GRID_W+nx;
          if (!reach[ni]&&mask[ni]) { reach[ni]=1; q.push(ni); }
        }
      }
    }

    if (reachable) {
      // Set attack target — the whole border will now push toward this owner
      myAttackTargetRef.current = clickedOwner; // -1 for neutral
      if (clickedOwner >= 0) {
        const entry = [...playerIndexRef.current.entries()].find(([,v])=>v===clickedOwner);
        const name = entry ? playersRef.current.get(entry[0])?.name : undefined;
        setAttackingPlayer(name ?? null);
        notify(`Attacking ${name ?? "player"}! Your whole border pushes toward them.`, "info");
      } else {
        setAttackingPlayer(null);
        notify("Expanding into neutral territory", "info");
      }
    } else {
      const hasPort = buildingsRef.current.some(b=>b.ownerIdx===myIdx&&b.type==="port");
      if (hasPort) launchShip(i, myIdx, playerId);
      else notify("No land path — build a Port for naval attacks", "error");
    }
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if (placeModeRef.current || bombModeRef.current) {
      setPlaceMode(null); setBombMode(null);
      placeModeRef.current=null; bombModeRef.current=null; return;
    }
    myAttackTargetRef.current=-1; setAttackingPlayer(null);
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const sortedPlayers = [...players].sort((a,b)=>b.pixels-a.pixels);
  const myIdx = playerIndexRef.current.get(playerId);
  const myBal = Math.floor(balanceRef.current.get(myIdx ?? -1) ?? 0);
  const myPixels = pixelCountRef.current.get(myIdx ?? -1) ?? 0;
  const me = playersRef.current.get(playerId);
  const hasSilo = myIdx !== undefined && buildingsRef.current.some(b=>b.ownerIdx===myIdx&&b.type==="missile_silo");
  const atSoftCap = myPixels > 0 && myBal >= myPixels * SOFT_CAP_MULT * 0.85;

  if (isDead && !isSpectating) {
    return (
      <div className="relative h-screen w-screen overflow-hidden bg-[#0a1628] flex items-center justify-center">
        <div className="flex flex-col items-center gap-6 rounded-2xl border border-red-500/40 bg-card/95 px-10 py-8 shadow-2xl backdrop-blur-md text-center max-w-sm">
          <div className="text-6xl">💀</div>
          <div>
            <div className="text-2xl font-bold text-red-400 mb-1">Eliminated</div>
            <div className="text-sm text-muted-foreground">Your empire has fallen.</div>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setIsSpectating(true)} className="gap-2">👁 Spectate</Button>
            <Button variant="destructive" onClick={onLeave} className="gap-2"><LogOut className="h-4 w-4" />Leave</Button>
          </div>
          <div className="w-full mt-2 border-t border-border/40 pt-3">
            <div className="text-xs font-semibold text-muted-foreground mb-2">Still alive</div>
            {sortedPlayers.filter(p=>p.alive).map(p=>(
              <div key={p.id} className="flex items-center gap-2 text-xs py-0.5">
                <span className="h-2 w-2 rounded-sm flex-shrink-0" style={{ backgroundColor:p.color }} />
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
    <div ref={containerRef} className="relative h-screen w-screen overflow-hidden bg-[#0a1628]">
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: placeMode || bombMode ? "crosshair" : "default" }}
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
          <div className="text-sm text-muted-foreground">Click any unclaimed land to found your empire</div>
        </div>
      )}

      {/* Attack indicator */}
      {attackingPlayer !== null && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-lg border border-yellow-500/60 bg-card/90 px-3 py-1.5 text-xs font-bold text-yellow-300 backdrop-blur-md shadow">
          ⚔️ Attacking {attackingPlayer} — Right-click to cancel
        </div>
      )}
      {attackingPlayer === null && myAttackTargetRef.current === -1 && hasSpawned && !isDead && !isSpectating && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-lg border border-border/40 bg-card/70 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-md shadow">
          Click enemy or neutral territory to attack
        </div>
      )}

      {/* Balance at cap warning */}
      {atSoftCap && !isDead && !isSpectating && (
        <div className="absolute top-24 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-lg border border-red-500/60 bg-red-950/80 px-3 py-1.5 text-xs font-bold text-red-300 backdrop-blur-md shadow animate-pulse">
          ⚠ Balance near cap — attack to keep growing!
        </div>
      )}

      {/* Leaderboard */}
      <div className="absolute left-3 top-3 w-56 rounded-xl border border-border/60 bg-card/85 p-2 shadow-lg backdrop-blur-md z-10">
        <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Leaderboard</div>
        {sortedPlayers.slice(0,10).map((p,i)=>(
          <div key={p.id} className={`flex items-center gap-2 rounded px-2 py-0.5 text-xs ${p.player_id===playerId?"bg-primary/15":""} ${!p.alive?"opacity-40 line-through":""}`}>
            <span className="w-4 text-right font-mono text-muted-foreground">{i+1}</span>
            <span className="h-2 w-2 rounded-sm flex-shrink-0" style={{ backgroundColor:p.color }} />
            <span className="flex-1 truncate font-medium">{p.name}</span>
            <span className="font-mono text-muted-foreground text-[10px]">{p.alive?`${p.pixels}t`:"☠"}</span>
          </div>
        ))}
      </div>

      {!isSpectating && (
        <Button onClick={onLeave} variant="secondary" size="sm" className="absolute right-3 top-3 gap-1.5 bg-card/85 backdrop-blur-md z-10">
          <LogOut className="h-3.5 w-3.5" />Leave
        </Button>
      )}

      {/* Bottom HUD */}
      {!isSpectating && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-10">
          {/* Building toolbar */}
          <div className="flex gap-1 rounded-lg border border-border/60 bg-card/90 px-2 py-1.5 backdrop-blur-md shadow-lg">
            {TOOLBAR.map((btype, idx2) => {
              const cost = myIdx !== undefined ? getBuildCost(btype, myIdx) : BUILD_COST[btype][0];
              const count = myIdx !== undefined ? buildingsRef.current.filter(b=>b.ownerIdx===myIdx&&b.type===btype).length : 0;
              const canAfford = myBal >= cost;
              const isActive = placeMode?.type === btype;
              return (
                <button key={btype} title={`[${idx2+1}] ${BUILDING_LABELS[btype]} — ${cost} balance`}
                  disabled={!canAfford}
                  onClick={() => {
                    if (isActive) { setPlaceMode(null); placeModeRef.current=null; return; }
                    setPlaceMode({type:btype}); placeModeRef.current={type:btype};
                    setBombMode(null); bombModeRef.current=null;
                  }}
                  className={`flex flex-col items-center justify-center w-14 h-14 rounded border transition-all relative ${isActive?"border-yellow-400 bg-yellow-400/20":"border-border/60 bg-background/60 hover:bg-secondary/80"} disabled:opacity-35 disabled:cursor-not-allowed`}>
                  <span className="absolute top-0.5 left-1 text-[9px] text-muted-foreground font-mono">{idx2+1}</span>
                  <span className="text-lg">{BUILDING_ICONS[btype]}</span>
                  <span className="text-[9px] font-mono text-muted-foreground">{count>0?`${count}x · `:""}{cost}</span>
                </button>
              );
            })}
            {hasSilo && (["atom","hydrogen","dirty"] as BombType[]).map(bt => {
              const cost=BOMB_COST[bt]; const isActive=bombMode===bt;
              const icons: Record<BombType,string> = { atom:"☢", hydrogen:"💥", dirty:"☣" };
              return (
                <button key={bt} title={`${bt} bomb — ${cost} balance`} disabled={myBal < cost}
                  onClick={() => {
                    if (isActive) { setBombMode(null); bombModeRef.current=null; return; }
                    setBombMode(bt); bombModeRef.current=bt;
                    setPlaceMode(null); placeModeRef.current=null;
                  }}
                  className={`flex flex-col items-center justify-center w-14 h-14 rounded border transition-all ${isActive?"border-red-400 bg-red-400/20":"border-red-800/60 bg-background/60 hover:bg-red-900/30"} disabled:opacity-35 disabled:cursor-not-allowed`}>
                  <span className="text-lg">{icons[bt]}</span>
                  <span className="text-[9px] font-mono text-red-400">{cost}</span>
                </button>
              );
            })}
          </div>

          {/* Control bar */}
          <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/90 px-4 py-2 backdrop-blur-md shadow-lg">
            {me && (
              <div className="flex items-center gap-2 text-xs">
                <span className="h-3 w-3 rounded-sm flex-shrink-0" style={{ backgroundColor:me.color }} />
                <div className="flex flex-col">
                  <span className="font-bold leading-none">{me.name}</span>
                  <span className={`font-mono text-[10px] ${atSoftCap?"text-red-400":"text-muted-foreground"}`}>
                    {fmt(myBal)} balance · {myPixels}t
                  </span>
                </div>
              </div>
            )}
            <div className="h-8 w-px bg-border" />

            {/* THE slider — attack % (like territorial.io) */}
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Attack <span className="text-primary">{attackPct}%</span>
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-muted-foreground">safe</span>
                <input type="range" min={5} max={100} step={5} value={attackPct}
                  onChange={e => { setAttackPct(+e.target.value); attackPctRef.current=+e.target.value; }}
                  className="w-28 accent-primary" />
                <span className="text-[9px] text-muted-foreground">all-in</span>
              </div>
              <span className="text-[9px] text-muted-foreground/60">
                {fmt(myBal * attackPct / 100)} on border · {fmt(myBal * (1-attackPct/100))} held
              </span>
            </div>
            <div className="h-8 w-px bg-border" />

            {/* Camera */}
            <div className="flex gap-1">
              {[
                { label:"+", title:"Zoom in",   fn:()=>{ const c=camRef.current; c.zoom=Math.min(12,c.zoom*1.25); } },
                { label:"−", title:"Zoom out",  fn:()=>{ const c=camRef.current; c.zoom=Math.max(0.25,c.zoom*0.8); } },
                { label:"⌂", title:"Reset view",fn:()=>{ camRef.current={x:0,y:0,zoom:1}; } },
                { label:"C", title:"Center [C]", fn:centerCamera },
              ].map(b=>(
                <button key={b.label} title={b.title} onClick={b.fn}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-sm hover:bg-secondary">
                  {b.label}
                </button>
              ))}
            </div>
            <div className="h-8 w-px bg-border" />
            <div className="text-[9px] text-muted-foreground leading-tight">
              <div>WASD: pan · scroll: zoom</div>
              <div>Click territory to attack</div>
              <div>Right-click / Esc: cancel</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
