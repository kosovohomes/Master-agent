"use client";

import { useEffect } from "react";

/**
 * Keeps the durable task engine moving while the Command Center is open.
 * Serverless deployments have no always-on worker; a short same-origin pulse
 * lets queued chains, retries and supervisor waves progress without waiting
 * for the daily Vercel cron. Overlapping pulses are safe (SKIP LOCKED).
 */
export function EnginePulse() {
  useEffect(() => {
    const pulse = () => {
      fetch("/api/agents/engine/tick", { method: "POST", credentials: "same-origin" }).catch(() => {});
    };
    pulse();
    const id = window.setInterval(pulse, 20_000);
    return () => window.clearInterval(id);
  }, []);
  return null;
}
