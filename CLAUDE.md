# FunPay (vidafinance) — Claude project rules

## Graphify (codebase graph)

When `graphify-out/graph.json` exists in this repo:

- For codebase questions, run `graphify query "<question>"` FIRST, before
  manual searching.
- Use `graphify path` to trace relationships between components.
- Use `graphify explain` for concept-level questions.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review —
  not for targeted questions.
- After modifying code, run `graphify update .` so the graph stays current.

If the `graphify` CLI is not installed or `graphify-out/` does not exist
yet, fall back to normal code search and say so — do not fake graph output.
