"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { List, Plus, ShieldCheck } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { BrandMark } from "./SiteHeader";
import { SiteFooter } from "./SiteFooter";

const navigation = [
  { href: "/", label: "我的行程", icon: List },
  { href: "/new", label: "新建", icon: Plus },
  { href: "/check", label: "行程体检", icon: ShieldCheck },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const tripSection = /^\/(w|t|p|r)\//.test(pathname);
  return (
    <div className="app-shell companion-shell">
      <header className="app-topbar">
        <div className="app-topbar-inner">
          <Link href="/" className="brand app-brand" aria-label="AI Travel Companion · 我的行程">
            <BrandMark />
            <span className="app-brand-name">AI Travel Companion</span>
          </Link>

          <nav className="app-nav" aria-label="产品导航">
            {navigation.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={
                  pathname === href ? "page" : href === "/" && tripSection ? "location" : undefined
                }
              >
                <Icon size={16} aria-hidden="true" /> {label}
              </Link>
            ))}
          </nav>

          <div className="app-topbar-actions">
            <ThemeToggle />
          </div>
        </div>
      </header>
      {children}
      <SiteFooter />
    </div>
  );
}
