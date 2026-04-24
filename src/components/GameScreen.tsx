import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { GRID_W, GRID_H, MAPS } from "@/game/constants";
import { loadLandMask } from "@/game/landMask";
import worldMap from "@/assets/map-world.jpg";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

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
  relaxed: 0.5,
  balanced: 1.0,
  intense: 1.8,
};

// Context menu state
type CtxMenu = { screenX: number; screenY: number; gx: number; gy: number } | null;

// Find spread-out spawn points across the land mask
function findSpreadSpawns(mask: Uint8Array, count: number): number[] {
  const candidates: number[] = [];
  // Collect all land cells
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) candidates.push(i);
  }
  if (candidates.length === 0) return [];

  const chosen: number[] = [];
  const minDist = Math.floor(Math.min(GRID_W, GRID_H) * 0.15); // 15% of map

  let attempts = 0;
  while (chosen.length < count && attempts < 50000) {
    attempts++;
    const idx = candidates[Math.floor(Math.random() * candidates.length)];
    const x = idx % GRID_W;
    const y = Math.floor(idx / GRID_W);

    // Check distance from all existing spawns
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

export function GameScreen({ lobby, playerId, onLeave }: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [tick, setTick] = useState(0);
  const [sendPct, setSendPct] = useState(50);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null);
  const sendPctRef = useRef(50);

  // Keep sendPctRef in sync
  useEffect(() => { sendPctRef.current = sendPct; }, [sendPct]);

  // Game state refs
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

  // Camera: zoom + pan
  const camRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; camX: number; camY: number }>({
    active: false, startX: 0, startY: 0, camX: 0, camY: 0,
  });

  // Map render dimensions (set in render loop)
  const mapRectRef = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // Convert screen → grid coords accounting for camera
  const screenToGrid = useCallback((sx: number, sy: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const cx = (sx - rect.left) * devicePixelRatio;
    const cy = (sy - rect.top) * devicePixelRatio;
    const cam = camRef.current;
    const mr = mapRectRef.current;
    // Undo camera transform
    const wx = (cx - cam.x) / cam.zoom;
    const wy = (cy - cam.y) / cam.zoom;
    // Undo map position
    const gx = Math.floor((wx - mr.x) / (mr.w / GRID_W));
    const gy = Math.floor((wy - mr.y) / (mr.h / GRID_H));
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return null;
    return { gx, gy };
  }, []);

  // Subscribe to realtime
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
      .subscribe();
    channelRef.current = ch;
    return () => { active = false; supabase.removeChannel(ch); channelRef.current = null; };
  }, [lobby.id]);

  // Load land mask
  useEffect(() => {
    loadLandMask().then((m) => { landMaskRef.current = m; });
  }, []);

  // Spawn ALL players spread out (host does it once)
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
        // Claim 3x3 starting blob
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
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const speed = DIFFICULTY_SPEED[lobby.difficulty] ?? 1;

    function simulate(dt: number) {
      const mask = landMaskRef.current;
      if (!mask) return;
      const grid = ownerGridRef.current;
      const colors = colorsRef.current;
      if (colors.length === 0) return;

      const claims: { i: number; o: number }[] = [];
      playersRef.current.forEach((p) => {
        if (!p.alive) return;
        const myIdx = playerIndexRef.current.get(p.player_id);
        if (myIdx === undefined) return;

        const strength = Math.min(80, (p.units / 20) * speed * (dt / 1000) * 30);
        const attempts = Math.floor(strength) + (Math.random() < strength % 1 ? 1 : 0);
        if (attempts <= 0) return;

        const dotX = Math.floor(p.dot_x * GRID_W);
        const dotY = Math.floor(p.dot_y * GRID_H);

        for (let a = 0; a < attempts; a++) {
          let sx: number, sy: number;
          if (Math.random() < 0.25) {
            sx = dotX + Math.floor((Math.random() - 0.5) * 10);
            sy = dotY + Math.floor((Math.random() - 0.5) * 10);
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
          const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
          const d = dirs[Math.floor(Math.random() * dirs.length)];
          const nx = sx + d[0]; const ny = sy + d[1];
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const ni = ny * GRID_W + nx;
          if (!mask[ni]) continue;
          const cur = grid[ni];
          if (cur === myIdx) continue;
          if (cur === -1) {
            grid[ni] = myIdx;
            claims.push({ i: ni, o: myIdx });
          } else {
            // Combat: attacker needs significantly more units (harder to take)
            const defEntry = [...playerIndexRef.current.entries()].find(([, v]) => v === cur);
            const def = defEntry ? playersRef.current.get(defEntry[0]) : null;
            if (def && p.units > def.units * 1.4 && Math.random() < 0.25) {
              grid[ni] = myIdx;
              claims.push({ i: ni, o: myIdx });
            }
          }
        }
      });
      if (claims.length > 0)
        channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });
    }

    async function syncStats() {
      if (lobby.host_id !== playerId) return;
      const grid = ownerGridRef.current;
      const counts = new Array(colorsRef.current.length).fill(0);
      for (let i = 0; i < grid.length; i++) { const o = grid[i]; if (o >= 0) counts[o]++; }
      const updates: Promise<unknown>[] = [];
      playersRef.current.forEach((p) => {
        const idx = playerIndexRef.current.get(p.player_id);
        if (idx === undefined) return;
        const px = counts[idx] ?? 0;
        const newUnits = Math.min(9999, p.units + Math.max(1, Math.round(px / 3)));
        const alive = px > 0 || p.units > 0;
        updates.push(supabase.from("lobby_players")
          .update({ pixels: px, units: newUnits, alive })
          .eq("lobby_id", lobby.id).eq("player_id", p.player_id));
      });
      await Promise.all(updates);
    }

    function render() {
      const w = canvas!.width;
      const h = canvas!.height;
      ctx.clearRect(0, 0, w, h);

      // Ocean fill
      ctx.fillStyle = "#0a1628";
      ctx.fillRect(0, 0, w, h);

      // Map aspect ratio 1920x960
      const mapRatio = 1920 / 960;
      const canvasRatio = w / h;
      let mw: number, mh: number, mx: number, my: number;
      if (canvasRatio > mapRatio) { mh = h; mw = h * mapRatio; mx = (w - mw) / 2; my = 0; }
      else { mw = w; mh = w / mapRatio; mx = 0; my = (h - mh) / 2; }
      mapRectRef.current = { x: mx, y: my, w: mw, h: mh };

      // Apply camera transform
      const cam = camRef.current;
      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.zoom, cam.zoom);

      // Draw map
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

      // Draw dots
      const t = performance.now();
      playersRef.current.forEach((p) => {
        if (!p.alive) return;
        const px = mx + p.dot_x * mw;
        const py = my + p.dot_y * mh;
        const isMe = p.player_id === playerId;

        if (isMe) {
          // Animated pulsing rings
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

        // Glow
        ctx.beginPath();
        ctx.arc(px, py, 14, 0, Math.PI * 2);
        ctx.fillStyle = `${p.color}44`;
        ctx.fill();

        // Dot body
        ctx.beginPath();
        ctx.arc(px, py, isMe ? 9 : 7, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // White center
        ctx.beginPath();
        ctx.arc(px, py, isMe ? 3.5 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fill();

        // Units label
        ctx.font = `bold ${isMe ? 11 : 9}px ui-sans-serif, system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.strokeStyle = "rgba(0,0,0,0.9)";
        ctx.lineWidth = 3;
        ctx.strokeText(String(p.units), px, py - 12);
        ctx.fillStyle = "white";
        ctx.fillText(String(p.units), px, py - 12);

        // Name tag (only for me)
        if (isMe) {
          ctx.font = `bold 9px ui-sans-serif, system-ui`;
          ctx.fillStyle = "rgba(255,255,255,0.7)";
          ctx.fillText(p.name, px, py - 23);
        }
      });

      ctx.restore();
    }

    function loop(now: number) {
      const dt = Math.min(now - lastTickRef.current, 100); // cap dt
      lastTickRef.current = now;
      simulate(dt);
      render();

      if (now - lastSyncRef.current > 1500) { lastSyncRef.current = now; syncStats(); }

      // Bot AI movement (host only)
      if (lobby.host_id === playerId && now - lastBotMoveRef.current > 3500) {
        lastBotMoveRef.current = now;
        const mask = landMaskRef.current;
        if (mask) {
          const grid = ownerGridRef.current;
          playersRef.current.forEach(async (bot) => {
            if (!bot.is_bot || !bot.alive) return;
            const idx = playerIndexRef.current.get(bot.player_id);
            if (idx === undefined) return;
            // Find frontier cells (owned but adjacent to enemy/neutral)
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

    // Wheel zoom
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const canvas2 = canvasRef.current; if (!canvas2) return;
      const rect = canvas2.getBoundingClientRect();
      const mx2 = (e.clientX - rect.left) * devicePixelRatio;
      const my2 = (e.clientY - rect.top) * devicePixelRatio;
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const cam = camRef.current;
      const newZoom = Math.min(6, Math.max(0.4, cam.zoom * factor));
      // Zoom toward cursor
      cam.x = mx2 - (mx2 - cam.x) * (newZoom / cam.zoom);
      cam.y = my2 - (my2 - cam.y) * (newZoom / cam.zoom);
      cam.zoom = newZoom;
    }

    // Middle/right drag
    function onMouseDown(e: MouseEvent) {
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, camX: camRef.current.x, camY: camRef.current.y };
      }
    }
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current.active) return;
      const dx = (e.clientX - dragRef.current.startX) * devicePixelRatio;
      const dy = (e.clientY - dragRef.current.startY) * devicePixelRatio;
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

  // Left click — move dot OR close context menu
  function handleClick(e: React.MouseEvent) {
    if (ctxMenu) { setCtxMenu(null); return; }
    const coords = screenToGrid(e.clientX, e.clientY);
    if (!coords) return;
    const { gx, gy } = coords;
    const me = playersRef.current.get(playerId);
    if (!me) return;
    const myIdx = playerIndexRef.current.get(playerId);
    if (myIdx === undefined) return;
    const i = gy * GRID_W + gx;
    if (ownerGridRef.current[i] !== myIdx) return;
    // Move dot to clicked own territory
    me.dot_x = gx / GRID_W;
    me.dot_y = gy / GRID_H;
    supabase.from("lobby_players")
      .update({ dot_x: me.dot_x, dot_y: me.dot_y })
      .eq("lobby_id", lobby.id).eq("player_id", playerId);
  }

  // Right click — context menu
  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const coords = screenToGrid(e.clientX, e.clientY);
    if (!coords) return;
    setCtxMenu({ screenX: e.clientX, screenY: e.clientY, gx: coords.gx, gy: coords.gy });
  }

  // Attack action from context menu
  async function doAttack(gx: number, gy: number) {
    setCtxMenu(null);
    const me = playersRef.current.get(playerId);
    if (!me || !me.alive) return;
    const myIdx = playerIndexRef.current.get(playerId);
    if (myIdx === undefined) return;
    const i = gy * GRID_W + gx;
    const grid = ownerGridRef.current;
    const targetOwnerIdx = grid[i];

    if (targetOwnerIdx === myIdx || targetOwnerIdx === -1) return; // can't attack own/neutral via menu

    const defEntry = [...playerIndexRef.current.entries()].find(([, v]) => v === targetOwnerIdx);
    const def = defEntry ? playersRef.current.get(defEntry[0]) : null;
    if (!def) return;

    const sending = Math.max(1, Math.floor(me.units * sendPctRef.current / 100));

    // Claim a blob of pixels around target
    const mask = landMaskRef.current;
    const claims: { i: number; o: number }[] = [];
    if (mask && sending > def.units * 1.4) {
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
    }

    const newMyUnits = Math.max(1, me.units - sending);
    await supabase.from("lobby_players").update({ units: newMyUnits }).eq("lobby_id", lobby.id).eq("player_id", playerId);
  }

  const sortedPlayers = [...players].sort((a, b) => b.pixels - a.pixels);
  const me = playersRef.current.get(playerId);

  return (
    <div ref={containerRef} className="relative h-screen w-screen overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: ctxMenu ? "default" : "crosshair" }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      />

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

      {/* Force slider + zoom controls — bottom center */}
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
        <div className="flex gap-1">
          {[["＋", 1.2], ["－", 0.83], ["⌂", "reset"]].map(([label, val]) => (
            <button key={String(label)}
              onClick={() => {
                if (val === "reset") { camRef.current = { x: 0, y: 0, zoom: 1 }; }
                else { const cam = camRef.current; cam.zoom = Math.min(6, Math.max(0.4, cam.zoom * Number(val))); }
              }}
              className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-sm hover:bg-secondary">
              {label}
            </button>
          ))}
        </div>
        {me && (
          <>
            <div className="h-8 w-px bg-border" />
            <div className="flex items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: me.color }} />
              <span className="font-medium">{me.name}</span>
              <span className="font-mono text-muted-foreground">{me.units}u · {me.pixels}px</span>
            </div>
          </>
        )}
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[160px] overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
          style={{ top: ctxMenu.screenY, left: ctxMenu.screenX }}
        >
          <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
            Actions
          </div>
          {[
            { label: `⚔️ Attack (${sendPct}%)`, action: () => doAttack(ctxMenu.gx, ctxMenu.gy) },
            { label: "🏁 Move Here", action: () => {
              setCtxMenu(null);
              const me2 = playersRef.current.get(playerId);
              const myIdx2 = playerIndexRef.current.get(playerId);
              if (!me2 || myIdx2 === undefined) return;
              const i = ctxMenu.gy * GRID_W + ctxMenu.gx;
              if (ownerGridRef.current[i] !== myIdx2) return;
              me2.dot_x = ctxMenu.gx / GRID_W; me2.dot_y = ctxMenu.gy / GRID_H;
              supabase.from("lobby_players").update({ dot_x: me2.dot_x, dot_y: me2.dot_y }).eq("lobby_id", lobby.id).eq("player_id", playerId);
            }},
            { label: "❌ Cancel", action: () => setCtxMenu(null) },
          ].map(({ label, action }) => (
            <button key={label} onClick={action}
              className="flex w-full items-center px-3 py-2 text-sm hover:bg-secondary text-left transition-colors">
              {label}
            </button>
          ))}
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
