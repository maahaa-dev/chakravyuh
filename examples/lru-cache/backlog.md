## lru-cache
title: Implement a fixed-capacity LRU cache
`src/lru.mjs` has a broken `LRUCache` skeleton: `get` always returns undefined and `put` does nothing.

Implement it so `test.mjs` (run by `health.sh`) passes:

- `new LRUCache(capacity)` holds at most `capacity` entries.
- `get(key)` returns the stored value and marks that key most-recently-used; returns `undefined` if absent.
- `put(key, value)` inserts or updates a key. On insert past capacity, evict the least-recently-used key.
- Updating an existing key via `put` also refreshes its recency.

Keep it minimal and dependency-free — edit only `src/lru.mjs`.
