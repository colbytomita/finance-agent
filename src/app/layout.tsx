import type { Metadata } from "next";
import Link from "next/link";
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
  { href: "/catalysts", label: "Catalysts" },
  { href: "/events", label: "Catalyst Edge" },
  { href: "/universe", label: "Research Universe" },
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
            <Link href="/" className="text-sm font-bold tracking-tight text-zinc-100">
              Colby <span className="text-sky-400">Tomita</span>
            </Link>
            <nav className="flex gap-4 text-sm">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="text-zinc-400 hover:text-zinc-100"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <span className="ml-auto text-[11px] text-zinc-600">
              Decision support only · Not financial advice · No auto-trading
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-screen-2xl px-4 py-4">{children}</main>
      </body>
    </html>
  );
}
