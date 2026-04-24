import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import worldMap from "@/assets/map-world.jpg";

interface MenuProps {
  username: string;
  onUsernameChange: (v: string) => void;
  onCreateLobby: () => void;
  onJoinLobby: (code: string) => void;
  onSinglePlayer: () => void;
}

export function Menu({
  username,
  onUsernameChange,
  onCreateLobby,
  onJoinLobby,
  onSinglePlayer,
}: MenuProps) {
  const [code, setCode] = useState("");
  const [showJoin, setShowJoin] = useState(false);

  const canPlay = username.trim().length >= 2;

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      {/* Map background */}
      <img
        src={worldMap}
        alt=""
        className="absolute inset-0 h-full w-full object-cover opacity-40 blur-[2px]"
      />
      <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/40 to-background/80" />

      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4">
        <h1 className="mb-10 text-center text-7xl font-black tracking-tight text-primary text-glow drop-shadow-[0_4px_0_rgba(0,0,0,0.5)] md:text-8xl">
          FrontWars
        </h1>

        <div className="w-full max-w-md space-y-3 rounded-2xl border border-border/60 bg-card/80 p-6 shadow-2xl backdrop-blur-md">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Username
            </label>
            <Input
              value={username}
              onChange={(e) => onUsernameChange(e.target.value.slice(0, 16))}
              placeholder="Enter your callsign"
              className="h-12 bg-background/60 text-base"
            />
          </div>

          <Button
            onClick={onSinglePlayer}
            disabled={!canPlay}
            className="h-12 w-full text-base font-bold"
            size="lg"
          >
            Single Player
          </Button>
          <Button
            onClick={onCreateLobby}
            disabled={!canPlay}
            variant="secondary"
            className="h-12 w-full text-base font-bold"
            size="lg"
          >
            Create Lobby
          </Button>

          {!showJoin ? (
            <Button
              onClick={() => setShowJoin(true)}
              disabled={!canPlay}
              variant="secondary"
              className="h-12 w-full text-base font-bold"
              size="lg"
            >
              Join Lobby
            </Button>
          ) : (
            <div className="flex gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 8))}
                placeholder="CODE"
                className="h-12 bg-background/60 text-center font-mono text-lg tracking-widest"
              />
              <Button
                onClick={() => onJoinLobby(code)}
                disabled={code.length < 4}
                className="h-12 px-6 font-bold"
              >
                Join
              </Button>
            </div>
          )}
        </div>

        <p className="relative z-10 mt-8 text-center text-xs text-muted-foreground">
          Conquer territory · Crush rivals · Real-time multiplayer
        </p>
      </div>
    </div>
  );
}
