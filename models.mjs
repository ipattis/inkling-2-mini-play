// Model + task configuration for the bake-off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const HF_HUB = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
export const HF_GGUF = process.env.HF_GGUF_DIR || path.join(os.homedir(), '.cache', 'huggingface', 'gguf');
export const LLAMA_SERVER = path.join(os.homedir(), '.local', 'llama.cpp', 'llama-b12633', 'llama-server');

export const DASHBOARD_PORT = 4100;

// The same built-in tool set for every model, so all three get the same
// Claude Code system prompt. Bash and TodoWrite are included because models
// call them by habit, and llama-server's tool-call grammar throws a 500 on a
// tool name it wasn't given.
export const TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,TodoWrite';

// File edits inside the run folder are auto-approved (acceptEdits). Bash is
// pre-approved only for these read-only commands; anything else is denied,
// because headless `claude -p` can't ask for permission.
export const ALLOWED_BASH = ['Bash(ls:*)', 'Bash(wc:*)', 'Bash(node --check:*)'];

// Tasks: prompt in tasks/<id>/task.md, optional starting files in tasks/<id>/seed/
// (copied into the run folder first), autograder in grader/specs/<id>.mjs.
const TASK_LIST = [
  { id: 'pomodoro', title: 'Pomodoro timer', level: 'easy', skill: 'UI, timers, localStorage' },
  { id: 'spreadsheet', title: 'Mini spreadsheet', level: 'hard', skill: 'formula parser, dependency graph, error handling' },
  { id: 'datatable', title: 'Data explorer', level: 'medium', skill: 'sorting, filtering, pagination, URL state' },
  { id: 'bugfix', title: 'Bug fix', level: 'medium', skill: 'reading and fixing existing code without regressions' },
  { id: 'markdown', title: 'Markdown editor', level: 'hard', skill: 'parsing, HTML safety' },
];
export const TASKS = TASK_LIST.map((t) => {
  const seed = path.join(ROOT, 'tasks', t.id, 'seed');
  return { ...t, prompt: fs.readFileSync(path.join(ROOT, 'tasks', t.id, 'task.md'), 'utf8').trim(), seed: fs.existsSync(seed) ? seed : null };
});
export const DEFAULT_TASK = TASKS[0].prompt;

// The two harnesses every model can run in.
export const HARNESSES = [
  { id: 'claude-code', name: 'Claude Code', short: 'Claude Code' },
  { id: 'neutral', name: 'Neutral agent loop', short: 'Neutral loop' },
];

// Neutral-loop settings, identical for every model.
export const NEUTRAL = { maxTurns: 60, maxTokens: 32000, effort: 'medium' };

export const MODELS = [
  {
    id: 'inkling',
    name: 'Inkling 2 Mini',
    vendor: 'Thinking Machines',
    kind: 'local',
    alias: 'inkling-2-mini',
    repo: 'ggml-org/Inkling-2-Mini-GGUF',
    file: 'Inkling-2-Mini-Q8_0.gguf',
    quant: 'Q8_0',
    params: '26B looped MoE',
    // Inkling's chat template defaults to "high", and at that level it drafts the
    // whole app inside its reasoning before writing any file. "medium" matches
    // Haiku 5.5's default effort. Options: none, minimal, low, medium, high, xhigh, max.
    reasoningEffort: 'medium',
    // Server-side defaults for every request (both harnesses). generation_config.json
    // sets temperature 1.0 only; the rest are the transformers defaults it implies
    // (top_k 50, top_p 1.0, no min_p) instead of llama.cpp's 40 / 0.95 / 0.05.
    sampling: { temp: 1.0, topK: 50, topP: 1.0, minP: 0.0 },
    llamaPort: 8081,
    sitePort: 4101,
    ctx: 131072,
  },
  {
    id: 'qwen',
    name: 'Qwen3.8 27B',
    vendor: 'Qwen',
    kind: 'local',
    alias: 'qwen3.8-27b',
    repo: 'unsloth/Qwen3.8-27B-GGUF',
    file: 'Qwen3.8-27B-Q8_0.gguf',
    quant: 'Q8_0',
    params: '27B dense',
    // The template defaults to "xhigh"; "medium" matches the other two columns.
    // Options: low, medium, xhigh.
    reasoningEffort: 'medium',
    // The GGUF's template raises on a system message after the first turn, which
    // Claude Code sends. This copy renders it in place instead (one-line change).
    chatTemplate: 'templates/qwen3.8-claude-code.jinja',
    // Model card, thinking mode: temperature 1.0, top_p 0.95, top_k 20, min_p 0, presence_penalty 0.
    sampling: { temp: 1.0, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 0.0 },
    llamaPort: 8082,
    sitePort: 4102,
    ctx: 131072,
  },
  {
    id: 'haiku',
    name: 'Claude Haiku 5.5',
    vendor: 'Anthropic API',
    kind: 'api',
    model: 'claude-haiku-5-5',
    // The neutral harness calls Bedrock directly, the provider your Claude Code uses.
    // `node harness/bedrock-probe.mjs` finds the ID that works for your account.
    bedrockModel: 'global.anthropic.claude-haiku-5-5',
    params: 'hosted',
    sitePort: 4103,
    // USD per million tokens, for the live estimate only (prompts <= 100K tokens).
    // Cache-write/read multipliers are assumed at 1.25x / 0.1x of input.
    // The final number shown is Claude Code's own total_cost_usd.
    pricing: { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
  },
];
