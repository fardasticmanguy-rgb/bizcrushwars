import { createFileRoute } from "@tanstack/react-router";
import { GameCanvas } from "@/components/GameCanvas";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Territoria — Multiplayer War Room" },
      {
        name: "description",
        content:
          "Real-time multiplayer territorial conquest. Claim land, build units, crush rivals.",
      },
      { property: "og:title", content: "Territoria — Multiplayer War Room" },
      {
        property: "og:description",
        content: "Real-time multiplayer territorial conquest game.",
      },
    ],
  }),
});

function Index() {
  return <GameCanvas />;
}
