# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/atsuyatano-tech/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/atsuyatano-tech/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A from-scratch reimplementation of the makefun-site static site generator that produces byte-identical output to the house baseline at about one third of the CPU time. Verified: 0 output diffs against the baseline and the published expected answers on every practice case (1,135 output files) plus 24 extra generated cases, and faster in 45 of 45 paired timing runs (aggregate CPU ratio 0.32). The speed comes from a fused single-pass markdown lexer/renderer, a native-scan early exit in HTML escaping, scan-based word counting and per-build memoization — no runtime code generation, no dependencies.

## Run it

```sh
node main.ts
```

The harness driver reads cases from /input/cases.json and writes /output/answers.json (locally, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for those paths).

---

<sub>Entered on [make.fun](https://make.fun/?ref=waf1qbyg&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
