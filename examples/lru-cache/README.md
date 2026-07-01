# Example — LRU cache (OpenRouter, three models)

A slightly harder task than "fix `add`": implement a fixed-capacity **LRU cache** with correct
eviction and recency. Small enough to read in a minute, real enough that the maker has to think about
ordering. Each role runs on a **different OpenRouter model**, so the reviewer is a genuinely
independent second opinion.

| Role | Model | Why |
|------|-------|-----|
| maker | `deepseek/deepseek-v4-pro` | strongest — writes the implementation |
| checker | `deepseek/deepseek-v4-flash` | fast, cheap Spec-axis check ("did it do what the task asked?") |
| reviewer | `z-ai/glm-5.2` | **different provider** → independent Standards-axis review |

> Swap the reviewer for `minimax/minimax-m3` (another provider) if you'd rather; any distinct model
> works. The only rule that matters: the **reviewer should differ from the maker** so its judgement is
> its own.

## Files here

- `seed/` — the starting target repo: a broken `LRUCache` (`src/lru.mjs`), the spec test (`test.mjs`),
  and the health gate (`health.sh`).
- `backlog.md` — the one work unit handed to the maker.
- `config.example.json` — routing + paths. Replace every `/ABS/PATH/TO/...` with a real absolute path.

## Run it

```bash
# 1. Turn the seed into a git repo (the target Chakravyuh drives)
cp -r examples/lru-cache/seed /tmp/lru-target
cd /tmp/lru-target && git init -q -b main && git add -A \
  && git -c user.email=you@x.dev -c user.name=you commit -q -m "seed: broken LRU"
bash health.sh || echo "fails until implemented — expected"
cd -

# 2. Put control files OUTSIDE the target (backlog, db, current.md, logs)
mkdir -p /tmp/loops/lru && cp examples/lru-cache/backlog.md /tmp/loops/lru/

# 3. Copy config.example.json, fill in the /ABS/PATH/TO/... values
#    (root=/tmp/lru-target, backlogPath=/tmp/loops/lru/backlog.md, piBinPath=your ../pi cli, etc.)

# 4. Give Pi an OpenRouter key and run one unit
export OPENROUTER_API_KEY=sk-or-v1-...
npm run build
node dist/cli.js /path/to/config.json --unit lru-cache
```

Exit 0 → the unit reached `approved`: the fix is committed on branch `chakravyuh/lru-cache`, waiting
for you to merge. Watch progress any time with `node dist/cli.js /path/to/config.json status`.

## Seeing the metrics & flow

Every role-run is recorded in the SQLite store. `metrics.mjs` reads it back and shows the flow plus
what each role cost — which model, tokens in/out, stop reason, verdict, and wall-clock:

```bash
node examples/lru-cache/metrics.mjs /path/to/config.json lru-cache
```

A real run of this example (three OpenRouter models, approved on the first attempt):

```
unit: lru-cache — approved

flow:  maker → health gate → (checker ∥ reviewer)   [gate runs before either verifier votes]

attempt  role      model                       tok in  tok out  stop  verdict  wall
-------  --------  --------------------------  ------  -------  ----  -------  -----
a1       maker     deepseek/deepseek-v4-pro    4924    1359     stop  —        29.5s
a1       checker   deepseek/deepseek-v4-flash  18928   2720     stop  PASS     54.8s
a1       reviewer  z-ai/glm-5.2                8269    455      stop  PASS     54.8s

totals: 3 role-runs · 32121 tok in · 4534 tok out · 36655 total
```

Read it top-to-bottom: the **maker** (`deepseek-v4-pro`) wrote the code in 29.5s, the health gate
passed, then the **checker** and **reviewer** ran **concurrently** — that's why both show ~54.8s wall
(they overlap; they don't add up) — and both voted `PASS`, so the unit was committed. A retry would
show as `a2`/`a3` rows with the blockers fed back into the next maker turn. The maker never emits a
verdict (`—`); only the two verifiers do.

