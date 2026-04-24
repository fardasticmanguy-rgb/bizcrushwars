import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { generateMap, MAP_W, MAP_H, type Territory } from "@/game/map";
import { PLAYER_COLORS, pickColor } from "@/game/colors";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";

type DBTerritory = {
  id: number;
  owner_id: string | null;
  units: number;
  color: string | null;
};
type DBPlayer = { id: string; name: string; color: string };
type DBAttack = {
  id: number;
  from_territory: number;
  to_territory: number;
  attacker_id: string;
  units: number;
  created_at: string;
};

const PLAYER_KEY = "territoria_player_id";
const PLAYER_NAME_KEY = "territoria_player_name";

function getOrCreatePlayerId() {
  let id = localStorage.getItem(PLAYER_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_KEY, id);
  }
  return id;
}

function pointInPolygon(x: number, y: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0],
      yi = poly[i][1];
    const xj = poly[j][0],
      yj = poly[j][1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function shade(hex: string, amt: number) {
  const c = hex.replace("#", "");
  const num = parseInt(c, 16);
  let r = (num >> 16) + amt;
  let g = ((num >> 8) & 0xff) + amt;
  let b = (num & 0xff) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `rgb(${r},${g},${b})`;
}

export function GameCanvas() {
  const territoriesGeom = useMemo<Territory[]>(() => generateMap(), []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [playerId] = useState(() => getOrCreatePlayerId());
  const [playerName, setPlayerName] = useState(
    () => localStorage.getItem(PLAYER_NAME_KEY) ?? "",
  );
  const [joined, setJoined] = useState(false);

  const [territoriesDb, setTerritoriesDb] = useState<Map<number, DBTerritory>>(
    new Map(),
  );
  const [players, setPlayers] = useState<Map<string, DBPlayer>>(new Map());
  const [attackLog, setAttackLog] = useState<DBAttack[]>([]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [sendPct, setSendPct] = useState(50);

  // Local refs for animation loop (avoid stale closures)
  const stateRef = useRef({ territoriesDb, players, selectedId, hoverId, playerId });
  useEffect(() => {
    stateRef.current = { territoriesDb, players, selectedId, hoverId, playerId };
  }, [territoriesDb, players, selectedId, hoverId, playerId]);

  // Initial load + realtime subscriptions
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [t, p, a] = await Promise.all([
        supabase.from("territories").select("*"),
        supabase.from("players").select("*"),
        supabase
          .from("attacks")
          .select("*")
          .order("id", { ascending: false })
          .limit(20),
      ]);
      if (cancelled) return;

      // Seed territories if empty
      if (!t.data || t.data.length === 0) {
        const rows = territoriesGeom.map((tg) => ({
          id: tg.id,
          owner_id: null as string | null,
          units: 5,
          color: null as string | null,
        }));
        await supabase.from("territories").insert(rows);
        const map = new Map<number, DBTerritory>();
        rows.forEach((r) => map.set(r.id, r));
        setTerritoriesDb(map);
      } else {
        const map = new Map<number, DBTerritory>();
        t.data.forEach((r: DBTerritory) => map.set(r.id, r));
        setTerritoriesDb(map);
      }

      const pmap = new Map<string, DBPlayer>();
      (p.data ?? []).forEach((r: DBPlayer) => pmap.set(r.id, r));
      setPlayers(pmap);

      setAttackLog((a.data ?? []) as DBAttack[]);
    }
    load();

    const ch = supabase
      .channel("game")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "territories" },
        (payload) => {
          setTerritoriesDb((prev) => {
            const m = new Map(prev);
            if (payload.eventType === "DELETE") {
              const old = payload.old as DBTerritory;
              m.delete(old.id);
            } else {
              const row = payload.new as DBTerritory;
              m.set(row.id, row);
            }
            return m;
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players" },
        (payload) => {
          setPlayers((prev) => {
            const m = new Map(prev);
            if (payload.eventType === "DELETE") {
              const old = payload.old as DBPlayer;
              m.delete(old.id);
            } else {
              const row = payload.new as DBPlayer;
              m.set(row.id, row);
            }
            return m;
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "attacks" },
        (payload) => {
          setAttackLog((prev) => [payload.new as DBAttack, ...prev].slice(0, 20));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, [territoriesGeom]);

  // Unit generation tick — only the territory owner ticks their own to reduce
  // race conditions; every player ticks just the ones they own.
  useEffect(() => {
    if (!joined) return;
    const interval = setInterval(async () => {
      const owned: { id: number; units: number; area: number }[] = [];
      stateRef.current.territoriesDb.forEach((t) => {
        if (t.owner_id === playerId) {
          const geom = territoriesGeom[t.id];
          owned.push({ id: t.id, units: t.units, area: geom.area });
        }
      });
      if (owned.length === 0) return;
      // proportional to area: ~1 unit / sec for a base hex, capped at 200
      const updates = owned.map((o) => ({
        id: o.id,
        units: Math.min(200, o.units + Math.max(1, Math.round(o.area / 2200))),
        owner_id: playerId,
      }));
      // Optimistic local update
      setTerritoriesDb((prev) => {
        const m = new Map(prev);
        updates.forEach((u) => {
          const prevT = m.get(u.id);
          if (prevT)
            m.set(u.id, { ...prevT, units: u.units, owner_id: u.owner_id });
        });
        return m;
      });
      await supabase.from("territories").upsert(
        updates.map((u) => ({
          id: u.id,
          units: u.units,
          owner_id: u.owner_id,
          color: stateRef.current.players.get(playerId)?.color ?? null,
        })),
      );
    }, 1000);
    return () => clearInterval(interval);
  }, [joined, playerId, territoriesGeom]);

  // Heartbeat
  useEffect(() => {
    if (!joined) return;
    const i = setInterval(() => {
      supabase
        .from("players")
        .update({ last_seen: new Date().toISOString() })
        .eq("id", playerId);
    }, 15000);
    return () => clearInterval(i);
  }, [joined, playerId]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    function resize() {
      const c = containerRef.current;
      if (!c || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = c.clientWidth * dpr;
      canvas.height = c.clientHeight * dpr;
      canvas.style.width = c.clientWidth + "px";
      canvas.style.height = c.clientHeight + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    function draw() {
      const c = containerRef.current;
      if (!c) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const W = c.clientWidth;
      const H = c.clientHeight;
      const scale = Math.min(W / MAP_W, H / MAP_H);
      const ox = (W - MAP_W * scale) / 2;
      const oy = (H - MAP_H * scale) / 2;

      // Background
      ctx.fillStyle = "#0a0f1a";
      ctx.fillRect(0, 0, W, H);

      // Grid backdrop
      ctx.strokeStyle = "rgba(80,180,140,0.08)";
      ctx.lineWidth = 1;
      const gs = 40;
      for (let x = 0; x < W; x += gs) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = 0; y < H; y += gs) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

      const { territoriesDb, players, selectedId, hoverId, playerId } =
        stateRef.current;

      const selectedT = selectedId !== null ? territoriesGeom[selectedId] : null;
      const adjacentSet = new Set<number>(selectedT?.neighbors ?? []);

      // Territory polygons
      for (const geom of territoriesGeom) {
        const db = territoriesDb.get(geom.id);
        const owner = db?.owner_id;
        const baseColor = db?.color ?? "#1f2937";

        ctx.beginPath();
        geom.polygon.forEach(([x, y], i) => {
          const px = ox + x * scale;
          const py = oy + y * scale;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();

        let fill: string;
        if (owner) {
          fill = baseColor;
        } else {
          fill = "#1a2332";
        }
        ctx.fillStyle = fill;
        ctx.fill();

        // Highlight selected/hover/adjacent
        if (geom.id === selectedId) {
          ctx.strokeStyle = "#fbbf24";
          ctx.lineWidth = 3;
        } else if (selectedT && adjacentSet.has(geom.id)) {
          ctx.strokeStyle =
            owner === playerId ? "rgba(251,191,36,0.6)" : "rgba(239,68,68,0.8)";
          ctx.lineWidth = 2;
        } else if (geom.id === hoverId) {
          ctx.strokeStyle = "rgba(255,255,255,0.6)";
          ctx.lineWidth = 2;
        } else {
          ctx.strokeStyle = "rgba(0,0,0,0.5)";
          ctx.lineWidth = 1;
        }
        ctx.stroke();

        // Unit count
        if (db && db.units > 0) {
          const cx = ox + geom.centroid[0] * scale;
          const cy = oy + geom.centroid[1] * scale;
          ctx.fillStyle = owner ? shade(baseColor, 80) : "#94a3b8";
          ctx.font = "bold 13px ui-monospace, monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(db.units), cx, cy);
        }
      }

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [territoriesGeom]);

  // Map click → resolve to territory id
  function getTerritoryAtEvent(e: React.MouseEvent): number | null {
    const c = containerRef.current;
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    const W = c.clientWidth;
    const H = c.clientHeight;
    const scale = Math.min(W / MAP_W, H / MAP_H);
    const ox = (W - MAP_W * scale) / 2;
    const oy = (H - MAP_H * scale) / 2;
    const mx = (e.clientX - rect.left - ox) / scale;
    const my = (e.clientY - rect.top - oy) / scale;
    for (const t of territoriesGeom) {
      if (pointInPolygon(mx, my, t.polygon)) return t.id;
    }
    return null;
  }

  async function handleClick(e: React.MouseEvent) {
    if (!joined) return;
    const id = getTerritoryAtEvent(e);
    if (id === null) {
      setSelectedId(null);
      return;
    }
    const t = territoriesDb.get(id);

    // Claim an unowned territory if player has none yet
    const myCount = Array.from(territoriesDb.values()).filter(
      (x) => x.owner_id === playerId,
    ).length;
    if (myCount === 0 && (!t || !t.owner_id)) {
      const me = players.get(playerId);
      await supabase.from("territories").upsert({
        id,
        owner_id: playerId,
        units: 20,
        color: me?.color ?? PLAYER_COLORS[0],
      });
      setSelectedId(id);
      return;
    }

    // Selecting own territory
    if (t?.owner_id === playerId) {
      setSelectedId(id);
      return;
    }

    // Attacking from selected
    if (selectedId !== null) {
      const src = territoriesDb.get(selectedId);
      if (!src || src.owner_id !== playerId) return;
      const adj = territoriesGeom[selectedId].neighbors.includes(id);
      if (!adj) return;
      const sending = Math.max(1, Math.floor((src.units * sendPct) / 100));
      if (src.units < 2) return;

      const target = territoriesDb.get(id);
      const me = players.get(playerId);
      const myColor = me?.color ?? PLAYER_COLORS[0];

      // Combat resolution
      const remainingSrc = src.units - sending;
      let newOwner = target?.owner_id ?? null;
      let newUnits = target?.units ?? 0;
      let newColor = target?.color ?? null;

      if (!target?.owner_id) {
        // Empty/neutral
        if (sending > newUnits) {
          newOwner = playerId;
          newUnits = sending - newUnits;
          newColor = myColor;
        } else {
          newUnits = newUnits - sending;
        }
      } else if (target.owner_id === playerId) {
        // Reinforce
        newUnits = newUnits + sending;
      } else {
        // Enemy combat — attacker has slight disadvantage (defender bonus)
        const defStrength = Math.floor(newUnits * 1.1);
        if (sending > defStrength) {
          newOwner = playerId;
          newUnits = sending - defStrength;
          newColor = myColor;
        } else {
          newUnits = Math.max(0, defStrength - sending);
          // keep owner
        }
      }

      // Optimistic local update
      setTerritoriesDb((prev) => {
        const m = new Map(prev);
        const cur = m.get(selectedId);
        if (cur) m.set(selectedId, { ...cur, units: remainingSrc });
        m.set(id, {
          id,
          owner_id: newOwner,
          units: newUnits,
          color: newColor,
        });
        return m;
      });

      await Promise.all([
        supabase
          .from("territories")
          .update({ units: remainingSrc })
          .eq("id", selectedId),
        supabase.from("territories").upsert({
          id,
          owner_id: newOwner,
          units: newUnits,
          color: newColor,
        }),
        supabase.from("attacks").insert({
          from_territory: selectedId,
          to_territory: id,
          attacker_id: playerId,
          units: sending,
        }),
      ]);
    }
  }

  function handleMove(e: React.MouseEvent) {
    const id = getTerritoryAtEvent(e);
    setHoverId(id);
  }

  async function joinGame() {
    const name = playerName.trim() || `Commander-${playerId.slice(0, 4)}`;
    localStorage.setItem(PLAYER_NAME_KEY, name);
    const taken = Array.from(players.values()).map((p) => p.color);
    const color = pickColor(taken);
    await supabase.from("players").upsert({
      id: playerId,
      name,
      color,
      last_seen: new Date().toISOString(),
    });
    setJoined(true);
  }

  async function resetGame() {
    if (!confirm("Reset entire game? Wipes all territories, players & attacks."))
      return;
    await supabase.from("attacks").delete().neq("id", -1);
    await supabase.from("territories").delete().neq("id", -1);
    await supabase.from("players").delete().neq("id", "");
    // Re-seed
    const rows = territoriesGeom.map((tg) => ({
      id: tg.id,
      owner_id: null,
      units: 5,
      color: null,
    }));
    await supabase.from("territories").insert(rows);
    setSelectedId(null);
    setJoined(false);
  }

  // Leaderboard derived
  const leaderboard = useMemo(() => {
    const stats = new Map<
      string,
      { player: DBPlayer; territories: number; units: number }
    >();
    players.forEach((p) =>
      stats.set(p.id, { player: p, territories: 0, units: 0 }),
    );
    territoriesDb.forEach((t) => {
      if (!t.owner_id) return;
      const s = stats.get(t.owner_id);
      if (s) {
        s.territories += 1;
        s.units += t.units;
      }
    });
    return Array.from(stats.values()).sort(
      (a, b) => b.territories - a.territories || b.units - a.units,
    );
  }, [territoriesDb, players]);

  const me = players.get(playerId);
  const selectedT = selectedId !== null ? territoriesDb.get(selectedId) : null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground scanlines">
      {/* LEFT PANEL */}
      <aside className="w-72 shrink-0 border-r border-border bg-panel/80 backdrop-blur p-4 flex flex-col gap-4 overflow-y-auto">
        <div>
          <h1 className="font-mono text-lg font-bold tracking-widest text-primary text-glow">
            ◤ TERRITORIA ◢
          </h1>
          <p className="text-xs text-muted-foreground font-mono mt-1">
            WAR ROOM // CMD CENTER
          </p>
        </div>

        {!joined ? (
          <div className="space-y-2 border border-border rounded-md p-3 bg-card">
            <label className="text-xs font-mono text-muted-foreground uppercase">
              Callsign
            </label>
            <Input
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="Enter commander name"
              className="font-mono bg-input"
              maxLength={20}
            />
            <Button
              onClick={joinGame}
              className="w-full glow-primary font-mono tracking-wider"
            >
              DEPLOY
            </Button>
          </div>
        ) : (
          <div className="border border-border rounded-md p-3 bg-card space-y-1">
            <div className="text-xs font-mono text-muted-foreground uppercase">
              Active Commander
            </div>
            <div className="flex items-center gap-2">
              <span
                className="inline-block w-3 h-3 rounded-sm"
                style={{ background: me?.color }}
              />
              <span className="font-mono font-semibold">{me?.name}</span>
            </div>
            {!Array.from(territoriesDb.values()).some(
              (t) => t.owner_id === playerId,
            ) && (
              <p className="text-[11px] text-primary font-mono mt-2 animate-pulse">
                ▶ Click any neutral territory to claim it
              </p>
            )}
          </div>
        )}

        {/* Selected info + slider */}
        {joined && selectedT && (
          <div className="border border-primary/40 rounded-md p-3 bg-card space-y-3">
            <div className="text-xs font-mono text-primary uppercase">
              Territory #{selectedT.id}
            </div>
            <div className="font-mono text-2xl text-glow">
              {selectedT.units} <span className="text-xs">units</span>
            </div>
            <div>
              <div className="flex justify-between text-xs font-mono text-muted-foreground mb-1">
                <span>SEND FORCE</span>
                <span className="text-primary">{sendPct}%</span>
              </div>
              <Slider
                value={[sendPct]}
                onValueChange={(v) => setSendPct(v[0])}
                min={10}
                max={100}
                step={10}
              />
              <div className="text-xs font-mono mt-2 text-muted-foreground">
                Will dispatch{" "}
                <span className="text-primary">
                  {Math.max(1, Math.floor((selectedT.units * sendPct) / 100))}
                </span>{" "}
                units
              </div>
            </div>
            <p className="text-[11px] font-mono text-muted-foreground">
              ▶ Click adjacent (highlighted) territory to attack
            </p>
          </div>
        )}

        {/* Leaderboard */}
        <div className="border border-border rounded-md p-3 bg-card flex-1 min-h-[180px]">
          <div className="text-xs font-mono text-muted-foreground uppercase mb-2">
            Leaderboard
          </div>
          <ul className="space-y-1.5">
            {leaderboard.length === 0 && (
              <li className="text-xs text-muted-foreground font-mono">
                No players yet
              </li>
            )}
            {leaderboard.map((s, i) => (
              <li
                key={s.player.id}
                className={`flex items-center gap-2 text-xs font-mono ${
                  s.player.id === playerId ? "text-primary" : ""
                }`}
              >
                <span className="text-muted-foreground w-4">{i + 1}.</span>
                <span
                  className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ background: s.player.color }}
                />
                <span className="truncate flex-1">{s.player.name}</span>
                <span className="text-muted-foreground">{s.territories}T</span>
                <span className="text-muted-foreground">{s.units}U</span>
              </li>
            ))}
          </ul>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={resetGame}
          className="font-mono text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
        >
          ⟲ RESET WORLD
        </Button>
      </aside>

      {/* MAP */}
      <main
        ref={containerRef}
        className="relative flex-1 cursor-crosshair"
        onClick={handleClick}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverId(null)}
      >
        <canvas ref={canvasRef} className="block" />

        {/* Top status */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-4 py-1.5 border border-border rounded-md bg-panel/90 backdrop-blur font-mono text-xs flex gap-4">
          <span className="text-muted-foreground">
            PLAYERS:{" "}
            <span className="text-primary">{players.size}</span>
          </span>
          <span className="text-muted-foreground">
            TERRITORIES:{" "}
            <span className="text-primary">{territoriesGeom.length}</span>
          </span>
          <span className="text-muted-foreground">
            STATUS: <span className="text-accent text-glow">● LIVE</span>
          </span>
        </div>

        {/* Attack feed */}
        <div className="absolute bottom-3 right-3 w-72 max-h-48 overflow-y-auto border border-border rounded-md bg-panel/90 backdrop-blur p-2 font-mono text-[11px]">
          <div className="text-muted-foreground uppercase mb-1">
            Combat Feed
          </div>
          {attackLog.length === 0 && (
            <div className="text-muted-foreground/60">No engagements yet</div>
          )}
          {attackLog.map((a) => {
            const p = players.get(a.attacker_id);
            return (
              <div key={a.id} className="flex items-center gap-1.5 py-0.5">
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ background: p?.color ?? "#666" }}
                />
                <span className="truncate">
                  {p?.name ?? "???"} sent {a.units} → #{a.to_territory}
                </span>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
