import { requireSessionUser } from "@/lib/auth/server";
import { EnginePulse } from "./engine-pulse";
import { NavLinks, type NavLink } from "./nav-links";

/**
 * Simplified Command Center shell.
 * Session gate is server-side; navigation stays visible only for tools the
 * signed-in user is allowed to use. Advanced tools are tucked behind a single
 * "More tools" disclosure so the main menu stays calm and scannable.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSessionUser();
  const perms = new Set(user.permissions);

  const primary: NavLink[] = [
    { href: "/dashboard", label: "Home", show: true },
    {
      href: "/approvals",
      label: "Approvals",
      show: perms.has("drafts.read"),
    },
    {
      href: "/agents",
      label: "Agents",
      show: perms.has("drafts.read") || perms.has("agents.manage") || perms.has("agents.run"),
    },
    {
      href: "/websites",
      label: "Websites",
      show: perms.has("bu.manage") || perms.has("website.manage") || perms.has("drafts.read"),
    },
    {
      href: "/operations",
      label: "Activity",
      show: perms.has("audit.read"),
    },
  ];

  const workspaceTools: NavLink[] = [
    {
      href: "/gateway",
      label: "AI",
      show: perms.has("llm.view") || perms.has("budgets.manage") || perms.has("audit.read"),
    },
    {
      href: "/knowledge",
      label: "Knowledge",
      show: perms.has("knowledge.manage") || perms.has("audit.read"),
    },
    {
      href: "/connectors",
      label: "Connections",
      show: perms.has("connectors.manage") || perms.has("audit.read"),
    },
    {
      href: "/research",
      label: "Research",
      show: perms.has("research.manage") || perms.has("audit.read"),
    },
    {
      href: "/content",
      label: "Content",
      show: perms.has("content.manage") || perms.has("audit.read"),
    },
    {
      href: "/seo",
      label: "SEO",
      show: perms.has("seo.manage") || perms.has("audit.read"),
    },
    {
      href: "/social",
      label: "Social",
      show: perms.has("social.manage") || perms.has("audit.read"),
    },
    {
      href: "/marketing",
      label: "Marketing",
      show: perms.has("marketing.manage") || perms.has("audit.read"),
    },
    {
      href: "/sales",
      label: "Sales",
      show: perms.has("sales.manage") || perms.has("audit.read"),
    },
    {
      href: "/analytics",
      label: "Analytics",
      show: perms.has("analytics.manage") || perms.has("audit.read"),
    },
  ];

  const systemTools: NavLink[] = [
    {
      href: "/supervisor",
      label: "Oversight",
      show: perms.has("supervisor.manage") || perms.has("audit.read"),
    },
    {
      href: "/audit",
      label: "History",
      show: perms.has("audit.read"),
    },
    {
      href: "/settings",
      label: "Settings",
      show: perms.has("settings.manage") || perms.has("audit.read"),
    },
  ];

  return (
    <div className="os-shell">
      <EnginePulse />
      <aside className="os-sidebar">
        <div className="os-brand">
          <span className="os-brand-dot" aria-hidden="true" />
          <div>
            <div className="os-brand-title">AgentOS</div>
            <div className="os-brand-subtitle">Your work, made simple</div>
          </div>
        </div>

        <div className="os-sidebar-scroll">
          <div className="os-nav-block">
            <div className="os-nav-label">Main</div>
            <NavLinks links={primary} label="Main menu" />
          </div>

          <details className="os-more">
            <summary>More tools</summary>
            <div className="os-more-body">
              <div className="os-nav-block">
                <div className="os-nav-label">Workspace</div>
                <NavLinks links={workspaceTools} label="Workspace tools" />
              </div>
              <div className="os-nav-block">
                <div className="os-nav-label">System</div>
                <NavLinks links={systemTools} label="System tools" />
              </div>
            </div>
          </details>
        </div>

        <div className="os-user">
          <div className="os-user-name">{user.displayName ?? "Signed-in user"}</div>
          <div className="os-user-email">{user.email}</div>
          <form action="/api/auth/logout" method="post" className="mt-3">
            <button type="submit" className="os-signout">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="os-main">{children}</main>
    </div>
  );
}
