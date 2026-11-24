# Three coding models, two harnesses, five tasks

**Inkling 2 Mini** and **Qwen3.8 27B** running locally on a MacBook Pro (llama.cpp, Q8_0), against **Claude Haiku 5.5** on Amazon Bedrock. Each model builds the same five web apps in two harnesses:

* **Claude Code**: headless `claude -p`, the real product, which was built for Claude models
* **a neutral agent loop**: a deliberately plain harness that no model was tuned for

An autograder checks every result in a headless browser.

**📊 Slide deck of the findings: https://ipattis.github.io/inkling-2-mini-play/** (built from [`docs/`](docs/))

## Headline results

One run per model × harness × task, 30 runs in total. Score is the share of autograder checks passed (94 checks across the five tasks); time is wall clock for all five tasks together.

| Model | Harness | Score | Total time | API cost |
|---|---|---|---|---|
| Claude Haiku 5.5 | Claude Code | 100% | 6m 36s | $0.070 |
| Claude Haiku 5.5 | Neutral loop | 100% | 3m 21s | $0.033 |
| Inkling 2 Mini | Claude Code | 100% | 53m 38s | $0 (local) |
| Inkling 2 Mini | Neutral loop | 100% | 1h 06m | $0 (local) |
| Qwen3.8 27B | Claude Code | 100% | 1h 33m | $0 (local) |
| Qwen3.8 27B | Neutral loop | 98.1% | 59m 25s | $0 (local) |

* **Correctness didn't separate the models.** 28 of 30 runs passed every check. The two misses are real bugs in Qwen's neutral-loop output: a formula cell that stays raw after focus and blur, and a descending sort that reverses the id tie-break.
* **Speed did.** In Claude Code, Inkling took 8.1× Haiku's total time and Qwen 14.1×. That's about 31 and 14 tok/s on an M4 Max, against roughly 285 tok/s for Haiku on Bedrock.
* **The harness effect ran the other way from what I expected.** The neutral loop cut Haiku's time to 0.51× and Qwen's to 0.64×, but Inkling's grew to 1.24×. Claude Code's overhead (a longer prompt, more turns) cost Haiku the most in relative terms; it didn't hand Haiku an advantage.
* **The grader had to be debugged too.** Real outputs exposed 5 false negatives in my autograder. Each fix shipped with a positive and a negative control, and every run was regraded.

These are single runs per cell, so treat the timing and harness differences as indicative. Local cost is API spend only; the Mac and its power aren't counted.

## What's compared

