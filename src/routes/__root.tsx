import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="."
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Bizzy Crush Wars!  Spoiler Alert!!: Fun Adventures Ahead!" },
      { name: "description", content: "Get ready for the ultimate candy-coated carnage! Bizzy Crush Wars drops you straight into the sugar-fueled frontlines where matching three isn't just a puzzle—i" },
      { name: "author", content: "Lovable" },
      { property: "og:title", content: "Bizzy Crush Wars!  Spoiler Alert!!: Fun Adventures Ahead!" },
      { property: "og:description", content: "Get ready for the ultimate candy-coated carnage! Bizzy Crush Wars drops you straight into the sugar-fueled frontlines where matching three isn't just a puzzle—i" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@Lovable" },
      { name: "twitter:title", content: "Bizzy Crush Wars!  Spoiler Alert!!: Fun Adventures Ahead!" },
      { name: "twitter:description", content: "Get ready for the ultimate candy-coated carnage! Bizzy Crush Wars drops you straight into the sugar-fueled frontlines where matching three isn't just a puzzle—i" },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/c23a5925-70fd-4c89-88d3-1a91a3e3648f/id-preview-b2ce760c--9f646d4a-febe-4500-abf7-893c51bdba12.lovable.app-1777060393581.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/c23a5925-70fd-4c89-88d3-1a91a3e3648f/id-preview-b2ce760c--9f646d4a-febe-4500-abf7-893c51bdba12.lovable.app-1777060393581.png" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return <Outlet />;
}
