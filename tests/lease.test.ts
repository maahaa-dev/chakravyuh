import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/sqlite-store.js";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sup-lease-"));
  return join(dir, "supervisor.db");
}

describe("SqliteStore drain lease", () => {
  it("acquires once, and a second acquire while held fails", () => {
    const store = new SqliteStore(tempDbPath());
    const now = Date.now();
    expect(store.acquireLease("holder-1", "host-1", now, 90_000)).toBe(true);
    expect(store.acquireLease("holder-2", "host-2", now, 90_000)).toBe(false);
    store.close();
  });

  it("reports the current holder/host while held", () => {
    const store = new SqliteStore(tempDbPath());
    const now = Date.now();
    store.acquireLease("holder-1", "host-1", now, 90_000);
    const lease = store.getLease();
    expect(lease?.holder).toBe("holder-1");
    expect(lease?.host).toBe("host-1");
    store.close();
  });

  it("a stale heartbeat (older than the TTL) lets a fresh acquire reclaim the lease", () => {
    const store = new SqliteStore(tempDbPath());
    const now = Date.now();
    expect(store.acquireLease("holder-1", "host-1", now, 90_000)).toBe(true);
    // simulate holder-1 having died: "now" advances well past the TTL before holder-2 tries.
    const later = now + 90_000 + 1_000;
    expect(store.acquireLease("holder-2", "host-2", later, 90_000)).toBe(true);
    expect(store.getLease()?.holder).toBe("holder-2");
    store.close();
  });

  it("release frees the lease for the next acquire", () => {
    const store = new SqliteStore(tempDbPath());
    const now = Date.now();
    expect(store.acquireLease("holder-1", "host-1", now, 90_000)).toBe(true);
    store.releaseLease("holder-1");
    expect(store.getLease()?.holder).toBeNull();
    expect(store.acquireLease("holder-2", "host-2", now, 90_000)).toBe(true);
    store.close();
  });

  it("does not release a lease held by a different holder (no accidental steal-back)", () => {
    const store = new SqliteStore(tempDbPath());
    const now = Date.now();
    store.acquireLease("holder-1", "host-1", now, 90_000);
    store.releaseLease("holder-2"); // not the current holder — no-op
    expect(store.getLease()?.holder).toBe("holder-1");
    store.close();
  });
});
