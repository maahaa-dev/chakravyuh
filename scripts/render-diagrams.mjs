// Regenerates the fallback SVGs in assets/diagrams/ from the Mermaid source in README.md.
//
// Why: the GitHub *mobile app* does not render ```mermaid``` blocks — it shows the raw source.
// So each diagram is embedded as an <img> of a pre-rendered SVG (visible everywhere, including the
// app), with the Mermaid kept in a <details> block as the single source of truth. This script keeps
// the SVGs in sync with that source, so they can't silently drift.
//
// README marks each diagram with `<!-- diagram: <name> -->` immediately before its <details> block;
// this renders the first Mermaid block after each marker to `assets/diagrams/<name>.svg`.
//
// Usage:  npm run diagrams
// Rendering uses mermaid-cli via `npx` — no permanent dependency is added to package.json.
// In a sandboxed/CI environment, point mermaid-cli at a Chromium via a puppeteer config:
//   PUPPETEER_CONFIG=/path/to/puppeteer.json npm run diagrams

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const outDir = join(root, "assets", "diagrams");
mkdirSync(outDir, { recursive: true });

// `<!-- diagram: name -->` ... first ```mermaid ... ``` block that follows it.
const re = /<!--\s*diagram:\s*([\w-]+)\s*-->[\s\S]*?```mermaid\n([\s\S]*?)```/g;

const extraArgs = process.env.PUPPETEER_CONFIG ? ["-p", process.env.PUPPETEER_CONFIG] : [];
let match;
let count = 0;
while ((match = re.exec(readme)) !== null) {
  const [, name, body] = match;
  const src = join(tmpdir(), `chakravyuh-diagram-${name}.mmd`);
  const svg = join(outDir, `${name}.svg`);
  writeFileSync(src, body);
  execFileSync(
    "npx",
    ["-y", "@mermaid-js/mermaid-cli", "-i", src, "-o", svg, "-b", "white", ...extraArgs],
    { stdio: "inherit" },
  );
  console.log(`rendered ${name} -> assets/diagrams/${name}.svg`);
  count += 1;
}

if (count === 0) {
  console.error("render-diagrams: no `<!-- diagram: name -->` markers found in README.md");
  process.exit(1);
}
