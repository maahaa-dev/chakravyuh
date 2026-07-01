/**
 * A fixed-capacity Least-Recently-Used cache.
 * Broken seed: get always misses and put does nothing. The maker must implement it.
 */
export class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
  }

  /** Return the value for `key` (and mark it most-recently-used), or undefined if absent. */
  get(key) {
    return undefined;
  }

  /** Insert or update `key`; when over capacity, evict the least-recently-used entry. */
  put(key, value) {
    // TODO
  }
}
