import { useEffect, useRef, useState } from "react";
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

// Convert hex to {r,g,b}
function hexRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [
    parseInt(c.slice(0, 2), 16),
    parseInt(c.slice(2, 4), 16),
    parseInt(c.slice(4, 6), 16),
  ];
}

const DIFFICULTY_SPEED: Record<string, number> = {
  relaxed: 0.6,
  balanced: 1.0,
  intense: 1.6,
};

export function GameScreen({ lobby, playerId, onLeave }: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [tick, setTick] = useState(0);

  // Game state refs (mutated in render loop, never trigger re-renders)
  const ownerGridRef = useRef<Int16Array>(new Int16Array(GRID_W * GRID_H).fill(-1));
  const landMaskRef = useRef<Uint8Array | null>(null);
  const playersRef = useRef<Map<string, LobbyPlayer>>(new Map());
  const playerIndexRef = useRef<Map<string, number>>(new Map()); // player_id -> grid index 0..N
  const colorsRef = useRef<[number, number, number][]>([]);
  const lastTickRef = useRef<number>(performance.now());
  const lastSyncRef = useRef<number>(0);
  const lastBotMoveRef = useRef<number>(0);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Camera/view
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });

  // Subscribe to lobby_players (positions, units)
  useEffect(() => {
    let active = true;
    async function load() {
      const { data } = await supabase
        .from("lobby_players")
        .select("*")
        .eq("lobby_id", lobby.id);
      if (!active || !data) return;
      setPlayers(data);
      const map = new Map<string, LobbyPlayer>();
      data.forEach((p) => map.set(p.player_id, p));
      playersRef.current = map;
      // Assign grid index for each player
      const idx = new Map<string, number>();
      const cols: [number, number, number][] = [];
      data.forEach((p, i) => {
        idx.set(p.player_id, i);
        cols.push(hexRgb(p.color));
      });
      playerIndexRef.current = idx;
      colorsRef.current = cols;
    }
    load();

    const ch = supabase
      .channel(`game-${lobby.id}`, { config: { broadcast: { self: false } } })
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobby.id}` },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const p = payload.new as LobbyPlayer;
          playersRef.current.set(p.player_id, p);
          setPlayers((prev) => {
            const i = prev.findIndex((x) => x.player_id === p.player_id);
            if (i === -1) return [...prev, p];
            const next = [...prev];
            next[i] = p;
            return next;
          });
        },
      )
      .on("broadcast", { event: "claim" }, ({ payload }) => {
        // Remote pixel claim from another player — apply locally
        const claims = payload as { i: number; o: number }[];
        const grid = ownerGridRef.current;
        for (const c of claims) grid[c.i] = c.o;
      })
      .subscribe();
    channelRef.current = ch;

    return () => {
      active = false;
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [lobby.id]);

  // Load land mask
  useEffect(() => {
    loadLandMask().then((m) => {
      landMaskRef.current = m;
    });
  }, []);

  // Place starting dot for THIS player on a land tile
  useEffect(() => {
    let cancelled = false;
    async function placeStart() {
      const me = playersRef.current.get(playerId);
      if (!me || me.is_bot) return;
      // Already placed (units changed from default? we just check for an existing claimed pixel)
      const mask = landMaskRef.current;
      if (!mask) return;
      // Wait until we have a land mask AND we know which player_id we are
      // Try to claim center pixel only once: if we already own any pixels skip
      const grid = ownerGridRef.current;
      const myIdx = playerIndexRef.current.get(playerId);
      if (myIdx === undefined) return;
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] === myIdx) return;
      }
      // Find a land cell near map center for this map_id
      const map = MAPS.find((m) => m.id === lobby.map_id) ?? MAPS[0];
      const cx = Math.floor(map.center[0] * GRID_W);
      const cy = Math.floor(map.center[1] * GRID_H);
      // spiral out
      let chosen = -1;
      for (let r = 0; r < 60 && chosen === -1; r++) {
        for (let dy = -r; dy <= r && chosen === -1; dy++) {
          for (let dx = -r; dx <= r && chosen === -1; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            const x = cx + dx + Math.floor(Math.random() * 8 - 4);
            const y = cy + dy + Math.floor(Math.random() * 8 - 4);
            if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
            const i = y * GRID_W + x;
            if (mask[i] && grid[i] === -1) chosen = i;
          }
        }
      }
      if (chosen === -1) return;
      const sx = chosen % GRID_W;
      const sy = Math.floor(chosen / GRID_W);
      // Claim a small starting blob
      const claims: { i: number; o: number }[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = sx + dx;
          const y = sy + dy;
          if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
          const i = y * GRID_W + x;
          if (mask[i] && grid[i] === -1) {
            grid[i] = myIdx;
            claims.push({ i, o: myIdx });
          }
        }
      }
      // Update DB position
      if (cancelled) return;
      await supabase
        .from("lobby_players")
        .update({ dot_x: sx / GRID_W, dot_y: sy / GRID_H })
        .eq("lobby_id", lobby.id)
        .eq("player_id", playerId);
      channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });
    }
    // Retry placement until ready
    const t = setInterval(() => {
      if (cancelled) return;
      placeStart();
    }, 300);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [lobby.id, lobby.map_id, playerId]);

  // Place bots (host only)
  useEffect(() => {
    if (lobby.host_id !== playerId) return;
    let cancelled = false;
    const t = setInterval(async () => {
      if (cancelled) return;
      const mask = landMaskRef.current;
      if (!mask) return;
      const grid = ownerGridRef.current;
      const claims: { i: number; o: number }[] = [];
      const updates: { player_id: string; dot_x: number; dot_y: number }[] = [];
      playersRef.current.forEach((bot) => {
        if (!bot.is_bot) return;
        const myIdx = playerIndexRef.current.get(bot.player_id);
        if (myIdx === undefined) return;
        // Already placed?
        for (let i = 0; i < grid.length; i++) {
          if (grid[i] === myIdx) return;
        }
        // Pick random land cell
        for (let attempt = 0; attempt < 200; attempt++) {
          const x = Math.floor(Math.random() * GRID_W);
          const y = Math.floor(Math.random() * GRID_H);
          const i = y * GRID_W + x;
          if (mask[i] && grid[i] === -1) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx;
                const yy = y + dy;
                if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H) continue;
                const ii = yy * GRID_W + xx;
                if (mask[ii] && grid[ii] === -1) {
                  grid[ii] = myIdx;
                  claims.push({ i: ii, o: myIdx });
                }
              }
            }
            updates.push({ player_id: bot.player_id, dot_x: x / GRID_W, dot_y: y / GRID_H });
            break;
          }
        }
      });
      if (claims.length > 0) {
        channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });
      }
      for (const u of updates) {
        await supabase
          .from("lobby_players")
          .update({ dot_x: u.dot_x, dot_y: u.dot_y })
          .eq("lobby_id", lobby.id)
          .eq("player_id", u.player_id);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [lobby.id, lobby.host_id, playerId]);

  // Render + simulation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    // Offscreen low-res canvas for the territory overlay
    const off = document.createElement("canvas");
    off.width = GRID_W;
    off.height = GRID_H;
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

      // Per-player expansion budget (proportional to units)
      const claims: { i: number; o: number }[] = [];
      playersRef.current.forEach((p) => {
        if (!p.alive) return;
        const myIdx = playerIndexRef.current.get(p.player_id);
        if (myIdx === undefined) return;
        // Expansion strength: based on units, dt, and difficulty
        const strength = Math.min(60, (p.units / 30) * speed * (dt / 1000) * 25);
        const attempts = Math.floor(strength) + (Math.random() < strength % 1 ? 1 : 0);
        if (attempts <= 0) return;

        const dotX = Math.floor(p.dot_x * GRID_W);
        const dotY = Math.floor(p.dot_y * GRID_H);

        for (let a = 0; a < attempts; a++) {
          // Pick a random pixel I own, prefer those near the dot
          let sx: number, sy: number;
          if (Math.random() < 0.3) {
            sx = dotX + Math.floor((Math.random() - 0.5) * 6);
            sy = dotY + Math.floor((Math.random() - 0.5) * 6);
          } else {
            // Pick a random owned pixel by sampling
            let found = -1;
            for (let t = 0; t < 30; t++) {
              const ti = Math.floor(Math.random() * grid.length);
              if (grid[ti] === myIdx) {
                found = ti;
                break;
              }
            }
            if (found === -1) continue;
            sx = found % GRID_W;
            sy = Math.floor(found / GRID_W);
          }
          // Try to expand into a random neighbor
          const dirs = [
            [1, 0], [-1, 0], [0, 1], [0, -1],
          ];
          const d = dirs[Math.floor(Math.random() * 4)];
          const nx = sx + d[0];
          const ny = sy + d[1];
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const ni = ny * GRID_W + nx;
          if (!mask[ni]) continue;
          const cur = grid[ni];
          if (cur === myIdx) continue;
          if (cur === -1) {
            grid[ni] = myIdx;
            claims.push({ i: ni, o: myIdx });
          } else {
            // Combat: only overrun if attacker has more units than defender
            const def = playersRef.current.get(
              [...playerIndexRef.current.entries()].find(([, v]) => v === cur)?.[0] ?? "",
            );
            if (def && p.units > def.units * 0.9 && Math.random() < 0.3) {
              grid[ni] = myIdx;
              claims.push({ i: ni, o: myIdx });
            }
          }
        }
      });

      if (claims.length > 0) {
        channelRef.current?.send({ type: "broadcast", event: "claim", payload: claims });
      }
    }

    // Periodic stats sync (host only) — aggregates pixel counts and unit growth
    async function syncStats() {
      if (lobby.host_id !== playerId) return;
      const grid = ownerGridRef.current;
      const counts = new Array(colorsRef.current.length).fill(0);
      for (let i = 0; i < grid.length; i++) {
        const o = grid[i];
        if (o >= 0) counts[o]++;
      }
      const updates: Promise<unknown>[] = [];
      playersRef.current.forEach((p) => {
        const idx = playerIndexRef.current.get(p.player_id);
        if (idx === undefined) return;
        const px = counts[idx] ?? 0;
        // Unit growth proportional to territory + base
        const newUnits = Math.min(9999, p.units + Math.max(1, Math.round(px / 4)));
        const alive = px > 0 || p.units > 0;
        updates.push(
          Promise.resolve(
            supabase
              .from("lobby_players")
              .update({ pixels: px, units: newUnits, alive })
              .eq("lobby_id", lobby.id)
              .eq("player_id", p.player_id),
          ),
        );
      });
      await Promise.all(updates);
    }

    function render() {
      const w = canvas!.width;
      const h = canvas!.height;
      ctx.clearRect(0, 0, w, h);

      // Fit map to canvas while preserving aspect ratio (1920x960)
      const mapRatio = 1920 / 960;
      const canvasRatio = w / h;
      let mw: number, mh: number, mx: number, my: number;
      if (canvasRatio > mapRatio) {
        mh = h;
        mw = h * mapRatio;
        mx = (w - mw) / 2;
        my = 0;
      } else {
        mw = w;
        mh = w / mapRatio;
        mx = 0;
        my = (h - mh) / 2;
      }
      viewRef.current = { x: mx, y: my, scale: mw / GRID_W };

      // Draw background map
      if (bgImg.complete) {
        ctx.drawImage(bgImg, mx, my, mw, mh);
      } else {
        ctx.fillStyle = "#0a1628";
        ctx.fillRect(0, 0, w, h);
      }

      // Render owner grid into image data
      const grid = ownerGridRef.current;
      const colors = colorsRef.current;
      const data = imgData.data;
      for (let i = 0; i < grid.length; i++) {
        const o = grid[i];
        if (o < 0 || !colors[o]) {
          data[i * 4 + 3] = 0;
        } else {
          const c = colors[o];
          data[i * 4] = c[0];
          data[i * 4 + 1] = c[1];
          data[i * 4 + 2] = c[2];
          data[i * 4 + 3] = 170; // semi-transparent
        }
      }
      offCtx.putImageData(imgData, 0, 0);

      // Smooth-but-blocky overlay
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low";
      ctx.drawImage(off, mx, my, mw, mh);

      // Draw dots + names + units
      ctx.imageSmoothingEnabled = true;
      const t = performance.now();
      playersRef.current.forEach((p) => {
        if (!p.alive) return;
        const px = mx + p.dot_x * mw;
        const py = my + p.dot_y * mh;
        const isMe = p.player_id === playerId;

        // Pulsing ring for me
        if (isMe) {
          const pulse = 1 + Math.sin(t / 250) * 0.15;
          for (let r = 0; r < 3; r++) {
            const alpha = (1 - (((t / 600) + r / 3) % 1)) * 0.5;
            const radius = 16 + (((t / 600) + r / 3) % 1) * 30;
            ctx.beginPath();
            ctx.arc(px, py, radius * pulse, 0, Math.PI * 2);
            ctx.strokeStyle = `${p.color}${Math.floor(alpha * 255).toString(16).padStart(2, "0")}`;
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }

        // Outer glow
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.fillStyle = `${p.color}55`;
        ctx.fill();

        // Dot
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Units number above
        ctx.font = `bold ${10 * devicePixelRatio}px ui-sans-serif, system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "white";
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.lineWidth = 3;
        const label = `${p.units}`;
        ctx.strokeText(label, px, py - 12);
        ctx.fillText(label, px, py - 12);
      });
    }

    function loop(now: number) {
      const dt = now - lastTickRef.current;
      lastTickRef.current = now;
      simulate(dt);
      render();

      if (now - lastSyncRef.current > 1500) {
        lastSyncRef.current = now;
        syncStats();
      }

      // Bot dot move (host)
      if (lobby.host_id === playerId && now - lastBotMoveRef.current > 4000) {
        lastBotMoveRef.current = now;
        const mask = landMaskRef.current;
        if (mask) {
          const grid = ownerGridRef.current;
          playersRef.current.forEach(async (bot) => {
            if (!bot.is_bot || !bot.alive) return;
            const idx = playerIndexRef.current.get(bot.player_id);
            if (idx === undefined) return;
            // Move dot to random owned cell near the frontier
            const owned: number[] = [];
            for (let i = 0; i < grid.length; i++) {
              if (grid[i] === idx) owned.push(i);
            }
            if (owned.length === 0) return;
            const pick = owned[Math.floor(Math.random() * owned.length)];
            const x = (pick % GRID_W) / GRID_W;
            const y = Math.floor(pick / GRID_W) / GRID_H;
            await supabase
              .from("lobby_players")
              .update({ dot_x: x, dot_y: y })
              .eq("lobby_id", lobby.id)
              .eq("player_id", bot.player_id);
          });
        }
      }

      // Force HUD refresh occasionally
      if (Math.floor(now / 500) !== Math.floor((now - dt) / 500)) {
        setTick((t) => t + 1);
      }

      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    // Click handler — move dot to clicked location if within own territory
    function onClick(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * devicePixelRatio;
      const cy = (e.clientY - rect.top) * devicePixelRatio;
      const v = viewRef.current;
      const gx = Math.floor((cx - v.x) / v.scale);
      const gy = Math.floor((cy - v.y) / v.scale);
      if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return;
      const me = playersRef.current.get(playerId);
      if (!me) return;
      const myIdx = playerIndexRef.current.get(playerId);
      if (myIdx === undefined) return;
      const i = gy * GRID_W + gx;
      // Only allow moving onto own territory
      if (ownerGridRef.current[i] !== myIdx) return;
      const dx = gx / GRID_W;
      const dy = gy / GRID_H;
      // Optimistic local update
      me.dot_x = dx;
      me.dot_y = dy;
      supabase
        .from("lobby_players")
        .update({ dot_x: dx, dot_y: dy })
        .eq("lobby_id", lobby.id)
        .eq("player_id", playerId);
    }
    canvas.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("click", onClick);
    };
  }, [lobby.id, lobby.host_id, lobby.difficulty, playerId]);

  // Sorted leaderboard
  const sortedPlayers = [...players].sort((a, b) => b.pixels - a.pixels);

  return (
    <div ref={containerRef} className="relative h-screen w-screen overflow-hidden bg-background">
      <canvas ref={canvasRef} className="absolute inset-0 cursor-crosshair" />

      {/* Leaderboard top-right */}
      <div className="absolute right-3 top-3 w-56 rounded-xl border border-border/60 bg-card/85 p-2 shadow-lg backdrop-blur-md">
        <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Leaderboard
        </div>
        <div className="space-y-0.5">
          {sortedPlayers.slice(0, 10).map((p, i) => (
            <div
              key={p.id}
              className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${
                p.player_id === playerId ? "bg-primary/15" : ""
              }`}
            >
              <span className="w-3 text-right text-muted-foreground">{i + 1}</span>
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: p.color }}
              />
              <span className="flex-1 truncate font-medium">{p.name}</span>
              <span className="font-mono text-muted-foreground">{p.pixels}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Leave button top-left */}
      <Button
        onClick={onLeave}
        variant="secondary"
        size="sm"
        className="absolute left-3 top-3 gap-1.5 bg-card/85 backdrop-blur-md"
      >
        <LogOut className="h-3.5 w-3.5" /> Leave
      </Button>

      {/* Code label */}
      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-card/85 px-3 py-1 font-mono text-xs tracking-widest text-muted-foreground backdrop-blur-md">
        {lobby.code}
      </div>

      {/* hidden tick reference to satisfy linter */}
      <span className="hidden">{tick}</span>
    </div>
  );
}
