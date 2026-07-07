import type { Metadata } from "next";
import Link from "next/link";
import { JobHealthBadge } from "@/components/JobHealthBadge";
import "./globals.css";

export const metadata: Metadata = {
  title: "Finance Agent",
  description:
    "Market research and swing-trading decision assistant. Decision support only — not financial advice.",
};

const NAV = [
  { href: "/", label: "Summary" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/agent-watchlist", label: "Agent Picks" },
  { href: "/sector-scout", label: "Sector Scout" },
  { href: "/performance", label: "Signal Performance" },
  { href: "/swing", label: "Swing Trading" },
  { href: "/alerts", label: "Alerts" },
  { href: "/catalysts", label: "Catalysts" },
  { href: "/events", label: "Catalyst Edge" },
  { href: "/universe", label: "Research Universe" },
  { href: "/status", label: "Status" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
          <div className="mx-auto flex max-w-screen-2xl items-center gap-6 px-4 py-2">
            <Link
              href="/"
              className="shrink-0 whitespace-nowrap text-sm font-bold tracking-tight text-zinc-100"
            >
              Colby <span className="text-sky-400">Tomita</span>
            </Link>
            {/* min-w-0 + overflow-x-auto lets the nav scroll horizontally when it's
                too wide for the row, so tabs never wrap onto a second line. */}
            <nav className="flex min-w-0 flex-1 gap-4 overflow-x-auto text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="shrink-0 whitespace-nowrap text-zinc-400 hover:text-zinc-100"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <span className="flex shrink-0 items-center gap-4">
              <JobHealthBadge />
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-screen-2xl px-4 py-4">{children}</main>
      </body>
    </html>
  );
}
