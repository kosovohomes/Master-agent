"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavLink = {
  href: string;
  label: string;
  show: boolean;
};

export function NavLinks({ links, label }: { links: NavLink[]; label: string }) {
  const pathname = usePathname();

  return (
    <nav className="os-nav" aria-label={label}>
      {links
        .filter((link) => link.show)
        .map((link) => {
          const active =
            pathname === link.href ||
            (link.href !== "/dashboard" && pathname.startsWith(`${link.href}/`));

          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={`os-nav-link${active ? " os-nav-link-active" : ""}`}
            >
              {link.label}
            </Link>
          );
        })}
    </nav>
  );
}
