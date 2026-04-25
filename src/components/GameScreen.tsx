import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { GRID_W, GRID_H } from "@/game/constants";
import { loadLandMask } from "@/game/landMask";
import worldMap from "@/assets/map-world.jpg";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
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

// Buildings — fort = passive defense on owned tiles, defense_post = border fortification
type BuildingType =
  | "city"          // +500 pop cap, +2 coins/tick
  | "defense_post"  // border checkerboard, incoming cost×1.8
  | "port"          // coast only; enables ships; +3 coins/tick
  | "fort"          // inner tile; ×3.0 defense on that cell
  | "factory"       // +8 units/tick
  | "missile_silo"  // unlocks bombs (atom → hydrogen → dirty)
  | "sam_launcher"  // intercepts incoming bombs 40% chance
  | "naval_base";   // doubles ship speed + capacity

type Building = {
  type: BuildingType; ownerIdx: number; gridIdx: number;
};

// Bombs unlocked from missile silo
type BombType = "atom" | "hydrogen" | "dirty";

// Ships carrying units toward target
type Ship = {
  id: string;
  ownerIdx: number;
  fromX: number; fromY: number;  // world-canvas coords
  toX: number;   toY: number;
  units: number;
  targetGridIdx: number;
  progress: number; // 0→1
  speed: number;
};

// Radiation zone (green blob, takeable)
type RadZone = { gridIdx: number; strength: number; decay: number };

// Radial menu state
type RadialMenu = {
  screenX: number; screenY: number;
  gx: number; gy: number;
  isOwnTerritory: boolean;
  isLand: boolean;
  isCoast: boolean;
  isEnemy: boolean;
  hasBuilding: boolean;
} | null;

// Build-placement mode
type PlaceMode = { type: BuildingType } | null;

type Particle = {
  x: number; y: number; vx: number; vy: number; life: number; color: string;
};

// ─── Constants ───────────────────────────────────────────────────────────────
const DIFFICULTY_REGEN: Record<string, number> = {
  relaxed: 0.6, balanced: 1.0, intense: 1.5,
};
const COST_NEUTRAL   = 1;
const COST_ENEMY_BASE = 3;
const FORT_DEFENSE   = 3.0;
const DEFPOST_MULT   = 1.8;
const FACTORY_UNITS  = 8;
const PORT_COINS     = 3;
const CITY_COINS     = 2;
const CITY_POP_CAP   = 500;
const STARTER_RADIUS = 1;
const FLOOD_PER_FRAME = 12;
const SHIP_BASE_SPEED = 0.0008; // fraction per ms

// Build costs: [coins, units]
const BUILD_COST: Record<BuildingType, [number, number]> = {
  city:         [80,  0],
  defense_post: [30, 20],
  port:         [60,  0],
  fort:         [40, 40],
  factory:      [70,  0],
  missile_silo: [200, 0],
  sam_launcher: [90,  0],
  naval_base:   [120, 0],
};
// Coin cost of each bomb type
const BOMB_COST: Record<BombType, number> = {
  atom: 300, hydrogen: 600, dirty: 200,
};
const BOMB_RADIUS: Record<BombType, number> = {
  atom: 12, hydrogen: 22, dirty: 8,
};
// Radiation strength (green blob duration)
const BOMB_RAD: Record<BombType, number> = {
  atom: 80, hydrogen: 160, dirty: 200,
};

const BUILDING_LABELS: Record<BuildingType, string> = {
  city: "City", defense_post: "Defense Post", port: "Port",
  fort: "Fort", factory: "Factory", missile_silo: "Missile Silo",
  sam_launcher: "SAM Launcher", naval_base: "Naval Base",
};
const BUILDING_ICONS: Record<BuildingType, string> = {
  city: "🏙", defense_post: "🛡", port: "⚓", fort: "🔶",
  factory: "🏭", missile_silo: "🚀", sam_launcher: "📡", naval_base: "🛳",
};

// Helper
function hexRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
}

