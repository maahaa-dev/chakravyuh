import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { firstMissingExtension } from "../src/extensions.js";

const thisFile = fileURLToPath(import.meta.url);

describe("firstMissingExtension", () => {
  it("returns the missing path when one path in the list does not exist", () => {
    const missing = firstMissingExtension([thisFile, "/no/such/path/for-sure.ext"]);
    expect(missing).toBe("/no/such/path/for-sure.ext");
  });

  it("returns undefined when every path exists", () => {
    const missing = firstMissingExtension([thisFile]);
    expect(missing).toBeUndefined();
  });

  it("returns undefined for an empty list", () => {
    expect(firstMissingExtension([])).toBeUndefined();
  });
});
