import assert from "node:assert";
import { LRUCache } from "./src/lru.mjs";

const c = new LRUCache(2);
c.put("a", 1);
c.put("b", 2);
assert.strictEqual(c.get("a"), 1, "a present");        // touches a -> a is now MRU, b is LRU
c.put("c", 3);                                          // capacity 2 -> evict b (LRU)
assert.strictEqual(c.get("b"), undefined, "b evicted");
assert.strictEqual(c.get("a"), 1, "a survived");
assert.strictEqual(c.get("c"), 3, "c present");

c.put("a", 10);                                         // update existing value + refresh recency
c.put("d", 4);                                          // evict c (now LRU)
assert.strictEqual(c.get("c"), undefined, "c evicted after update+insert");
assert.strictEqual(c.get("a"), 10, "a holds updated value");
assert.strictEqual(c.get("d"), 4, "d present");

console.log("ok");
