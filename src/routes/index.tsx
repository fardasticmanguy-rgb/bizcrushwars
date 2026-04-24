import { createFileRoute } from "@tanstack/react-router";
import { App } from "@/components/App";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "FrontWars — Real-Time Territorial Conquest" },
      {
        name: "description",
        content:
          "Multiplayer territorial flood-fill war game. Claim land, crush rivals in real time.",
      },
      { property: "og:title", content: "FrontWars — Real-Time Territorial Conquest" },
      {
        property: "og:description",
        content: "Multiplayer flood-fill territorial conquest game.",
      },
    ],
  }),
});

function Index() {
  return (
    <>
      <App />
      <Toaster />
    </>
  );
}
