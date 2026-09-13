import Link from "next/link";
import { requireSessionUser } from "@/lib/auth/server";

/**
 * Command Center shell (Phase 1 M3): server-side session gate for every
 * dashboard page. No session → redirect to /login before any content or
 * client JS loads. Nav visibility follows the user's permissions.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSessionUser();
  const perms = new Set(user.permissions);

  const links: { href: string; label: string; show: boolean }[] = [
    { href: "/dashboard", label: "Dashboard", show: true },
    { href: "/agents", label: "Agents", show: perms.has("drafts.read") || perms.has("agents.manage") || perms.has("agents.run") },
    { href: "/operations", label: "Operations", show: perms.has("audit.read") },
    { href: "/gateway", label: "AI Gateway", show: perms.has("llm.view") || perms.has("budgets.manage") || perms.has("audit.read") },
    { href: "/knowledge", label: "Knowledge", show: perms.has("knowledge.manage") || perms.has("audit.read") },
    { href: "/connectors", label: "Connectors", show: perms.has("connectors.manage") || perms.has("audit.read") },
    { href: "/research", label: "Research", show: perms.has("research.manage") || perms.has("audit.read") },
    { href: "/content", label: "Content", show: perms.has("content.manage") || perms.has("audit.read") },
    { href: "/seo", label: "SEO", show: perms.has("seo.manage") || perms.has("audit.read") },
    { href: "/websites", label: "Websites", show: perms.has("bu.manage") || perms.has("website.manage") || perms.has("drafts.read") },
    { href: "/approvals", label: "Approvals", show: perms.has("drafts.read") },
    { href: "/audit", label: "Audit", show: perms.has("audit.read") },
    { href: "/settings", label: "Settings", show: perms.has("settings.manage") || perms.has("audit.read") },
  ];

  return (
    <div className="min-h-screen flex" style={{ background: "var(--background)" }}>
      <aside className="w-60 shrink-0 flex flex-col" style={{ background: "var(--shell)", color: "var(--shell-foreground)" }}>
        <div className="px-5 py-5">
          <div className="text-lg font-semibold">AgentOS</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>Command Center</div>
        </div>
        <nav className="flex-1 px-3 space-y-1">
          {links
            .filter((l) => l.show)
            .map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="block rounded-lg px-3 py-2 text-sm font-medium hover:bg-white/10 transition-colors"
              >
                {l.label}
              </Link>
            ))}
        </nav>
        <div className="px-5 py-4 text-xs" style={{ color: "var(--muted)", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <div className="font-medium" style={{ color: "var(--shell-foreground)" }}>
            {user.displayName ?? user.email}
          </div>
          <div>{user.email}</div>
          <div className="mt-1">{user.roles.join(", ") || "no roles"}</div>
          <form action="/api/auth/logout" method="post" className="mt-3">
            <button
              type="submit"
              className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium hover:bg-white/10 transition-colors"
              style={{ color: "var(--shell-foreground)" }}
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 min-w-0 p-6">{children}</main>
    </div>
  );
}
