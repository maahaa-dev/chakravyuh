/**
 * `--all`'s cross-process drain lease: only one `chakravyuh <config> --all` may drive a given
 * store's drain at a time (two concurrent drains over the same DB would double-spend units and
 * race worktree creation). Wraps {@link SqliteStore}'s atomic `drain_lock` CAS with a heartbeat
 * (so a crashed holder's lease goes stale and is reclaimable) and a `release()` the driver calls
 * in a `finally` and from its SIGINT/SIGTERM handler.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { SqliteStore } from "./store/sqlite-store.js";

/** How long a heartbeat is trusted before the lease is considered abandoned and reclaimable. */
export const LEASE_TTL_MS = 90_000;
/** How often a held lease refreshes its heartbeat. */
export const LEASE_HEARTBEAT_MS = 30_000;

/**
 * Thrown by {@link acquireDrainLease} when another process already holds a live lease. Carries the
 * holder's `host` and the ISO timestamp of its last heartbeat for the `--all` contention message.
 */
export class DrainLeaseHeldError extends Error {
  constructor(public readonly host: string, public readonly since: string) {
    super(`drain already running (host ${host}, since ${since})`);
    this.name = "DrainLeaseHeldError";
  }
}

/**
 * A held drain lease. `release()` is idempotent (safe to call from both a `finally` and a signal
 * handler) and stops the heartbeat interval before freeing the row.
 */
export interface DrainLease {
  release(): void;
}

/**
 * Acquires the drain lease or throws {@link DrainLeaseHeldError} if another process holds a live
 * one. On success, starts a `setInterval` heartbeat (unref'd so it never keeps the process alive
 * on its own) and returns a handle whose `release()` clears that interval and frees the row.
 */
export function acquireDrainLease(
  store: SqliteStore,
  host: string = hostname(),
  ttlMs: number = LEASE_TTL_MS,
  heartbeatMs: number = LEASE_HEARTBEAT_MS,
): DrainLease {
  const holder = randomUUID();
  const now = Date.now();
  if (!store.acquireLease(holder, host, now, ttlMs)) {
    const lease = store.getLease();
    throw new DrainLeaseHeldError(
      lease.host ?? "unknown",
      lease.heartbeat ? new Date(lease.heartbeat).toISOString() : "unknown",
    );
  }

  const interval = setInterval(() => store.heartbeatLease(holder, Date.now()), heartbeatMs);
  interval.unref?.();

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      clearInterval(interval);
      store.releaseLease(holder);
    },
  };
}
