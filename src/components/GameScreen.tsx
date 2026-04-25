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

type BuildingType = "fort" | "factory";
type Building = { type: BuildingType; ownerIdx: number; gridIdx: number };

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

// Costs per cube during a march
const COST_EMPTY = 1;       // claim an empty cube
const COST_ENEMY_BASE = 4;  // claim an enemy cube (multiplied by fort defense)
const FORT_DEFENSE = 3;     // enemy fort cubes cost N× more
const FACTORY_INCOME = 6;   // units per sync per factory
const STARTER_RADIUS = 2;   // starter cluster size
const BUILD_COST: Record<BuildingType, number> = { fort: 120, factory: 180 };

type CtxMenu = {
  screenX: number;
  screenY: number;
  gx: number;
  gy: number;
  isOwnTerritory: boolean;
  isLand: boolean;
} | null;

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
      const factoryBonus = new Array(colorsRef.current.length).fill(0);
      blds.forEach((b) => { if (b.type === "factory") factoryBonus[b.ownerIdx] += FACTORY_INCOME; });
      const regenMult = DIFFICULTY_REGEN[lobby.difficulty] ?? 1;

      const updates: Promise<unknown>[] = [];
      playersRef.current.forEach((p) => {
        const idx = playerIndexRef.current.get(p.player_id);
        if (idx === undefined) return;
        const px = counts[idx] ?? 0;
        // Passive regen: scales with territory (sqrt to avoid runaway)
        const passive = Math.round(Math.sqrt(px) * 2 * regenMult);
        const bonus = Math.round(factoryBonus[idx] || 0);
        const newUnits = Math.min(99999, p.units + passive + bonus);
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

      // Territory cubes — sharp pixelated render
      const grid = ownerGridRef.current;
      const colors = colorsRef.current;
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
      // Crisp cube look — disable smoothing
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, mx, my, mw, mh);
      ctx.imageSmoothingEnabled = true;

      // Cell border grid (only when zoomed in enough)
      if (cam.zoom > 1.5) {
        const cellW = mw / GRID_W;
        const cellH = mh / GRID_H;
        ctx.strokeStyle = "rgba(0,0,0,0.18)";
        ctx.lineWidth = 0.5 / cam.zoom;
        for (let i = 0; i < grid.length; i++) {
          if (grid[i] < 0) continue;
          const x = i % GRID_W, y = Math.floor(i / GRID_W);
          ctx.strokeRect(mx + x * cellW, my + y * cellH, cellW, cellH);
        }
      }

      // Buildings
      const blds = buildingsRef.current;
      blds.forEach((b) => {
        const bx = (b.gridIdx % GRID_W) / GRID_W;
        const by = Math.floor(b.gridIdx / GRID_W) / GRID_H;
        const px = mx + bx * mw + (mw / GRID_W) / 2;
        const py = my + by * mh + (mh / GRID_H) / 2;
        const ownerEntry = [...playerIndexRef.current.entries()].find(([, v]) => v === b.ownerIdx);
        const owner = ownerEntry ? playersRef.current.get(ownerEntry[0]) : null;
        drawBuildingIcon(px, py, b.type, owner?.color ?? "#fff");
      });

      ctx.restore();
    }

    function loop(now: number) {
      render();

      if (now - lastSyncRef.current > 1500) { lastSyncRef.current = now; syncStats(); }

      // Bots act periodically — simple "click random enemy/empty cube on frontier"
      if (lobby.host_id === playerId && now - lastBotMoveRef.current > 2200) {
        lastBotMoveRef.current = now;
        const mask = landMaskRef.current;
        if (mask) {
          const grid = ownerGridRef.current;
          playersRef.current.forEach((bot) => {
            if (!bot.is_bot || !bot.alive) return;
            const idx = playerIndexRef.current.get(bot.player_id);
            if (idx === undefined) return;

            // Find bot territory
            const owned: number[] = [];
            for (let i = 0; i < grid.length; i++) if (grid[i] === idx) owned.push(i);

            // If bot has nothing yet, plant starter
            if (owned.length === 0) {
              const candidates: number[] = [];
              for (let i = 0; i < mask.length; i++)
                if (mask[i] && grid[i] === -1) candidates.push(i);
              if (candidates.length === 0) return;
              const seed = candidates[Math.floor(Math.random() * candidates.length)];
              plantStarter(seed, idx);
              return;
            }
            if (bot.units < 30) return;

            // Find a frontier target: adjacent unowned/enemy cube
            const frontierTargets: number[] = [];
            for (const i of owned) {
              const x = i % GRID_W, y = Math.floor(i / GRID_W);
              for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
                const nx = x+dx, ny = y+dy;
                if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
                const ni = ny*GRID_W+nx;
                if (!mask[ni]) continue;
                if (grid[ni] !== idx) frontierTargets.push(ni);
              }
            }
            if (frontierTargets.length === 0) return;
            const target = frontierTargets[Math.floor(Math.random() * frontierTargets.length)];
            const sendUnits = Math.floor(bot.units * (0.4 + Math.random() * 0.3));
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

  // Execute an attack: BFS shortest-path march from nearest owned border to target,
  // claiming every cube along the way (cost per cube). Leftover units flood adjacent
  // empty cubes from the target outward.
  function executeAttack(targetIdx: number, sendUnits: number, ownerIdx: number, ownerPid: string, currentUnits: number) {
    const mask = landMaskRef.current;
    if (!mask) return { spent: 0, captured: 0, repelled: false };
    const grid = ownerGridRef.current;
    const blds = buildingsRef.current;

    // Owned land cubes
    const ownedSet = new Set<number>();
    for (let i = 0; i < grid.length; i++) if (grid[i] === ownerIdx) ownedSet.add(i);
    if (ownedSet.size === 0) return { spent: 0, captured: 0, repelled: false };

    // BFS from all owned cubes to target through land. Track parents for path.
    const parent = new Int32Array(grid.length).fill(-1);
    const visited = new Uint8Array(grid.length);
    const queue: number[] = [];
    ownedSet.forEach((i) => { visited[i] = 1; queue.push(i); });

    let found = false;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur === targetIdx) { found = true; break; }
      const x = cur % GRID_W, y = Math.floor(cur / GRID_W);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
        const nx = x+dx, ny = y+dy;
        if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
        const ni = ny*GRID_W+nx;
        if (visited[ni]) continue;
        if (!mask[ni]) continue; // land only
        visited[ni] = 1;
        parent[ni] = cur;
        queue.push(ni);
      }
    }

    if (!found) {
      return { spent: 0, captured: 0, repelled: false, unreachable: true };
    }

    // Walk back from target to first owned cube to build the path
    const path: number[] = [];
    let cursor = targetIdx;
    while (cursor !== -1 && !ownedSet.has(cursor)) {
      path.push(cursor);
      cursor = parent[cursor];
    }
    path.reverse(); // from near-border outward to target

    // Spend units along path
    let remaining = sendUnits;
    const claims: { i: number; o: number }[] = [];
    let captured = 0;
    let repelledAt = -1;

    for (const ni of path) {
      const cur = grid[ni];
      let cost: number;
      if (cur === -1) {
        cost = COST_EMPTY;
      } else if (cur === ownerIdx) {
        continue; // already ours (rare during multi-hop)
      } else {
        const hasFort = blds.some((b) => b.gridIdx === ni && b.type === "fort");
        // Defender unit-density bonus: enemy with more units defends harder
        const defEntry = [...playerIndexRef.current.entries()].find(([, v]) => v === cur);
        const def = defEntry ? playersRef.current.get(defEntry[0]) : null;
        const defStrength = def ? Math.max(1, Math.sqrt(def.units) / 4) : 1;
        cost = Math.ceil(COST_ENEMY_BASE * (hasFort ? FORT_DEFENSE : 1) * defStrength);
      }
      if (remaining < cost) { repelledAt = ni; break; }
      remaining -= cost;
      grid[ni] = ownerIdx;
      claims.push({ i: ni, o: ownerIdx });
      captured++;
    }

    // Flood leftover units around the target (claiming empty / cheap cubes)
    if (remaining > 0 && captured > 0) {
      const floodSeen = new Uint8Array(grid.length);
      const floodQ: number[] = [targetIdx];
      floodSeen[targetIdx] = 1;
      while (floodQ.length > 0 && remaining >= COST_EMPTY) {
        const cur = floodQ.shift()!;
        const x = cur % GRID_W, y = Math.floor(cur / GRID_W);
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
          const nx = x+dx, ny = y+dy;
          if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
          const ni = ny*GRID_W+nx;
          if (floodSeen[ni] || !mask[ni]) continue;
          floodSeen[ni] = 1;
          if (grid[ni] === ownerIdx) { floodQ.push(ni); continue; }
          if (grid[ni] === -1) {
            if (remaining < COST_EMPTY) continue;
            remaining -= COST_EMPTY;
            grid[ni] = ownerIdx;
            claims.push({ i: ni, o: ownerIdx });
            captured++;
            floodQ.push(ni);
          }
          // Don't auto-fight enemies during flood — leftover only paints empty
        }
      }
    }

    if (claims.length > 0)
      channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });

    const actuallySpent = sendUnits - remaining;
    const newUnits = Math.max(0, currentUnits - actuallySpent);
    const playerObj = playersRef.current.get(ownerPid);
    if (playerObj) playerObj.units = newUnits;
    supabase.from("lobby_players")
      .update({ units: newUnits })
      .eq("lobby_id", lobby.id).eq("player_id", ownerPid);

    return { spent: actuallySpent, captured, repelled: repelledAt !== -1 && captured === 0, unreachable: false };
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
    if (result.unreachable) { showNotif("No land path to that cube", "error"); return; }
    if (result.captured === 0) { showNotif("Attack repelled — too well defended", "error"); return; }
    if (result.repelled) showNotif(`Captured ${result.captured} cubes — march halted`, "info");
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
              <span className="font-mono text-muted-foreground">{me.units}u · {me.pixels} cubes</span>
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