| Model | Served by | Settings |
|---|---|---|
| **Inkling 2 Mini** (Thinking Machines). 26.4B looped MoE, 3.4B active: 24 layers with the middle 12 run three times, 8 of 128 experts per token. | llama.cpp b12633, [`ggml-org/Inkling-2-Mini-GGUF`](https://hf.co/ggml-org/Inkling-2-Mini-GGUF) Q8_0 | reasoning effort medium, temperature 1.0 |
| **Qwen3.8 27B** (Qwen). 27B dense hybrid: 64 layers, Gated DeltaNet plus gated attention, 262K context. | llama.cpp b12633, [`unsloth/Qwen3.8-27B-GGUF`](https://hf.co/unsloth/Qwen3.8-27B-GGUF) Q8_0 | reasoning effort medium; temperature 1.0, top_p 0.95, top_k 20, from its model card |
| **Claude Haiku 5.5** (Anthropic). 1M context; $0.10 / $0.50 per MTok. | Amazon Bedrock (global endpoint) | effort medium |

**Hardware:** MacBook Pro (Mac16,5), Apple M4 Max (16-core CPU, 40-core GPU), 128 GB unified memory, macOS 26.7.2. The local models run one at a time, so they never share the GPU.

| | Claude Code | Neutral loop ([`harness/neutral-agent.mjs`](harness/neutral-agent.mjs)) |
|---|---|---|
| System prompt | Claude Code's own: 6.9K characters for unknown models, 9.8K for Haiku | 3 lines, identical for all |
| Tools | Bash (only `ls`, `wc`, `node --check`), Read, Write, Edit, Glob, Grep, TodoWrite | `list_files`, `read_file`, `write_file`, `edit_file`, `check_javascript` |
| Model API | Anthropic `/v1/messages` (llama-server) or Bedrock | each model's native API: OpenAI-style chat completions with native tool calls on llama-server; the Messages API on Bedrock |
| Limits | effort pinned with `--effort medium` | 60 turns, 32K output per response, effort medium |

The neutral loop emits the same `stream-json` events as Claude Code, so time, tokens and cost are measured by identical code for both harnesses.

## Tasks

Each task is a single-page app built from `index.html`, `styles.css` and `app.js`, with no frameworks, CDNs or build step. Prompts are in [`tasks/<id>/task.md`](tasks/).

| Task | Level | What it tests | Checks |
|---|---|---|---|
| **Pomodoro timer** | easy | UI, timers, localStorage, layout at 360 and 1440 px | 16 |
| **Mini spreadsheet** | hard | own formula parser (no `eval`), precedence, ranges, dependency recalculation, `#CIRC!` / `#DIV/0!` / `#REF!` / `#ERR!` | 21 |
| **Data explorer** | medium | a provided [`data.json`](tasks/datatable/seed/data.json) full of sorting traps; numeric, date and text sorting with id tie-breaks, search, pagination, totals, URL-hash state | 22 |
| **Bug fix** | medium | a [seeded expense tracker](tasks/bugfix/seed/) with 7 user-reported bugs, fixed in place without regressions | 15 |
| **Markdown editor** | hard | own Markdown parser, link-scheme allow-list, no raw-HTML injection, autosave, Copy HTML | 20 |

## Autograder

[`grader/specs/<task>.mjs`](grader/specs/) has one check per stated requirement:

* Each check drives the output in headless Chromium, with every non-local request blocked.
* The Pomodoro timer checks run on Playwright's **fake clock**, so a full 25-minute session takes milliseconds and the timing is exact.
* Checks are written to be independent: one defect fails one check.

To keep the grader honest, [`grader/selftest.mjs`](grader/selftest.mjs) grades a known-good reference app and copies of it with one deliberate defect each. Every case must fail *exactly* the checks it should. There are 43 cases, and all of them pass. Examples:

* the spreadsheet uses `eval`
* the data explorer sorts orders as text
* the untouched bug-fix seed, which must fail exactly the 7 bug checks
* the Markdown editor renders raw HTML

When a real model output exposed a false negative, the fix got a matching positive control (the model's real pattern must pass) and a negative control (the real defect must still fail). [`grader/regrade.mjs`](grader/regrade.mjs) then regraded every archived run.

## Running it

**You need:**

* an Apple Silicon Mac with enough unified memory for both models: about 57 GB of weights plus KV cache (tested on 128 GB)
* Node 20+
* [llama.cpp](https://github.com/ggml-org/llama.cpp) b12633 or later, which has Inkling 2 Mini support, with `llama-server` in `~/.local/llama.cpp/llama-b12633/` (or edit `LLAMA_SERVER` in [`models.mjs`](models.mjs))
* [Claude Code](https://code.claude.com/docs) signed in
* for Haiku in the neutral loop, AWS credentials with Bedrock access (`AWS_REGION` set). `node harness/bedrock-probe.mjs` finds a working model ID.

```bash
npm install
scripts/fetch-models.sh        # both GGUFs from Hugging Face, resumable, SHA-256 checked
npm start                      # dashboard on http://localhost:4100 (starts both llama-servers)
```

In the dashboard, pick a task (or all), a harness (or both) and a repeat count, then press **Run**.

* Each column shows a live metrics panel above the page the model is building.
* Rankings appear once all three models in a job have finished and been graded.
* **Compare results →** pools the runs into a model × harness × task matrix. It also shows the harness effect, pass rates per requirement, and a blind screenshot gallery.

Other commands:

```bash
node grader/selftest.mjs [task]                 # grader negative controls
node grader/cli.mjs <site-folder> --spec <task> # grade any folder
node grader/regrade.mjs                         # regrade every archived run
node harness/capture-request.mjs                # show what Claude Code actually sends to a model
npm run export-pages                            # rebuild docs/ (the slide deck) from results/
```

## Repo layout

| Path | What's there |
|---|---|
| [`server.mjs`](server.mjs), [`public/`](public/) | dashboard, batch runner, comparison page |
| [`models.mjs`](models.mjs) | models, tasks, harness settings |
| [`harness/`](harness/) | the neutral loop, Bedrock probe, request capture |
| [`tasks/`](tasks/) | prompts and seed files |
| [`grader/`](grader/) | specs, reference apps, self-test, regrade |
| [`results/`](results/) | every graded run: `run.json`, `grade.json`, screenshots and the app the model built (`site/`) |
| [`templates/`](templates/) | Qwen3.8's chat template, patched to accept mid-conversation system messages, next to the original |
| [`docs/`](docs/) | the GitHub Pages slide deck |
| [`scripts/`](scripts/) | weight download, dataset generator, Pages export |

## Fairness notes

* **Effort parity.** Claude Code sends `effort: high` to models it doesn't recognise and `medium` to Haiku 5.5, and llama-server honours the per-request value. So the Claude Code runs pin `--effort medium`, and `harness/capture-request.mjs` confirms it.
* **Sampling.** Each model card's recommended values are set on llama-server, so they apply in both harnesses.
* **Integration fixes the local models needed in Claude Code:**
  * Bash and TodoWrite are in the tool list, because llama.cpp's tool-call grammar returns a 500 on unknown tool names.
  * Qwen's chat template is patched.
  * Cloud-provider settings are removed from the environment, so requests go to the local server.
* **Limits.**
  * Every task is a single-page app, and these turned out to be within all three models' reach.
  * Neither harness lets a model run arbitrary code; `node --check` is the most it can run.
  * Local times are one M4 Max versus Anthropic's servers on Bedrock.

Raw model transcripts and local run logs aren't committed: they contain local paths and Claude Code's full system prompt.
