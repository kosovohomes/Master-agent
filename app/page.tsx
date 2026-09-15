import { redirect } from "next/navigation";

/**
 * Root entry: forward visitors straight to the Command Center. The
 * dashboard layout owns the session gate — unauthenticated users are
 * redirected server-side to /login before any content renders.
 */
export default function Home() {
  redirect("/dashboard");
}
