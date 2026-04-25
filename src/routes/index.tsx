import { createFileRoute } from "@tanstack/react-router";
import { App } from "@/components/App";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = (createFileRoute as any)("/")({
  component: () => <App />,
});

