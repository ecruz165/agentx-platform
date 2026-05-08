import { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Navbar, NavbarBrand, NavbarContent, NavbarItem } from "@heroui/react";

const links = [
  { to: "/intake", label: "Intake" },
  { to: "/sessions", label: "Sessions" },
  { to: "/jobs", label: "Jobs" },
  { to: "/catalog", label: "Catalog" },
  { to: "/benchmarks", label: "Benchmarks" },
];

export default function NavShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <div className="flex flex-col min-h-screen">
      <Navbar maxWidth="full" isBordered>
        <NavbarBrand>
          <span className="font-semibold tracking-wide">agentx</span>
          <span className="ml-2 text-default-500">control plane</span>
        </NavbarBrand>
        <NavbarContent justify="end" className="gap-4">
          {links.map((l) => (
            <NavbarItem key={l.to} isActive={pathname.startsWith(l.to)}>
              <Link to={l.to} className="text-sm">
                {l.label}
              </Link>
            </NavbarItem>
          ))}
        </NavbarContent>
      </Navbar>
      <div className="flex-1 p-6 max-w-7xl mx-auto w-full">{children}</div>
    </div>
  );
}