interface GameScreenProps {
  lobby: Lobby; playerId: string; onLeave: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
export function GameScreen({ lobby, playerId, onLeave }: GameScreenProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [players,    setPlayers]    = useState<LobbyPlayer[]>([]);
  const [,           setTick]       = useState(0);
  const [sendPct,    setSendPct]    = useState(50);
  const [radialMenu, setRadialMenu] = useState<RadialMenu>(null);
  const [placeMode,  setPlaceMode]  = useState<PlaceMode>(null);
  const [bombMode,   setBombMode]   = useState<BombType | null>(null);
  const [buildings,  setBuildings]  = useState<Building[]>([]);
  const [hasSpawned, setHasSpawned] = useState(false);

  const sendPctRef   = useRef(50);
  const buildingsRef = useRef<Building[]>([]);
  const placeModeRef = useRef<PlaceMode>(null);
  const bombModeRef  = useRef<BombType | null>(null);
  useEffect(() => { sendPctRef.current   = sendPct;    }, [sendPct]);
  useEffect(() => { buildingsRef.current = buildings;  }, [buildings]);
  useEffect(() => { placeModeRef.current = placeMode;  }, [placeMode]);
  useEffect(() => { bombModeRef.current  = bombMode;   }, [bombMode]);

  // Core grid state (ownerGridRef: -1 = unclaimed, ≥0 = player index)
  const ownerGridRef   = useRef<Int16Array>(new Int16Array(GRID_W * GRID_H).fill(-1));
  const landMaskRef    = useRef<Uint8Array | null>(null);
  const coastMaskRef   = useRef<Uint8Array | null>(null);  // cells adjacent to ocean
  const radZonesRef    = useRef<RadZone[]>([]);
  const shipsRef       = useRef<Ship[]>([]);
  const playersRef     = useRef<Map<string, LobbyPlayer>>(new Map());
  const playerIndexRef = useRef<Map<string, number>>(new Map());
  const colorsRef      = useRef<[number, number, number][]>([]);
  const lastSyncRef    = useRef<number>(0);
  const lastBotRef     = useRef<number>(0);
  const channelRef     = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const camRef      = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef     = useRef({ active: false, startX: 0, startY: 0, camX: 0, camY: 0 });
  const dragMovedRef= useRef(false);
  const mapRectRef  = useRef({ x: 0, y: 0, w: 0, h: 0 });

  const floodQueueRef = useRef<Array<[number, number]>>([]);
  const particlesRef  = useRef<Particle[]>([]);

  function notify(msg: string, kind: "info"|"error"|"success" = "info") {
    if (kind === "error")   toast.error(msg);
    else if (kind === "success") toast.success(msg);
    else toast(msg);
  }

  // Build coast mask (land cells adjacent to at least one ocean cell)
  function buildCoastMask(mask: Uint8Array): Uint8Array {
    const coast = new Uint8Array(GRID_W * GRID_H);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % GRID_W, y = Math.floor(i / GRID_W);
      for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
        const nx=x+dx, ny=y+dy;
        if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) { coast[i]=1; break; }
        const ni=ny*GRID_W+nx;
        if (!mask[ni]) { coast[i]=1; break; }
      }
    }
    return coast;
  }

  const screenToGrid = useCallback((sx: number, sy: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = (sx - rect.left) * devicePixelRatio;
    const py = (sy - rect.top)  * devicePixelRatio;
    const cam = camRef.current;
    const wx = (px - cam.x) / cam.zoom;
    const wy = (py - cam.y) / cam.zoom;
    const mr = mapRectRef.current;
    const gx = Math.floor((wx - mr.x) / (mr.w / GRID_W));
    const gy = Math.floor((wy - mr.y) / (mr.h / GRID_H));
    if (gx<0||gy<0||gx>=GRID_W||gy>=GRID_H) return null;
    return { gx, gy };
  }, []);

  // Grid idx → canvas world coords (center of cell)
  function gridIdxToWorld(idx: number) {
    const mr = mapRectRef.current;
    const cellW = mr.w / GRID_W, cellH = mr.h / GRID_H;
    const x = idx % GRID_W, y = Math.floor(idx / GRID_W);
    return { wx: mr.x + (x + 0.5) * cellW, wy: mr.y + (y + 0.5) * cellH };
  }

  // ── Load players + realtime ─────────────────────────────────────────────
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
      data.forEach((p, i) => { idx.set(p.player_id, i); cols.push(hexRgb(p.color)); });
      playerIndexRef.current = idx;
      colorsRef.current = cols;
    }
    load();

    const ch = supabase
      .channel(`game-${lobby.id}`, { config: { broadcast: { self: false } } })
      .on("postgres_changes", {
        event: "*", schema: "public", table: "lobby_players",
        filter: `lobby_id=eq.${lobby.id}`
      }, payload => {
        if (payload.eventType === "DELETE") return;
        const p = payload.new as LobbyPlayer;
        playersRef.current.set(p.player_id, p);
        setPlayers(prev => {
          const i = prev.findIndex(x => x.player_id === p.player_id);
          if (i===-1) return [...prev, p];
          const next=[...prev]; next[i]=p; return next;
        });
      })
      .on("broadcast", { event: "claim" }, ({ payload }) => {
        const claims = payload as { i: number; o: number }[];
        const grid = ownerGridRef.current;
        for (const c of claims) grid[c.i] = c.o;
      })
      .on("broadcast", { event: "building" }, ({ payload }) => {
        const b = payload as Building;
        if (!buildingsRef.current.some(x => x.gridIdx===b.gridIdx)) {
          buildingsRef.current = [...buildingsRef.current, b];
          setBuildings(prev => [...prev, b]);
        }
      })
      .on("broadcast", { event: "rad_zone" }, ({ payload }) => {
        const rz = payload as RadZone[];
        radZonesRef.current = [...radZonesRef.current, ...rz];
      })
      .on("broadcast", { event: "ship" }, ({ payload }) => {
        const s = payload as Ship;
        if (!shipsRef.current.find(x => x.id===s.id))
          shipsRef.current = [...shipsRef.current, s];
      })
      .subscribe();
    channelRef.current = ch;
    return () => { active=false; supabase.removeChannel(ch); channelRef.current=null; };
  }, [lobby.id]);

  useEffect(() => {
    loadLandMask().then(m => {
      landMaskRef.current = m;
      coastMaskRef.current = buildCoastMask(m);
    });
  }, []);

  // ─── Render + sim loop ──────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas||!container) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let lastFrame = performance.now();

    // Offscreen for territory
    const off = document.createElement("canvas");
    off.width = GRID_W; off.height = GRID_H;
    const offCtx = off.getContext("2d")!;
    const imgData = offCtx.createImageData(GRID_W, GRID_H);

    const bgImg = new Image(); bgImg.src = worldMap;

    function resize() {
      const r = container!.getBoundingClientRect();
      canvas!.width  = r.width  * devicePixelRatio;
      canvas!.height = r.height * devicePixelRatio;
      canvas!.style.width  = `${r.width}px`;
      canvas!.style.height = `${r.height}px`;
      mapRectRef.current = computeMapRect();
    }
    function computeMapRect() {
      const w=canvas!.width, h=canvas!.height;
      const mapRatio=1920/960, canvasRatio=w/h;
      let mw,mh,mx,my: number;
      if (canvasRatio>mapRatio) { mh=h; mw=h*mapRatio; mx=(w-mw)/2; my=0; }
      else { mw=w; mh=w/mapRatio; mx=0; my=(h-mh)/2; }
      return { x:mx,y:my,w:mw,h:mh };
    }
    resize();
    const ro = new ResizeObserver(resize); ro.observe(container);

    // ── Sync stats to DB ──────────────────────────────────────────────────
    async function syncStats() {
      if (lobby.host_id !== playerId) return;
      const grid = ownerGridRef.current;
      const blds = buildingsRef.current;

      // Update building ownership when territory changes
      blds.forEach(b => {
        const cur = grid[b.gridIdx];
        if (cur >= 0 && cur !== b.ownerIdx) b.ownerIdx = cur;
      });

      const pixelCounts = new Array(colorsRef.current.length).fill(0);
      for (let i=0;i<grid.length;i++) { const o=grid[i]; if(o>=0) pixelCounts[o]++; }

      const unitBonus  = new Array(colorsRef.current.length).fill(0);
      const coinBonus  = new Array(colorsRef.current.length).fill(0);
      const popCapBonus= new Array(colorsRef.current.length).fill(0);
      blds.forEach(b => {
        const o = b.ownerIdx;
        if (b.type==="factory")    unitBonus[o]  = (unitBonus[o]||0)  + FACTORY_UNITS;
        if (b.type==="port")       coinBonus[o]  = (coinBonus[o]||0)  + PORT_COINS;
        if (b.type==="city")      { coinBonus[o]  = (coinBonus[o]||0)  + CITY_COINS;
                                    popCapBonus[o]= (popCapBonus[o]||0)+ CITY_POP_CAP; }
      });

      const regenMult = DIFFICULTY_REGEN[lobby.difficulty]??1;
      const updates: Promise<unknown>[] = [];
      playersRef.current.forEach((p) => {
        const idx = playerIndexRef.current.get(p.player_id);
        if (idx===undefined) return;
        const px = pixelCounts[idx]??0;
        const passive = Math.round(Math.sqrt(px)*2*regenMult);
        const newUnits = Math.min(9999+(popCapBonus[idx]||0), p.units+passive+(unitBonus[idx]||0));
        const passiveCoins = Math.max(1, Math.floor(Math.sqrt(px) * 0.3 * regenMult));
        const newCoins = Math.min(99999, (p.coins||0)+passiveCoins+(coinBonus[idx]||0));
        const alive = px>0||p.units>0;
        updates.push(supabase.from("lobby_players")
          .update({ pixels:px, units:newUnits, coins:newCoins, alive })
          .eq("lobby_id", lobby.id).eq("player_id", p.player_id));
      });
      await Promise.all(updates);
    }

    // ── Draw building icon ─────────────────────────────────────────────────
    function drawBuildingIcon(px:number,py:number,type:BuildingType,color:string,zoom:number) {
      ctx.save();
      const r = Math.max(3, Math.min(8, 5*zoom));
      ctx.fillStyle   = color;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.lineWidth   = 1;
      switch(type) {
        case "city": {
          ctx.fillRect(px-r,py-r*0.6,r*2,r*1.4); ctx.strokeRect(px-r,py-r*0.6,r*2,r*1.4);
          ctx.fillRect(px-r,py-r*1.5,r*0.7,r*0.9); ctx.strokeRect(px-r,py-r*1.5,r*0.7,r*0.9);
          ctx.fillRect(px+r*0.3,py-r*1.8,r*0.7,r*1.2); ctx.strokeRect(px+r*0.3,py-r*1.8,r*0.7,r*1.2);
          break;
        }
        case "defense_post": {
          ctx.beginPath(); ctx.moveTo(px,py-r*1.4);
          ctx.lineTo(px+r,py-r*0.4); ctx.lineTo(px+r,py+r*0.6);
          ctx.lineTo(px,py+r*1.4); ctx.lineTo(px-r,py+r*0.6);
          ctx.lineTo(px-r,py-r*0.4); ctx.closePath(); ctx.fill(); ctx.stroke(); break;
        }
        case "port": {
          ctx.beginPath(); ctx.arc(px,py-r*0.6,r*0.55,0,Math.PI*2); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(px,py-r*0.6); ctx.lineTo(px,py+r);
          ctx.moveTo(px-r*0.8,py+r*0.6); ctx.lineTo(px+r*0.8,py+r*0.6);
          ctx.stroke(); break;
        }
        case "fort": {
          ctx.beginPath();
          for(let a=0;a<6;a++){
            const ang=(a/6)*Math.PI*2-Math.PI/6;
            a===0?ctx.moveTo(px+Math.cos(ang)*r,py+Math.sin(ang)*r)
                 :ctx.lineTo(px+Math.cos(ang)*r,py+Math.sin(ang)*r);
          }
          ctx.closePath(); ctx.fill(); ctx.stroke(); break;
        }
        case "factory": {
          ctx.fillRect(px-r,py-r*0.6,r*2,r*1.4); ctx.strokeRect(px-r,py-r*0.6,r*2,r*1.4);
          ctx.fillRect(px-r*0.5,py-r*1.5,r*0.55,r); ctx.strokeRect(px-r*0.5,py-r*1.5,r*0.55,r);
          break;
        }
        case "missile_silo": {
          ctx.beginPath();
          ctx.moveTo(px,py-r*1.5); ctx.lineTo(px+r*0.75,py+r); ctx.lineTo(px-r*0.75,py+r);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.fillStyle="#f97316";
          ctx.beginPath();
          ctx.moveTo(px-r*0.4,py+r); ctx.lineTo(px,py+r*1.9); ctx.lineTo(px+r*0.4,py+r);
          ctx.closePath(); ctx.fill(); break;
        }
        case "sam_launcher": {
          // Radar dish
          ctx.beginPath(); ctx.arc(px,py,r,Math.PI,Math.PI*2); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(px,py+r); ctx.stroke(); break;
        }
        case "naval_base": {
          // Ship silhouette
          ctx.beginPath();
          ctx.moveTo(px-r,py+r*0.3); ctx.lineTo(px+r,py+r*0.3);
          ctx.lineTo(px+r*0.7,py-r*0.3); ctx.lineTo(px-r*0.7,py-r*0.3);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.fillRect(px-r*0.15,py-r,r*0.3,r*0.7);
          break;
        }
      }
      ctx.restore();
    }

    // ── Main render ────────────────────────────────────────────────────────
    function render() {
      const w=canvas!.width, h=canvas!.height;
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle="#0a1628"; ctx.fillRect(0,0,w,h);
      const mr=computeMapRect(); mapRectRef.current=mr;
      const {x:mx,y:my,w:mw,h:mh}=mr;
      const cellW=mw/GRID_W, cellH=mh/GRID_H;
      const cam=camRef.current;

      ctx.save();
      ctx.translate(cam.x,cam.y); ctx.scale(cam.zoom,cam.zoom);

      // Map image
      if(bgImg.complete) ctx.drawImage(bgImg,mx,my,mw,mh);
      else { ctx.fillStyle="#1a3050"; ctx.fillRect(mx,my,mw,mh); }

      // ── Territory fill (ImageData) ──────────────────────────────────────
      const grid = ownerGridRef.current;
      const colors = colorsRef.current;
      const data = imgData.data;
      const radSet = new Map<number,number>(); // idx → strength
      radZonesRef.current.forEach(rz => radSet.set(rz.gridIdx, rz.strength));
      const defPostSet = new Set(
        buildingsRef.current.filter(b=>b.type==="defense_post").map(b=>b.gridIdx)
      );

      for(let i=0;i<grid.length;i++){
        // Radiation zone (green blob, priority over owner)
        if(radSet.has(i)){
          const str = radSet.get(i)!;
          const alpha = Math.min(200, 100+str*0.6);
          data[i*4]=20; data[i*4+1]=220; data[i*4+2]=60; data[i*4+3]=alpha;
          continue;
        }
        const o=grid[i];
        if(o<0||!colors[o]){ data[i*4+3]=0; continue; }
        const c=colors[o];
        const x=i%GRID_W,y=Math.floor(i/GRID_W);
        const checker=defPostSet.has(i)&&(x+y)%2===0;
        data[i*4]  =checker?Math.min(255,c[0]+70):c[0];
        data[i*4+1]=checker?Math.min(255,c[1]+70):c[1];
        data[i*4+2]=checker?Math.min(255,c[2]+70):c[2];
        data[i*4+3]=185;
      }
      offCtx.putImageData(imgData,0,0);
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(off,mx,my,mw,mh);
      ctx.imageSmoothingEnabled=true;

      // ── Border outlines ─────────────────────────────────────────────────
      for(let i=0;i<grid.length;i++){
        const o=grid[i]; if(o<0) continue;
        const x=i%GRID_W,y=Math.floor(i/GRID_W);
        let isBorder=false;
        if(x===0||y===0||x===GRID_W-1||y===GRID_H-1) isBorder=true;
        else {
          if(grid[i+1]!==o||grid[i-1]!==o||grid[i+GRID_W]!==o||grid[i-GRID_W]!==o) isBorder=true;
        }
        if(!isBorder) continue;
        const c=colors[o];
        ctx.strokeStyle=`rgba(${Math.min(255,c[0]+90)},${Math.min(255,c[1]+90)},${Math.min(255,c[2]+90)},0.95)`;
        ctx.lineWidth=Math.max(0.6,cellW*0.35);
        ctx.strokeRect(mx+x*cellW+0.5,my+y*cellH+0.5,cellW-1,cellH-1);
      }

      // ── Buildings ──────────────────────────────────────────────────────
      buildingsRef.current.forEach(b => {
        const curOwner=grid[b.gridIdx];
        const entry=[...playerIndexRef.current.entries()].find(([,v])=>v===curOwner);
        const ownerP=entry?playersRef.current.get(entry[0]):null;
        const col=ownerP?.color??"#fff";
        const bx=(b.gridIdx%GRID_W)/GRID_W, by=Math.floor(b.gridIdx/GRID_W)/GRID_H;
        const px2=mx+bx*mw+cellW/2, py2=my+by*mh+cellH/2;
        drawBuildingIcon(px2,py2,b.type,col,cam.zoom);
      });

      // ── Ships ──────────────────────────────────────────────────────────
      shipsRef.current.forEach(ship => {
        const sx = ship.fromX+(ship.toX-ship.fromX)*ship.progress;
        const sy = ship.fromY+(ship.toY-ship.fromY)*ship.progress;
        const entry=[...playerIndexRef.current.entries()].find(([,v])=>v===ship.ownerIdx);
        const ownerP=entry?playersRef.current.get(entry[0]):null;
        const col=ownerP?.color??"#4af";

        ctx.save();
        // Hull
        ctx.translate(sx,sy);
        const angle=Math.atan2(ship.toY-ship.fromY,ship.toX-ship.fromX);
        ctx.rotate(angle);
        ctx.fillStyle=col;
        ctx.strokeStyle="rgba(255,255,255,0.8)";
        ctx.lineWidth=0.8;
        ctx.beginPath();
        ctx.ellipse(0,0,6,3,0,0,Math.PI*2);
        ctx.fill(); ctx.stroke();
        // Wake trail
        ctx.globalAlpha=0.3;
        ctx.strokeStyle="#fff";
        ctx.lineWidth=1.5;
        ctx.beginPath();
        ctx.moveTo(-8,1.5); ctx.lineTo(-16,3);
        ctx.moveTo(-8,-1.5); ctx.lineTo(-16,-3);
        ctx.stroke();
        ctx.restore();

        // Unit count
        ctx.save();
        ctx.fillStyle="#fff";
        ctx.font=`bold ${Math.max(6,8*cam.zoom)}px monospace`;
        ctx.textAlign="center"; ctx.textBaseline="middle";
        ctx.shadowColor="rgba(0,0,0,0.9)"; ctx.shadowBlur=3;
        ctx.fillText(`${ship.units}`, sx, sy-10);
        ctx.restore();
      });

      // ── Nameplates ────────────────────────────────────────────────────
      {
        const sumX=new Float64Array(colors.length);
        const sumY=new Float64Array(colors.length);
        const countP=new Int32Array(colors.length);
        for(let i=0;i<grid.length;i++){
          const o=grid[i]; if(o<0||o>=colors.length) continue;
          sumX[o]+=i%GRID_W; sumY[o]+=Math.floor(i/GRID_W); countP[o]++;
        }
        ctx.save();
        ctx.textAlign="center"; ctx.textBaseline="middle";
        const baseFont=Math.max(6,Math.min(16,11/cam.zoom));
        playerIndexRef.current.forEach((idx,pid)=>{
          if(countP[idx]<5) return;
          const p=playersRef.current.get(pid);
          if(!p||!p.alive) return;
          const sx=mx+(sumX[idx]/countP[idx]/GRID_W)*mw;
          const sy=my+(sumY[idx]/countP[idx]/GRID_H)*mh;
          ctx.font=`bold ${baseFont}px sans-serif`;
          ctx.shadowColor="rgba(0,0,0,0.95)"; ctx.shadowBlur=4;
          ctx.fillStyle="#fff";
          ctx.fillText(p.name,sx,sy-baseFont*0.65);
          const troopStr=p.units>=1000?`${(p.units/1000).toFixed(1)}K`:`${p.units}`;
          ctx.font=`${baseFont*0.85}px monospace`;
          ctx.fillStyle="rgba(255,255,200,0.9)";
          ctx.fillText(troopStr,sx,sy+baseFont*0.65);
          ctx.shadowBlur=0;
        });
        ctx.restore();
      }

      ctx.restore(); // end camera

      // ── Particles (screen-space) ───────────────────────────────────────
      for(const p of particlesRef.current){
        ctx.globalAlpha=p.life*0.8;
        ctx.fillStyle=p.color;
        ctx.beginPath();
        ctx.arc(p.x,p.y,1.5+p.life*2,0,Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha=1;

      // ── Place mode cursor hint ─────────────────────────────────────────
      if(placeModeRef.current||bombModeRef.current){
        ctx.save();
        ctx.font="14px sans-serif";
        ctx.fillStyle="rgba(255,255,100,0.9)";
        ctx.textAlign="center";
        const label=placeModeRef.current
          ? `Click to place ${BUILDING_LABELS[placeModeRef.current.type]}`
          : `Click to drop ${bombModeRef.current} bomb · Right-click to cancel`;
        ctx.fillText(label, canvas!.width/2, 28*devicePixelRatio);
        ctx.restore();
      }
    }

    // ── Main loop ─────────────────────────────────────────────────────────
    function loop(now: number) {
      const dt = now - lastFrame; lastFrame = now;

      // Flood animation
      const fq = floodQueueRef.current;
      const grid = ownerGridRef.current;
      const mr = mapRectRef.current;
      if(fq.length>0){
        const batch=fq.splice(0,FLOOD_PER_FRAME);
        const cam2=camRef.current;
        for(const [ci,oi] of batch){
          grid[ci]=oi;
          const wx2=mr.x+((ci%GRID_W)+0.5)/GRID_W*mr.w;
          const wy2=mr.y+(Math.floor(ci/GRID_W)+0.5)/GRID_H*mr.h;
          const scx=cam2.x+wx2*cam2.zoom;
          const scy=cam2.y+wy2*cam2.zoom;
          const entry=[...playerIndexRef.current.entries()].find(([,v])=>v===oi);
          const col=entry?playersRef.current.get(entry[0])?.color??"#fff":"#fff";
          for(let pi=0;pi<2;pi++){
            const ang=Math.random()*Math.PI*2;
            const spd=0.3+Math.random()*0.5;
            particlesRef.current.push({x:scx,y:scy,vx:Math.cos(ang)*spd,vy:Math.sin(ang)*spd,life:1,color:col});
          }
        }
        if(batch.length>0)
          channelRef.current?.send({type:"broadcast",event:"claim",payload:batch.map(([i,o])=>({i,o}))});
      }

      // Ship movement
      const navalBaseOwners = new Set(
        buildingsRef.current.filter(b=>b.type==="naval_base").map(b=>b.ownerIdx)
      );
      shipsRef.current=shipsRef.current.filter(ship=>{
        const spd=SHIP_BASE_SPEED*(navalBaseOwners.has(ship.ownerIdx)?2:1)*dt;
        ship.progress=Math.min(1,ship.progress+spd);
        if(ship.progress>=1){
          // Arrive — claim landing zone
          const entry=[...playerIndexRef.current.entries()].find(([,v])=>v===ship.ownerIdx);
          const ownerPid=entry?.[0];
          if(ownerPid){
            const p=playersRef.current.get(ownerPid);
            if(p) executeAttack(ship.targetGridIdx,ship.units,ship.ownerIdx,ownerPid,p.units+ship.units);
          }
          return false;
        }
        return true;
      });

      // Radiation decay
      radZonesRef.current=radZonesRef.current.filter(rz=>{
        rz.strength=Math.max(0,rz.strength-rz.decay*dt*0.01);
        return rz.strength>0;
      });

      // Particles
      const cam=camRef.current;
      particlesRef.current=particlesRef.current.filter(p=>{
        p.x+=p.vx*cam.zoom; p.y+=p.vy*cam.zoom; p.life-=0.04;
        return p.life>0;
      });

      render();

      if(now-lastSyncRef.current>1500){ lastSyncRef.current=now; syncStats(); }

      // ── Bot AI ──────────────────────────────────────────────────────────
      if(lobby.host_id===playerId&&now-lastBotRef.current>2000){
        lastBotRef.current=now;
        const mask=landMaskRef.current;
        if(mask){
          playersRef.current.forEach(bot=>{
            if(!bot.is_bot||!bot.alive) return;
            const idx=playerIndexRef.current.get(bot.player_id);
            if(idx===undefined) return;
            const owned: number[]=[];
            for(let i=0;i<grid.length;i++) if(grid[i]===idx) owned.push(i);
            if(owned.length===0){
              const cands: number[]=[];
              for(let i=0;i<mask.length;i++) if(mask[i]&&grid[i]===-1) cands.push(i);
              if(cands.length===0) return;
              plantStarter(cands[Math.floor(Math.random()*cands.length)],idx); return;
            }
            const coins=bot.coins||0;
            if(coins>80&&buildingsRef.current.filter(b=>b.ownerIdx===idx).length<5){
              const free=owned.filter(k=>!buildingsRef.current.some(b=>b.gridIdx===k));
              if(free.length>0){
                const pick=free[Math.floor(Math.random()*free.length)];
                const btype:BuildingType=coins>150?"factory":coins>100?"defense_post":"city";
                const [cc]=BUILD_COST[btype];
                if(coins>=cc){
                  const bld:Building={type:btype,ownerIdx:idx,gridIdx:pick};
                  buildingsRef.current=[...buildingsRef.current,bld];
                  setBuildings(prev=>[...prev,bld]);
                  channelRef.current?.send({type:"broadcast",event:"building",payload:bld});
                  bot.coins=(bot.coins||0)-cc;
                }
              }
            }
            if(bot.units<20) return;
            const neutral:number[]=[],enemy:number[]=[];
            for(const i of owned){
              const x=i%GRID_W,y=Math.floor(i/GRID_W);
              for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const){
                const nx=x+dx,ny=y+dy;
                if(nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
                const ni=ny*GRID_W+nx;
                if(!mask[ni]) continue;
                if(grid[ni]===-1) neutral.push(ni);
                else if(grid[ni]!==idx) enemy.push(ni);
              }
            }
            let target=-1;
            if(neutral.length>0&&bot.units>30){
              target=neutral[Math.floor(Math.random()*neutral.length)];
            } else if(enemy.length>0&&bot.units>100){
              target=enemy[Math.floor(Math.random()*enemy.length)];
            }
            if(target===-1) return;
            const sendUnits=Math.max(5,Math.floor(bot.units*0.4));
            executeAttack(target,sendUnits,idx,bot.player_id,bot.units);
          });
        }
      }

      setTick(t=>(t+1)%1000000);
      raf=requestAnimationFrame(loop);
    }
    raf=requestAnimationFrame(loop);

    // ── Input ─────────────────────────────────────────────────────────────
    function onWheel(e:WheelEvent){
      e.preventDefault();
      const r=canvas!.getBoundingClientRect();
      const mx2=(e.clientX-r.left)*devicePixelRatio;
      const my2=(e.clientY-r.top)*devicePixelRatio;
      const factor=e.deltaY<0?1.15:0.87;
      const c=camRef.current;
      const newZoom=Math.min(10,Math.max(0.3,c.zoom*factor));
      c.x=mx2-(mx2-c.x)*(newZoom/c.zoom);
      c.y=my2-(my2-c.y)*(newZoom/c.zoom);
      c.zoom=newZoom;
    }
    function onMouseDown(e:MouseEvent){
      if(e.button===1||e.button===2){
        e.preventDefault();
        dragMovedRef.current=false;
        dragRef.current={active:true,startX:e.clientX,startY:e.clientY,
          camX:camRef.current.x,camY:camRef.current.y};
      }
    }
    function onMouseMove(e:MouseEvent){
      if(!dragRef.current.active) return;
      const dx=(e.clientX-dragRef.current.startX)*devicePixelRatio;
      const dy=(e.clientY-dragRef.current.startY)*devicePixelRatio;
      if(Math.abs(dx)>3||Math.abs(dy)>3) dragMovedRef.current=true;
      camRef.current.x=dragRef.current.camX+dx;
      camRef.current.y=dragRef.current.camY+dy;
    }
    function onMouseUp(){ dragRef.current.active=false; }

    canvas.addEventListener("wheel",onWheel,{passive:false});
    canvas.addEventListener("mousedown",onMouseDown);
    window.addEventListener("mousemove",onMouseMove);
    window.addEventListener("mouseup",onMouseUp);

    return ()=>{
      cancelAnimationFrame(raf); ro.disconnect();
      canvas.removeEventListener("wheel",onWheel);
      canvas.removeEventListener("mousedown",onMouseDown);
      window.removeEventListener("mousemove",onMouseMove);
      window.removeEventListener("mouseup",onMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby.id,lobby.host_id,lobby.difficulty,playerId]);

  // ── Plant starter ─────────────────────────────────────────────────────────
  function plantStarter(centerIdx:number,ownerIdx:number){
    const mask=landMaskRef.current; if(!mask) return;
    const grid=ownerGridRef.current;
    const cx=centerIdx%GRID_W,cy=Math.floor(centerIdx/GRID_W);
    const claims:{i:number;o:number}[]=[];
    for(let dy=-STARTER_RADIUS;dy<=STARTER_RADIUS;dy++){
      for(let dx=-STARTER_RADIUS;dx<=STARTER_RADIUS;dx++){
        const x=cx+dx,y=cy+dy;
        if(x<0||y<0||x>=GRID_W||y>=GRID_H) continue;
        const i=y*GRID_W+x;
        if(mask[i]&&grid[i]===-1){ grid[i]=ownerIdx; claims.push({i,o:ownerIdx}); }
      }
    }
    if(claims.length>0)
      channelRef.current?.send({type:"broadcast",event:"claim",payload:claims});
  }

  // ── Pressure flood attack (border-adjacent spread) ───────────────────────
  function executeAttack(
    targetIdx:number, sendUnits:number,
    ownerIdx:number, ownerPid:string, currentUnits:number
  ): {spent:number;captured:number;repelled:boolean;unreachable?:boolean;reachedTarget?:boolean} {
    const mask=landMaskRef.current;
    if(!mask) return {spent:0,captured:0,repelled:true};
    const grid=ownerGridRef.current;
    const blds=buildingsRef.current;

    // Collect entire border frontier (ALL owned cells adjacent to non-owned land)
    const visited=new Uint8Array(grid.length);
    const seedQueue:number[]=[];
    let hasOwned=false;
    for(let i=0;i<grid.length;i++){
      if(grid[i]!==ownerIdx) continue;
      hasOwned=true; visited[i]=1;
      const x=i%GRID_W,y=Math.floor(i/GRID_W);
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const){
        const nx=x+dx,ny=y+dy;
        if(nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
        const ni=ny*GRID_W+nx;
        if(!visited[ni]&&mask[ni]&&grid[ni]!==ownerIdx){
          visited[ni]=1; seedQueue.push(ni);
        }
      }
    }
    if(!hasOwned||seedQueue.length===0) return {spent:0,captured:0,repelled:true};

    // BFS reachability
    {
      const reach=new Uint8Array(grid.length);
      const q=[...seedQueue]; q.forEach(i=>reach[i]=1);
      let reachable=false,h=0;
      while(h<q.length){
        const cur=q[h++];
        if(cur===targetIdx){reachable=true;break;}
        const x=cur%GRID_W,y=Math.floor(cur/GRID_W);
        for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const){
          const nx=x+dx,ny=y+dy;
          if(nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
          const ni=ny*GRID_W+nx;
          if(!reach[ni]&&mask[ni]){reach[ni]=1;q.push(ni);}
        }
      }
      if(!reachable) return {spent:0,captured:0,repelled:false,unreachable:true};
    }

    const tx=targetIdx%GRID_W,ty=Math.floor(targetIdx/GRID_W);
    const maxDist=GRID_W+GRID_H;
    const buckets:number[][]=Array.from({length:maxDist+1},()=>[]);
    for(const ni of seedQueue){
      const d=Math.abs(ni%GRID_W-tx)+Math.abs(Math.floor(ni/GRID_W)-ty);
      buckets[Math.min(d,maxDist)].push(ni);
    }

    // Cache defender strengths
    const defCache=new Map<number,number>();
    function defStr(defIdx:number){
      if(defCache.has(defIdx)) return defCache.get(defIdx)!;
      const entry=[...playerIndexRef.current.entries()].find(([,v])=>v===defIdx);
      const p=entry?playersRef.current.get(entry[0]):null;
      const s=p?Math.max(1,Math.sqrt(p.units)/5):1;
      defCache.set(defIdx,s); return s;
    }

    let pressure=sendUnits;
    const claims:{i:number;o:number}[]=[];
    let captured=0,reachedTarget=false;

    outer:
    for(let d=0;d<=maxDist&&pressure>0;d++){
      const bucket=buckets[d];
      if(!bucket||bucket.length===0) continue;
      for(let bi=0;bi<bucket.length&&pressure>0;bi++){
        const ni=bucket[bi];
        const cur=grid[ni]; if(cur===ownerIdx) continue;
        const hasFort   =cur!==-1&&blds.some(b=>b.gridIdx===ni&&b.type==="fort");
        const hasDefPost=cur!==-1&&blds.some(b=>b.gridIdx===ni&&b.type==="defense_post");
        let cost:number;
        if(cur===-1){
          const offAxis=reachedTarget?0:Math.max(0,d-2);
          cost=COST_NEUTRAL+Math.floor(offAxis*1.5);
        } else {
          const defMult=hasFort?FORT_DEFENSE:hasDefPost?DEFPOST_MULT:1;
          cost=Math.ceil(COST_ENEMY_BASE*defMult*defStr(cur));
        }
        if(pressure<cost) continue;
        pressure-=cost; grid[ni]=ownerIdx;
        claims.push({i:ni,o:ownerIdx}); captured++;
        if(ni===targetIdx) reachedTarget=true;
        const x=ni%GRID_W,y=Math.floor(ni/GRID_W);
        for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const){
          const nx=x+dx,ny=y+dy;
          if(nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
          const ni2=ny*GRID_W+nx;
          if(visited[ni2]||!mask[ni2]||grid[ni2]===ownerIdx) continue;
          visited[ni2]=1;
          const d2=Math.abs(nx-tx)+Math.abs(ny-ty);
          buckets[Math.min(d2,maxDist)].push(ni2);
        }
      }
      if(reachedTarget) break outer;
    }

    // Revert, hand to flood queue
    for(const {i} of claims) ownerGridRef.current[i]=-1;
    for(const {i,o} of claims) floodQueueRef.current.push([i,o]);

    const actuallySpent=sendUnits-pressure;
    const newUnits=Math.max(0,currentUnits-actuallySpent);
    const playerObj=playersRef.current.get(ownerPid);
    if(playerObj) playerObj.units=newUnits;
    supabase.from("lobby_players").update({units:newUnits})
      .eq("lobby_id",lobby.id).eq("player_id",ownerPid);

    return {spent:actuallySpent,captured,repelled:captured===0,reachedTarget,unreachable:false};
  }

  // ── Naval attack (launch ship) ────────────────────────────────────────────
  function launchShip(targetIdx:number,sendUnits:number,ownerIdx:number,ownerPid:string,currentUnits:number){
    const coast=coastMaskRef.current; if(!coast) return;
    // Find nearest coast cell owned by us
    const grid=ownerGridRef.current;
    let bestFrom=-1, bestDist=Infinity;
    for(let i=0;i<grid.length;i++){
      if(grid[i]!==ownerIdx||!coast[i]) continue;
      const fx=i%GRID_W,fy=Math.floor(i/GRID_W);
      const tx=targetIdx%GRID_W,ty=Math.floor(targetIdx/GRID_W);
      const d=Math.abs(fx-tx)+Math.abs(fy-ty);
      if(d<bestDist){bestDist=d;bestFrom=i;}
    }
    if(bestFrom===-1){ notify("You need a coastal tile to launch ships","error"); return; }
    const mr=mapRectRef.current;
    const cellW=mr.w/GRID_W,cellH=mr.h/GRID_H;
    const fx=(bestFrom%GRID_W+0.5)*cellW+mr.x;
    const fy=(Math.floor(bestFrom/GRID_W)+0.5)*cellH+mr.y;
    const tx=(targetIdx%GRID_W+0.5)*cellW+mr.x;
    const ty=(Math.floor(targetIdx/GRID_W)+0.5)*cellH+mr.y;
    const ship:Ship={
      id:crypto.randomUUID(),ownerIdx,
      fromX:fx,fromY:fy,toX:tx,toY:ty,
      units:sendUnits,targetGridIdx:targetIdx,
      progress:0,speed:SHIP_BASE_SPEED,
    };
    shipsRef.current=[...shipsRef.current,ship];
    channelRef.current?.send({type:"broadcast",event:"ship",payload:ship});
    const newUnits=Math.max(0,currentUnits-sendUnits);
    const p=playersRef.current.get(ownerPid);
    if(p) p.units=newUnits;
    supabase.from("lobby_players").update({units:newUnits})
      .eq("lobby_id",lobby.id).eq("player_id",ownerPid);
    notify(`Fleet of ${sendUnits} units launched!`,"success");
  }

  // ── Drop bomb ─────────────────────────────────────────────────────────────
  function dropBomb(targetIdx:number,btype:BombType,ownerPid:string){
    const me=playersRef.current.get(ownerPid); if(!me) return;
    const cost=BOMB_COST[btype];
    if((me.coins||0)<cost){ notify(`Need ${cost} coins for ${btype} bomb`,"error"); return; }
    // SAM interception
    const myIdx=playerIndexRef.current.get(ownerPid);
    const grid=ownerGridRef.current;
    const radius=BOMB_RADIUS[btype];
    const tx=targetIdx%GRID_W,ty=Math.floor(targetIdx/GRID_W);
    // Check enemy SAM launchers near target
    let intercepted=false;
    buildingsRef.current.forEach(b=>{
      if(b.type!=="sam_launcher") return;
      const curOwner=grid[b.gridIdx];
      if(curOwner===myIdx||curOwner===-1) return;
      const bx=b.gridIdx%GRID_W,by=Math.floor(b.gridIdx/GRID_W);
      if(Math.abs(bx-tx)+Math.abs(by-ty)<radius*3&&Math.random()<0.4){
        intercepted=true;
      }
    });
    if(intercepted){ notify("Bomb intercepted by SAM launcher!","error"); return; }

    // Destroy territory + buildings in radius
    const newCoins=(me.coins||0)-cost;
    me.coins=newCoins;
    supabase.from("lobby_players").update({coins:newCoins})
      .eq("lobby_id",lobby.id).eq("player_id",ownerPid);

    const affectedCells:number[]=[];
    const mask=landMaskRef.current; if(!mask) return;
    for(let dy=-radius;dy<=radius;dy++){
      for(let dx=-radius;dx<=radius;dx++){
        if(Math.abs(dx)+Math.abs(dy)>radius) continue;
        const nx=tx+dx,ny=ty+dy;
        if(nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
        if(!mask[ny*GRID_W+nx]) continue;
        affectedCells.push(ny*GRID_W+nx);
      }
    }

    // Remove buildings in blast zone
    buildingsRef.current=buildingsRef.current.filter(b=>!affectedCells.includes(b.gridIdx));
    setBuildings(prev=>prev.filter(b=>!affectedCells.includes(b.gridIdx)));

    // Clear territory (claimable afterwards)
    affectedCells.forEach(i=>{ grid[i]=-1; });
    channelRef.current?.send({type:"broadcast",event:"claim",payload:affectedCells.map(i=>({i,o:-1}))});

    // Add radiation for dirty/atom/hydrogen
    const radStr=BOMB_RAD[btype];
    const newZones:RadZone[]=affectedCells.map(i=>({gridIdx:i,strength:radStr,decay:btype==="dirty"?0.05:0.3}));
    radZonesRef.current=[...radZonesRef.current,...newZones];
    channelRef.current?.send({type:"broadcast",event:"rad_zone",payload:newZones});

    // Big explosion particles
    const mr=mapRectRef.current;
    const cam=camRef.current;
    const wx=mr.x+(tx+0.5)/GRID_W*mr.w;
    const wy=mr.y+(ty+0.5)/GRID_H*mr.h;
    const scx=cam.x+wx*cam.zoom,scy=cam.y+wy*cam.zoom;
    for(let pi=0;pi<60;pi++){
      const ang=Math.random()*Math.PI*2;
      const spd=1+Math.random()*4;
      particlesRef.current.push({x:scx,y:scy,vx:Math.cos(ang)*spd,vy:Math.sin(ang)*spd,
        life:1,color:btype==="dirty"?"#22c55e":btype==="hydrogen"?"#818cf8":"#f97316"});
    }
    notify(`${btype.charAt(0).toUpperCase()+btype.slice(1)} bomb detonated!`,"success");
  }

  // ── Building cost (scales with count) ─────────────────────────────────────
  function getBuildCost(type:BuildingType,ownerIdx:number):[number,number]{
    const [baseCoins,baseUnits]=BUILD_COST[type];
    const existing=buildingsRef.current.filter(b=>b.ownerIdx===ownerIdx&&b.type===type).length;
    const mult=1+existing*0.5;
    return [Math.round(baseCoins*mult),Math.round(baseUnits*mult)];
  }

  // ── Place building ─────────────────────────────────────────────────────────
  function doPlaceBuilding(gx:number,gy:number,type:BuildingType){
    setPlaceMode(null); placeModeRef.current=null;
    const me=playersRef.current.get(playerId); if(!me) return;
    const myIdx=playerIndexRef.current.get(playerId); if(myIdx===undefined) return;
    const gridIdx=gy*GRID_W+gx;
    if(ownerGridRef.current[gridIdx]!==myIdx){ notify("Build on your own territory","error"); return; }
    if(buildingsRef.current.some(b=>b.gridIdx===gridIdx)){ notify("Tile already has a building","error"); return; }
    if(type==="port"||type==="naval_base"){
      const coast=coastMaskRef.current;
      if(!coast||!coast[gridIdx]){ notify("Ports must be placed on a coastal tile","error"); return; }
    }
    const [cc,cu]=getBuildCost(type,myIdx);
    if((me.coins||0)<cc){ notify(`Need ${cc} coins for ${BUILDING_LABELS[type]}`,"error"); return; }
    if(me.units<cu){ notify(`Need ${cu} units for ${BUILDING_LABELS[type]}`,"error"); return; }
    const building:Building={type,ownerIdx:myIdx,gridIdx};
    setBuildings(prev=>[...prev,building]);
    buildingsRef.current=[...buildingsRef.current,building];
    channelRef.current?.send({type:"broadcast",event:"building",payload:building});
    const newCoins=(me.coins||0)-cc;
    const newUnits=me.units-cu;
    me.coins=newCoins; me.units=newUnits;
    supabase.from("lobby_players").update({coins:newCoins,units:newUnits})
      .eq("lobby_id",lobby.id).eq("player_id",playerId);
    notify(`${BUILDING_LABELS[type]} built!`,"success");
  }

  // ── Click handler ─────────────────────────────────────────────────────────
  function handleClick(e:React.MouseEvent){
    if(dragMovedRef.current){ dragMovedRef.current=false; return; }
    if(radialMenu){ setRadialMenu(null); return; }
    const coords=screenToGrid(e.clientX,e.clientY); if(!coords) return;
    const {gx,gy}=coords;
    const me=playersRef.current.get(playerId); if(!me) return;
    const myIdx=playerIndexRef.current.get(playerId); if(myIdx===undefined) return;
    const i=gy*GRID_W+gx;
    const mask=landMaskRef.current; if(!mask) return;

    // Bomb mode
    if(bombModeRef.current){
      dropBomb(i,bombModeRef.current,playerId);
      setBombMode(null); bombModeRef.current=null;
      return;
    }

    // Place mode
    if(placeModeRef.current){
      if(!mask[i]){ notify("Click on land","error"); return; }
      doPlaceBuilding(gx,gy,placeModeRef.current.type);
      return;
    }

    // Spawn
    let mineCount=0;
    const grid=ownerGridRef.current;
    for(let k=0;k<grid.length;k++) if(grid[k]===myIdx){mineCount++;break;}
    if(mineCount===0){
      if(!mask[i]){ notify("Click on land to start","error"); return; }
      if(grid[i]!==-1){ notify("Pick an unclaimed tile","error"); return; }
      plantStarter(i,myIdx); setHasSpawned(true);
      notify("Empire founded! Click land to expand.","success"); return;
    }

    if(!mask[i]){ notify("Click on land","error"); return; }
    if(grid[i]===myIdx){ notify("Already yours","error"); return; }

    const sending=Math.max(1,Math.floor(me.units*sendPctRef.current/100));
    if(sending<1){ notify("Not enough units","error"); return; }

    // Is target reachable by land?
    const coast=coastMaskRef.current;
    const result=executeAttack(i,sending,myIdx,playerId,me.units);
    if(result.unreachable){
      // Try naval if we have a coast tile and a port
      const hasPort=buildingsRef.current.some(b=>b.ownerIdx===myIdx&&b.type==="port");
      if(coast&&hasPort){
        launchShip(i,sending,myIdx,playerId,me.units);
      } else {
        notify("No land path — build a Port to launch ships","error");
      }
      return;
    }
    if(result.captured===0){ notify("Attack repelled","error"); return; }
  }

  function handleContextMenu(e:React.MouseEvent){
    e.preventDefault();
    // Cancel modes on right-click
    if(placeModeRef.current||bombModeRef.current){
      setPlaceMode(null); setBombMode(null);
      placeModeRef.current=null; bombModeRef.current=null;
      return;
    }
    const coords=screenToGrid(e.clientX,e.clientY); if(!coords) return;
    const {gx,gy}=coords;
    const myIdx=playerIndexRef.current.get(playerId);
    const i=gy*GRID_W+gx;
    const grid=ownerGridRef.current;
    const mask=landMaskRef.current;
    const coast=coastMaskRef.current;
    setRadialMenu({
      screenX:e.clientX, screenY:e.clientY, gx, gy,
      isOwnTerritory:myIdx!==undefined&&grid[i]===myIdx,
      isLand:mask?!!mask[i]:false,
      isCoast:coast?!!coast[i]:false,
      isEnemy:myIdx!==undefined&&grid[i]>=0&&grid[i]!==myIdx,
      hasBuilding:buildingsRef.current.some(b=>b.gridIdx===i),
    });
  }

  // ─── Derived state ────────────────────────────────────────────────────────
  const sortedPlayers=[...players].sort((a,b)=>b.pixels-a.pixels);
  const me=playersRef.current.get(playerId);
  const myIdx=playerIndexRef.current.get(playerId);
  const myCubeCount=me?me.pixels:0;
  const sendingUnits=me?Math.max(1,Math.floor(me.units*sendPct/100)):0;
  const hasSilo=myIdx!==undefined&&buildingsRef.current.some(b=>b.ownerIdx===myIdx&&b.type==="missile_silo");

  // Buildable types for toolbar
  const TOOLBAR_BUILDINGS: BuildingType[] = [
    "city","factory","port","naval_base","defense_post","fort","missile_silo","sam_launcher"
  ];

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} className="relative h-screen w-screen overflow-hidden bg-[#0a1628]">
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: placeMode||bombMode ? "crosshair" : "default" }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      />

      {/* Starter prompt */}
      {me&&myCubeCount===0&&!hasSpawned&&(
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 rounded-xl border border-primary/60 bg-card/95 px-6 py-4 text-center shadow-2xl backdrop-blur-md pointer-events-none">
          <div className="text-lg font-bold text-foreground mb-1">Pick your starting tile</div>
          <div className="text-sm text-muted-foreground">Click any land tile to found your empire</div>
        </div>
      )}

      {/* Leaderboard */}
      <div className="absolute left-3 top-3 w-56 rounded-xl border border-border/60 bg-card/85 p-2 shadow-lg backdrop-blur-md z-10">
        <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Leaderboard</div>
        <div className="space-y-0.5">
          {sortedPlayers.slice(0,10).map((p,i)=>(
            <div key={p.id} className={`flex items-center gap-2 rounded px-2 py-0.5 text-xs ${p.player_id===playerId?"bg-primary/15":""}`}>
              <span className="w-4 text-right text-muted-foreground font-mono">{i+1}</span>
              <span className="h-2 w-2 rounded-sm flex-shrink-0" style={{backgroundColor:p.color}}/>
              <span className="flex-1 truncate font-medium">{p.name}</span>
              <span className="font-mono text-muted-foreground text-[10px]">{p.pixels}t</span>
            </div>
          ))}
        </div>
      </div>

      <Button onClick={onLeave} variant="secondary" size="sm"
        className="absolute right-3 top-3 gap-1.5 bg-card/85 backdrop-blur-md z-10">
        <LogOut className="h-3.5 w-3.5"/> Leave
      </Button>

      {/* Bottom HUD */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-10">

        {/* Building toolbar */}
        <div className="flex gap-1 rounded-lg border border-border/60 bg-card/90 px-2 py-1.5 backdrop-blur-md shadow-lg">
          {TOOLBAR_BUILDINGS.map((btype,idx)=>{
            const [cc,cu]=myIdx!==undefined?getBuildCost(btype,myIdx):[BUILD_COST[btype][0],BUILD_COST[btype][1]];
            const count=myIdx!==undefined?buildingsRef.current.filter(b=>b.ownerIdx===myIdx&&b.type===btype).length:0;
            const canAfford=me&&(me.coins||0)>=cc&&me.units>=cu;
            const isActive=placeMode?.type===btype;
            return (
              <button key={btype}
                title={`${BUILDING_LABELS[btype]} — ${cc}💰${cu>0?` ${cu}⚔`:""} (right-click to cancel)`}
                disabled={!canAfford}
                onClick={()=>{
                  if(isActive){setPlaceMode(null);placeModeRef.current=null;return;}
                  setPlaceMode({type:btype}); placeModeRef.current={type:btype};
                  setBombMode(null); bombModeRef.current=null;
                }}
                className={`flex flex-col items-center justify-center w-14 h-14 rounded border transition-all relative
                  ${isActive?"border-yellow-400 bg-yellow-400/20":"border-border/60 bg-background/60 hover:bg-secondary/80"}
                  disabled:opacity-35 disabled:cursor-not-allowed`}
              >
                <span className="absolute top-0.5 left-1 text-[9px] text-muted-foreground font-mono">{idx+1}</span>
                <span className="text-lg">{BUILDING_ICONS[btype]}</span>
                <span className="text-[9px] font-mono text-muted-foreground">{count} · {cc}💰</span>
              </button>
            );
          })}

          {/* Bomb buttons (only if silo owned) */}
          {hasSilo&&(["atom","hydrogen","dirty"] as BombType[]).map(bt=>{
            const cost=BOMB_COST[bt];
            const canAfford=me&&(me.coins||0)>=cost;
            const isActive=bombMode===bt;
            const icons:Record<BombType,string>={atom:"☢",hydrogen:"💥",dirty:"☣"};
            return (
              <button key={bt}
                title={`${bt} bomb — ${cost}💰`}
                disabled={!canAfford}
                onClick={()=>{
                  if(isActive){setBombMode(null);bombModeRef.current=null;return;}
                  setBombMode(bt); bombModeRef.current=bt;
                  setPlaceMode(null); placeModeRef.current=null;
                }}
                className={`flex flex-col items-center justify-center w-14 h-14 rounded border transition-all relative
                  ${isActive?"border-red-400 bg-red-400/20":"border-red-800/60 bg-background/60 hover:bg-red-900/30"}
                  disabled:opacity-35 disabled:cursor-not-allowed`}
              >
                <span className="text-lg">{icons[bt]}</span>
                <span className="text-[9px] font-mono text-red-400">{cost}💰</span>
              </button>
            );
          })}
        </div>

        {/* Control bar */}
        <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/90 px-4 py-2 backdrop-blur-md shadow-lg">
          {me&&(
            <div className="flex items-center gap-2 text-xs">
              <span className="h-3 w-3 rounded-sm flex-shrink-0" style={{backgroundColor:me.color}}/>
              <div className="flex flex-col">
                <span className="font-bold text-foreground leading-none">{me.name}</span>
                <span className="font-mono text-muted-foreground text-[10px]">
                  ⚔{me.units>=1000?`${(me.units/1000).toFixed(1)}K`:me.units}
                  · 💰{(me.coins||0)>=1000?`${((me.coins||0)/1000).toFixed(1)}K`:(me.coins||0)}
                  · {me.pixels}t
                </span>
              </div>
            </div>
          )}
          <div className="h-8 w-px bg-border"/>
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Attack</span>
            <div className="flex items-center gap-1.5">
              <input type="range" min={5} max={100} step={5} value={sendPct}
                onChange={e=>setSendPct(+e.target.value)}
                className="w-24 accent-primary"/>
              <span className="w-10 text-right font-mono text-xs font-bold text-primary">{sendPct}%</span>
            </div>
            <span className="text-[10px] font-mono text-muted-foreground">{sendingUnits}⚔</span>
          </div>
          <div className="h-8 w-px bg-border"/>
          <div className="flex gap-1">
            {[
              {title:"Zoom in",label:"+",fn:()=>{const c=camRef.current;c.zoom=Math.min(10,c.zoom*1.25);}},
              {title:"Zoom out",label:"−",fn:()=>{const c=camRef.current;c.zoom=Math.max(0.3,c.zoom*0.8);}},
              {title:"Reset",label:"⌂",fn:()=>{camRef.current={x:0,y:0,zoom:1};}},
            ].map(b=>(
              <button key={b.title} title={b.title} onClick={b.fn}
                className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-sm hover:bg-secondary">
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Radial right-click menu ─────────────────────────────────────── */}
      {radialMenu&&(()=>{
        const cx=radialMenu.screenX, cy=radialMenu.screenY;
        const me2=playersRef.current.get(playerId);
        const myIdx2=playerIndexRef.current.get(playerId);
        const sending2=me2?Math.max(1,Math.floor(me2.units*sendPctRef.current/100)):0;
        // Sectors: top=Build, right=Attack, bottom=Bomb, left=Ally
        type Sector={label:string;icon:string;angle:number;action:()=>void;disabled?:boolean;color?:string};
        const R=72; // radius
        const sectors:Sector[]=[
          {
            label:"Build", icon:"🔨", angle:-90,
            disabled:!radialMenu.isOwnTerritory||!radialMenu.isLand,
            action:()=>{
              setRadialMenu(null);
              // Open build submenu = just show toolbar hint
              notify("Select a building from the toolbar, then click your territory","info");
            }
          },
          {
            label:"Attack", icon:"⚔️", angle:0,
            disabled:!radialMenu.isLand||radialMenu.isOwnTerritory||!me2,
            action:()=>{
              setRadialMenu(null);
              if(!me2||myIdx2===undefined) return;
              const i=radialMenu.gy*GRID_W+radialMenu.gx;
              const r=executeAttack(i,sending2,myIdx2,playerId,me2.units);
              if(r.unreachable){
                const hasPort=buildingsRef.current.some(b=>b.ownerIdx===myIdx2&&b.type==="port");
                if(hasPort) launchShip(i,sending2,myIdx2,playerId,me2.units);
                else notify("No land path — build a Port for naval attack","error");
              } else if(r.captured===0) notify("Repelled","error");
            },
            color:"#ef4444"
          },
          {
            label:"Bomb", icon:"💣", angle:90,
            disabled:!hasSilo||!me2,
            action:()=>{
              setRadialMenu(null);
              // Cycle to cheapest affordable bomb
              const affordable=(["atom","hydrogen","dirty"] as BombType[]).filter(bt=>(me2?.coins||0)>=BOMB_COST[bt]);
              if(affordable.length===0){notify("Need a Missile Silo & coins","error");return;}
              setBombMode(affordable[0]); bombModeRef.current=affordable[0];
              notify(`${affordable[0]} bomb selected — click target`,"info");
            },
            color:"#f97316"
          },
          {
            label:"Naval", icon:"🚢", angle:180,
            disabled:!radialMenu.isLand||radialMenu.isOwnTerritory||!me2||
              !buildingsRef.current.some(b=>b.ownerIdx===myIdx2&&b.type==="port"),
            action:()=>{
              setRadialMenu(null);
              if(!me2||myIdx2===undefined) return;
              const i=radialMenu.gy*GRID_W+radialMenu.gx;
              launchShip(i,sending2,myIdx2,playerId,me2.units);
            },
            color:"#06b6d4"
          },
        ];

        return (
          <div className="fixed z-50 pointer-events-none" style={{top:0,left:0,width:"100vw",height:"100vh"}}>
            {/* Backdrop to capture clicks outside */}
            <div className="absolute inset-0 pointer-events-auto" onClick={()=>setRadialMenu(null)}/>
            {/* Center dot */}
            <div className="absolute w-2 h-2 rounded-full bg-white/60 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
              style={{left:cx,top:cy}}/>
            {/* Sectors */}
            {sectors.map(sec=>{
              const rad=sec.angle*(Math.PI/180);
              const btnX=cx+Math.cos(rad)*R;
              const btnY=cy+Math.sin(rad)*R;
              return (
                <button key={sec.label}
                  disabled={sec.disabled}
                  onClick={sec.disabled?undefined:sec.action}
                  className={`absolute pointer-events-auto flex flex-col items-center justify-center
                    w-16 h-16 rounded-full border-2 backdrop-blur-md shadow-xl -translate-x-1/2 -translate-y-1/2
                    transition-all duration-150 text-center
                    ${sec.disabled
                      ? "border-border/30 bg-card/40 opacity-40 cursor-not-allowed"
                      : "border-border/80 bg-card/90 hover:scale-110 hover:bg-card cursor-pointer"
                    }`}
                  style={{left:btnX,top:btnY,borderColor:sec.disabled?undefined:sec.color}}
                >
                  <span className="text-xl leading-none">{sec.icon}</span>
                  <span className="text-[10px] font-bold mt-0.5" style={{color:sec.color??undefined}}>{sec.label}</span>
                </button>
              );
            })}
            {/* Coords label */}
            <div className="absolute text-[10px] text-muted-foreground font-mono pointer-events-none"
              style={{left:cx+4,top:cy-18}}>
              ({radialMenu.gx},{radialMenu.gy})
            </div>
          </div>
        );
      })()}
    </div>
  );
}
