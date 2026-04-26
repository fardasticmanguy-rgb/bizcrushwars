import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { GRID_W, GRID_H } from "@/game/constants";
import { loadLandMask } from "@/game/landMask";
import worldMap from "@/assets/map-world.jpg";
import { Button } from "@/components/ui/button";
import { LogOut, Shield, Factory, Sword } from "lucide-react";
import { toast } from "sonner";
import type { Lobby, LobbyPlayer, Building, BuildingType, Claim, AttackResult } from "@/game/types";
import {
  DIFFICULTY_REGEN, COST_EMPTY, FACTORY_INCOME, STARTER_RADIUS, BUILD_COST, hexRgb,
} from "@/game/balance";
import { floodAttack, plantStarterCluster } from "@/game/flood";
import {
  computeMapRect, drawTerritory, drawTerritoryOutlines, drawBuildings, drawTerritoryLabels,
  type MapRect,
} from "@/game/render";

// How fast the attack flood visibly spreads (cells per second per attack)
const ATTACK_CELLS_PER_SEC = 220;
type PendingClaim = { i: number; o: number; revealAt: number };

interface GameScreenProps {
  lobby: Lobby;
  playerId: string;
  onLeave: () => void;
}

type CtxMenu = {
  screenX: number; screenY: number;
  gx: number; gy: number;
  isOwnTerritory: boolean; isLand: boolean;
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
  const pendingClaimsRef = useRef<PendingClaim[]>([]);

  // Save what each cell looked like BEFORE a pending claim, so we can revert
  // the live grid until the wave reveals it. Indexed by grid position.
  const preClaimOwnerRef = useRef<Map<number, number>>(new Map());

  const camRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef = useRef({ active: false, startX: 0, startY: 0, camX: 0, camY: 0 });
  const dragMovedRef = useRef(false);
  const mapRectRef = useRef<MapRect>({ x: 0, y: 0, w: 0, h: 0 });

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

  // Defender strength helper used by flood
  const defenderStrength = useCallback((defIdx: number) => {
    const entry = [...playerIndexRef.current.entries()].find(([, v]) => v === defIdx);
    const p = entry ? playersRef.current.get(entry[0]) : null;
    return p ? Math.max(1, Math.sqrt(p.units) / 5) : 1;
  }, []);

  /**
   * Stage a list of claims to reveal over time so the flood is visible as a
   * spreading wave (OpenFront style). Claims are expected in BFS order.
   */
  const scheduleClaimAnimation = useCallback((claims: Claim[]) => {
    if (claims.length === 0) return;
    const grid = ownerGridRef.current;
    const now = performance.now();
    const stepMs = 1000 / ATTACK_CELLS_PER_SEC;
    for (let k = 0; k < claims.length; k++) {
      const c = claims[k];
      // Remember pre-claim owner so we can show the OLD value until reveal
      if (!preClaimOwnerRef.current.has(c.i)) {
        preClaimOwnerRef.current.set(c.i, grid[c.i]);
      }
      // Revert grid to pre-claim value (so the cell isn't visible yet)
      grid[c.i] = preClaimOwnerRef.current.get(c.i)!;
      pendingClaimsRef.current.push({ i: c.i, o: c.o, revealAt: now + k * stepMs });
    }
  }, []);

  // Broadcast helper
  const broadcastClaims = useCallback((claims: Claim[]) => {
    if (claims.length > 0)
      channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });
  }, []);

  // Subscribe + initial load
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
        const claims = payload as Claim[];
        // Animate remote claims too — stage them with delay so the wave is visible
        scheduleClaimAnimation(claims);
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

  // Run an attack and persist unit cost
  const runAttack = useCallback((targetIdx: number, sendUnits: number, ownerIdx: number, ownerPid: string, currentUnits: number): AttackResult => {
    const mask = landMaskRef.current;
    if (!mask) return { spent: 0, captured: 0, repelled: false };

    // Attacker pixel count for size discount
    const grid = ownerGridRef.current;
    let attackerSize = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] === ownerIdx) attackerSize++;

    const res = floodAttack({
      ownerGrid: grid,
      landMask: mask,
      buildings: buildingsRef.current,
      ownerIdx, targetIdx, sendUnits,
      defenderStrength, attackerSize,
    });

    broadcastClaims(res.claims);

    const newUnits = Math.max(0, currentUnits - res.spent);
    const playerObj = playersRef.current.get(ownerPid);
    if (playerObj) playerObj.units = newUnits;
    if (res.spent > 0) {
      supabase.from("lobby_players").update({ units: newUnits })
        .eq("lobby_id", lobby.id).eq("player_id", ownerPid);
    }

    return {
      spent: res.spent, captured: res.claims.length,
      repelled: res.claims.length === 0,
      reachedTarget: res.reachedTarget, unreachable: res.unreachable,
    };
  }, [broadcastClaims, defenderStrength, lobby.id]);

  // Plant starter
  const plantStarter = useCallback((centerIdx: number, ownerIdx: number) => {
    const mask = landMaskRef.current;
    if (!mask) return;
    const claims = plantStarterCluster({
      ownerGrid: ownerGridRef.current, landMask: mask,
      centerIdx, ownerIdx, radius: STARTER_RADIUS,
    });
    broadcastClaims(claims);
  }, [broadcastClaims]);

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
      mapRectRef.current = computeMapRect(canvas!.width, canvas!.height);
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

    function render() {
      const w = canvas!.width, h = canvas!.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0a1628";
      ctx.fillRect(0, 0, w, h);

      const mr = computeMapRect(w, h);
      mapRectRef.current = mr;

      const cam = camRef.current;
      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.zoom, cam.zoom);

      if (bgImg.complete) ctx.drawImage(bgImg, mr.x, mr.y, mr.w, mr.h);
      else { ctx.fillStyle = "#1a3050"; ctx.fillRect(mr.x, mr.y, mr.w, mr.h); }

      const grid = ownerGridRef.current;

      // Apply any pending claims whose reveal time has come (animated flood)
      if (pendingClaimsRef.current.length > 0) {
        const now2 = performance.now();
        const stillPending: PendingClaim[] = [];
        for (const c of pendingClaimsRef.current) {
          if (c.revealAt <= now2) grid[c.i] = c.o;
          else stillPending.push(c);
        }
        pendingClaimsRef.current = stillPending;
      }

      drawTerritory(ctx, off, offCtx, imgData, grid, colorsRef.current, mr);
      drawTerritoryOutlines(ctx, grid, mr, cam.zoom);
      drawBuildings(ctx, buildingsRef.current, mr, playerIndexRef.current, playersRef.current);
      drawTerritoryLabels(ctx, grid, mr, cam.zoom, playerIndexRef.current, playersRef.current, colorsRef.current.length);

      ctx.restore();
    }

    function loop(now: number) {
      render();

      if (now - lastSyncRef.current > 1500) { lastSyncRef.current = now; syncStats(); }

      // Bots
      if (lobby.host_id === playerId && now - lastBotMoveRef.current > 2200) {
        lastBotMoveRef.current = now;
        const mask = landMaskRef.current;
        if (mask) {
          const grid = ownerGridRef.current;
          playersRef.current.forEach((bot) => {
            if (!bot.is_bot || !bot.alive) return;
            const idx = playerIndexRef.current.get(bot.player_id);
            if (idx === undefined) return;

            const owned: number[] = [];
            for (let i = 0; i < grid.length; i++) if (grid[i] === idx) owned.push(i);

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

            const frontierTargets: number[] = [];
            for (const i of owned) {
              const x = i % GRID_W, y = (i / GRID_W) | 0;
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
            runAttack(target, sendUnits, idx, bot.player_id, bot.units);
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
  }, [lobby.id, lobby.host_id, lobby.difficulty, playerId, plantStarter, runAttack]);

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
    if (!mask[i]) { showNotif("Click a land cell"); return; }

    let hasAny = false;
    for (let k = 0; k < grid.length; k++) if (grid[k] === myIdx) { hasAny = true; break; }

    if (!hasAny) {
      if (grid[i] !== -1) { showNotif("Pick an unclaimed land cell to start"); return; }
      plantStarter(i, myIdx);
      setHasSpawned(true);
      showNotif("Empire founded! Click anywhere to flood your front toward it.", "success");
      return;
    }

    if (grid[i] === myIdx) { showNotif("You already own that cell"); return; }
    const sending = Math.max(1, Math.floor(me.units * sendPctRef.current / 100));
    if (sending < COST_EMPTY) { showNotif("Not enough units", "error"); return; }

    const result = runAttack(i, sending, myIdx, playerId, me.units);
    if (result.unreachable) { showNotif("No land path to that point", "error"); return; }
    if (result.captured === 0) { showNotif("Attack repelled — defenders too strong", "error"); return; }
    if (!result.reachedTarget) showNotif(`Front advanced ${result.captured} cells — stalled before target`, "info");
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
    if (ownerGridRef.current[gridIdx] !== myIdx) { showNotif("Build on your own cells only", "error"); return; }
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

      {me && myCubeCount === 0 && !hasSpawned && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 rounded-xl border border-primary/60 bg-card/95 px-6 py-4 text-center shadow-2xl backdrop-blur-md">
          <div className="text-lg font-bold text-foreground mb-1">Pick your starting cell</div>
          <div className="text-sm text-muted-foreground">Click any land cell on the map to found your empire</div>
        </div>
      )}

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
            <Sword className="h-3 w-3" /> click any cell · right-click to build
          </div>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="flex gap-1">
          <button title="Zoom in" onClick={() => { const c = camRef.current; c.zoom = Math.min(8, c.zoom * 1.25); }}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-sm hover:bg-secondary">+</button>
          <button title="Zoom out" onClick={() => { const c = camRef.current; c.zoom = Math.max(0.4, c.zoom * 0.8); }}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-sm hover:bg-secondary">−</button>
          <button title="Reset view" onClick={() => { camRef.current = { x: 0, y: 0, zoom: 1 }; }}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/60 text-xs hover:bg-secondary">⌂</button>
        </div>
        {me && (
          <>
            <div className="h-10 w-px bg-border" />
            <div className="flex items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: me.color }} />
              <span className="font-medium">{me.name}</span>
              <span className="font-mono text-muted-foreground">{me.units}u · {me.pixels} cells</span>
            </div>
          </>
        )}
      </div>

      {ctxMenu && (
        <div className="fixed z-50 min-w-[200px] overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
          style={{ top: ctxMenu.screenY, left: ctxMenu.screenX }}>
          <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
            Cell ({ctxMenu.gx}, {ctxMenu.gy})
          </div>

          {ctxMenu.isLand && !ctxMenu.isOwnTerritory && (
            <button onClick={() => {
              setCtxMenu(null);
              const meNow = playersRef.current.get(playerId);
              const myIdxNow = playerIndexRef.current.get(playerId);
              if (!meNow || myIdxNow === undefined) return;
              const sending = Math.max(1, Math.floor(meNow.units * sendPctRef.current / 100));
              const i = ctxMenu.gy * GRID_W + ctxMenu.gx;
              const r = runAttack(i, sending, myIdxNow, playerId, meNow.units);
              if (r.unreachable) showNotif("No land path to that cell", "error");
              else if (r.captured === 0) showNotif("Attack repelled", "error");
            }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-secondary">
              <Sword className="h-4 w-4 text-red-500" /> Attack ({sendingUnits}u)
            </button>
          )}

          {ctxMenu.isOwnTerritory && (
            <>
              <button onClick={() => doBuild(ctxMenu.gx, ctxMenu.gy, "fort")}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-secondary">
                <Shield className="h-4 w-4 text-blue-400" />
                Build Fort <span className="ml-auto text-xs text-muted-foreground">{BUILD_COST.fort}u</span>
              </button>
              <button onClick={() => doBuild(ctxMenu.gx, ctxMenu.gy, "factory")}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-secondary">
                <Factory className="h-4 w-4 text-amber-400" />
                Build Factory <span className="ml-auto text-xs text-muted-foreground">{BUILD_COST.factory}u</span>
              </button>
            </>
          )}

          <button onClick={() => setCtxMenu(null)}
            className="w-full border-t border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
