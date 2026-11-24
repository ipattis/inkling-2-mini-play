// Model bake-off harness.
//  - starts one llama-server per local model (Anthropic-compatible /v1/messages
//    for Claude Code, OpenAI-style /v1/chat/completions for the neutral loop)
//  - runs each model on the same web-dev task in Claude Code (`claude -p`) and/or
//    the neutral agent loop (harness/neutral-agent.mjs), optionally repeated
//  - autogrades every run (grader/) and archives it under results/
//  - serves each model's output folder on its own localhost port
//  - derives live metrics from Claude Code's stream-json and pushes them to the dashboard over SSE
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  ROOT, HF_HUB, HF_GGUF, LLAMA_SERVER, DASHBOARD_PORT, TOOLS, ALLOWED_BASH, DEFAULT_TASK, MODELS,
  HARNESSES, NEUTRAL, TASKS,
} from './models.mjs';
import { gradeSite } from './grader/grade.mjs';

const taskById = Object.fromEntries(TASKS.map((t) => [t.id, t]));
const specs = Object.fromEntries(await Promise.all(TASKS.map(async (t) => [t.id, await import(`./grader/specs/${t.id}.mjs`)])));
const publicTask = ({ seed, ...t }) => ({ ...t, seeded: !!seed });

const RUNS = path.join(ROOT, 'runs');
const LOGS = path.join(ROOT, 'logs');
const PUBLIC = path.join(ROOT, 'public');
const RESULTS = path.join(ROOT, 'results');
const RESULT_RUNS = path.join(RESULTS, 'runs');
const RESULT_INDEX = path.join(RESULTS, 'runs.jsonl');
const RUN_TIMEOUT_MS = 45 * 60 * 1000;
fs.mkdirSync(RUNS, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(RESULT_RUNS, { recursive: true });
const harnessById = Object.fromEntries(HARNESSES.map((h) => [h.id, h]));

const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));
const siteDir = (id) => path.join(RUNS, id, 'site');

// ---------------------------------------------------------------- state
const servers = {};   // local model server status, keyed by model id
const runs = {};      // per-model run state + event log
const children = new Set();
let currentTask = DEFAULT_TASK;
let currentTasks = [TASKS[0].id];
let currentMode = 'sequential';
let batch = null;     // the current queue of jobs (harness × repeat)

function freshRun(id, meta = {}) {
  return {
    id,
    task: 'pomodoro',        // which task (tasks/<id>/)
    harness: 'claude-code',  // which harness this run uses
    repeat: 1,
    batchId: null,
    runId: null,             // results/runs/<runId>/
    grade: null,             // autograder summary once graded
    grading: false,
    ...meta,
    status: 'idle',          // idle | queued | waiting | running | done | error | stopped
    detail: '',
    startedAt: null,
    firstTokenAt: null,
    endedAt: null,
    durationMs: null,        // Claude Code's own duration_ms when available
    turns: 0,
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    genMs: 0,                // time spent streaming output, for tok/s
    costUsd: 0,
    costFinal: false,
    files: [],
    siteFiles: [],           // what's on disk in the run folder (name, bytes, lines)
    toolCounts: {},
    toolErrors: 0,
    thinkTokens: 0,
    contextPeak: 0,
    waitMs: 0,               // request sent → first token, summed over API calls
    timeline: [],            // per API call: {req, first, end} ms from start
    activity: [],            // recent steps: {t, kind, text}
    current: '',             // what the model is doing right now
    thinkTail: '',           // last few hundred chars of streamed reasoning
    thinkStart: null,        // when the current reasoning block began
    resultText: '',
    error: '',
    _msgs: {},               // per-API-message usage, keyed by message id
    _child: null,
    _timer: null,
  };
}
for (const m of MODELS) {
  runs[m.id] = freshRun(m.id);
  servers[m.id] = m.kind === 'local'
    ? { status: 'stopped', detail: '', loadMs: null, gguf: null }
    : { status: 'ready', detail: 'Anthropic API' };
}

// ---------------------------------------------------------------- SSE
const clients = new Set();
function send(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) res.write(line);
}
function publicRun(r) {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));
}
const pendingState = new Set();
let stateTimer = null;
function pushState(id) {
  pendingState.add(id);
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    for (const mid of pendingState) send({ type: 'state', id: mid, run: publicRun(runs[mid]), server: servers[mid], mode: currentMode });
    pendingState.clear();
  }, 150);
}
// Every event (plus harness notes) goes to runs/<id>/events.jsonl.
function emit(id, ev) {
  runs[id]._log?.write(JSON.stringify(ev) + '\n');
}
function harness(id, text, level = 'info') {
  emit(id, { type: 'harness', level, text, t: Date.now() });
  if (level === 'stderr' || level === 'error') { activity(runs[id], 'warn', text); pushState(id); }
}

// ---------------------------------------------------------------- llama-server
function resolveGguf(m) {
  // scripts/fetch-models.sh location first, then the standard HF hub cache.
  const direct = path.join(HF_GGUF, m.repo, m.file);
  if (fs.existsSync(direct)) return direct;
  const snaps = path.join(HF_HUB, `models--${m.repo.replace('/', '--')}`, 'snapshots');
  if (!fs.existsSync(snaps)) return null;
  for (const rev of fs.readdirSync(snaps)) {
    const p = path.join(snaps, rev, m.file);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
  }
  return null;
}

async function health(m) {
  try {
    const r = await fetch(`http://127.0.0.1:${m.llamaPort}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function startLlama(m) {
  const s = servers[m.id];
  if (await health(m)) { Object.assign(s, { status: 'ready', detail: 'already running' }); pushState(m.id); return; }
  const gguf = resolveGguf(m);
  if (!gguf) {
    Object.assign(s, { status: 'missing', detail: 'weights still downloading' });
    pushState(m.id);
    setTimeout(() => startLlama(m), 15000); // keep checking while the download finishes
    return;
  }
  s.gguf = gguf;
  const args = [
    '-m', gguf, '--alias', m.alias,
    '--host', '127.0.0.1', '--port', String(m.llamaPort),
    '-c', String(m.ctx), '-np', '2', '--kv-unified',
    '-ngl', 'all', '-fa', 'on', '--jinja',
    '--cache-reuse', '256', '--metrics',
  ];
  if (m.reasoningEffort) args.push('--reasoning-effort', m.reasoningEffort);
  const sp = m.sampling || {};
  if (sp.temp != null) args.push('--temp', String(sp.temp));
  if (sp.topK != null) args.push('--top-k', String(sp.topK));
  if (sp.topP != null) args.push('--top-p', String(sp.topP));
  if (sp.minP != null) args.push('--min-p', String(sp.minP));
  if (sp.presencePenalty != null) args.push('--presence-penalty', String(sp.presencePenalty));
  if (m.chatTemplate) args.push('--chat-template-file', path.join(ROOT, m.chatTemplate));
  const log = fs.openSync(path.join(LOGS, `llama-${m.id}.log`), 'a');
  fs.writeSync(log, `\n==== ${new Date().toISOString()} ${LLAMA_SERVER} ${args.join(' ')}\n`);
  const child = spawn(LLAMA_SERVER, args, { stdio: ['ignore', log, log] });
  children.add(child);
  const t0 = Date.now();
  Object.assign(s, { status: 'loading', detail: 'loading weights into unified memory', pid: child.pid });
  pushState(m.id);
  child.on('exit', (code) => {
    children.delete(child);
    Object.assign(s, { status: 'crashed', detail: `llama-server exited (${code}); see logs/llama-${m.id}.log` });
    pushState(m.id);
  });
  while (child.exitCode === null) {
    if (await health(m)) {
      Object.assign(s, { status: 'ready', detail: '', loadMs: Date.now() - t0 });
      pushState(m.id);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function waitForServer(m, r) {
  while (servers[m.id].status !== 'ready') {
    if (r.status === 'stopped') return false;
    if (servers[m.id].status === 'crashed') return false;
    r.detail = `model server ${servers[m.id].status}…`;
    pushState(m.id);
    await new Promise((res) => setTimeout(res, 1000));
  }
  return true;
}

// ---------------------------------------------------------------- Claude Code run
function claudeEnv(m) {
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1', NO_COLOR: '1' };
  if (m.kind === 'local') {
    // A clean config dir: no user hooks, MCP servers, plugins or saved login,
    // and every model slot (main, background, subagent) points at the local server.
    delete env.ANTHROPIC_API_KEY;
    // Drop any cloud-provider routing (Bedrock / Vertex / Foundry / gateways) inherited
    // from the user's shell so requests really go to ANTHROPIC_BASE_URL.
    for (const k of Object.keys(env)) {
      if (/^CLAUDE_CODE_USE_|^CLAUDE_CODE_SKIP_.*_AUTH$|^ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY)_|^ANTHROPIC_CUSTOM_HEADERS$|^ANTHROPIC_BETAS$/.test(k)) delete env[k];
    }
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: path.join(ROOT, '.claude-local', m.id),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${m.llamaPort}`,
      ANTHROPIC_AUTH_TOKEN: 'local-llama-server',
      ANTHROPIC_MODEL: m.alias,
      ANTHROPIC_DEFAULT_OPUS_MODEL: m.alias,
      ANTHROPIC_DEFAULT_SONNET_MODEL: m.alias,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: m.alias,
      ANTHROPIC_SMALL_FAST_MODEL: m.alias,
      CLAUDE_CODE_SUBAGENT_MODEL: m.alias,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0', // keeps the system prompt byte-stable so llama.cpp can reuse its KV cache
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      API_TIMEOUT_MS: '3600000',
    });
  } else {
    Object.assign(env, {
      ANTHROPIC_SMALL_FAST_MODEL: m.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: m.model,
      CLAUDE_CODE_SUBAGENT_MODEL: m.model,
    });
  }
  return env;
}

function claudeArgs(m, task) {
  return [
    '-p', task,
    '--model', m.kind === 'local' ? m.alias : m.model,
    // Claude Code sends effort "high" to models it doesn't recognise and "medium" to
    // Haiku 5.5, and llama-server honours the per-request value over its own default.
    // Pin it so all three run at the same level (check: harness/capture-request.mjs).
    '--effort', NEUTRAL.effort,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', TOOLS,
    '--allowedTools', ...ALLOWED_BASH,
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config',          // no MCP servers
    '--setting-sources', 'project', // ignore ~/.claude settings (hooks, plugins)
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
}

// The process for one run: Claude Code, or the neutral loop with the same
// task, cwd and effort. Both print the same stream-json event shape.
function harnessCommand(m, r, task) {
  if (r.harness === 'neutral') {
    const taskFile = path.join(RUNS, m.id, 'task.txt');
    fs.writeFileSync(taskFile, task);
    const args = [
      path.join(ROOT, 'harness', 'neutral-agent.mjs'),
      '--cwd', siteDir(m.id), '--task-file', taskFile,
      '--max-turns', NEUTRAL.maxTurns, '--max-tokens', NEUTRAL.maxTokens, '--effort', NEUTRAL.effort,
    ];
    if (m.kind === 'local') {
      args.push('--backend', 'openai', '--base-url', `http://127.0.0.1:${m.llamaPort}/v1`, '--model', m.alias);
    } else {
      const p = m.pricing;
      args.push('--backend', 'bedrock', '--model', m.bedrockModel,
        '--price-in', p.input, '--price-out', p.output, '--price-cw', p.cacheWrite, '--price-cr', p.cacheRead);
    }
    return {
      cmd: process.execPath, args: args.map(String), env: { ...process.env },
      note: m.kind === 'local' ? `neutral loop → http://127.0.0.1:${m.llamaPort}/v1/chat/completions` : `neutral loop → Bedrock ${m.bedrockModel}`,
    };
  }
  return {
    cmd: 'claude', args: claudeArgs(m, task), env: claudeEnv(m),
    note: m.kind === 'local' ? `claude -p → ANTHROPIC_BASE_URL=http://127.0.0.1:${m.llamaPort}` : 'claude -p → your Claude Code login',
  };
}

function archiveSite(id) {
  const dir = siteDir(id);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    const dest = path.join(RUNS, '_archive', new Date().toISOString().replace(/[:.]/g, '-'), id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(dir, dest);
  }
  fs.mkdirSync(dir, { recursive: true });
}

const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const relPath = (m, p) => (p ? path.relative(siteDir(m.id), p) || path.basename(p) : '');
const firstLine = (s) => String(s || '').trim().split('\n')[0].slice(0, 140);
const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : '');

function toolLabel(m, name, input = {}) {
  switch (name) {
    case 'Write': return `Write ${relPath(m, input.file_path)} · ${String(input.content || '').split('\n').length} lines`;
    case 'Edit': return `Edit ${relPath(m, input.file_path)}`;
    case 'Read': return `Read ${relPath(m, input.file_path)}`;
    case 'Glob': return `Glob ${input.pattern || ''}`;
    case 'Grep': return `Grep ${String(input.pattern || '').slice(0, 40)}`;
    case 'Bash': return `Bash ${String(input.command || '').slice(0, 100)}`;
    case 'TodoWrite': return `TodoWrite · ${(input.todos || []).length} items`;
    case 'write_file': return `write_file ${input.path || ''} · ${String(input.content || '').split('\n').length} lines`;
    case 'edit_file': case 'read_file': case 'check_javascript': return `${name} ${input.path || ''}`;
    case 'list_files': return `list_files ${input.path || '.'}`;
    default: return name;
  }
}

function activity(r, kind, text) {
  r.activity.push({ t: r.startedAt ? Date.now() - r.startedAt : 0, kind, text: String(text).slice(0, 180) });
  if (r.activity.length > 60) r.activity.shift();
}

function recompute(r, m) {
  const t = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let genMs = 0; let waitMs = 0; let think = 0; let ctxPeak = 0;
  const now = Date.now();
  const base = r.startedAt || now;
  const timeline = [];
  for (const u of Object.values(r._msgs)) {
    t.input += u.input; t.cacheWrite += u.cacheWrite; t.cacheRead += u.cacheRead; t.output += u.output;
    const end = u.endAt || u.lastAt;
    if (u.firstAt && end) genMs += end - u.firstAt;
    const req = u.reqAt || u.startAt || now;
    waitMs += (u.firstAt || u.endAt || now) - req;
    think += Math.max(u.thinkEst || 0, Math.round((u.thinkChars || 0) / 4));
    ctxPeak = Math.max(ctxPeak, u.input + u.cacheWrite + u.cacheRead);
    timeline.push({ req: req - base, first: u.firstAt ? u.firstAt - base : null, end: u.endAt ? u.endAt - base : null });
  }
  timeline.sort((a, b) => a.req - b.req);
  if (!r.tokensFinal) r.tokens = t;
  if (!r.thinkFinal) r.thinkTokens = think;
  Object.assign(r, { genMs, waitMs, timeline, contextPeak: ctxPeak, streamOut: t.output });
  if (m.kind === 'api' && !r.costFinal) {
    const p = m.pricing;
    r.costUsd = (t.input * p.input + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead + t.output * p.output) / 1e6;
  }
}

function msgUsage(r, id) {
  return (r._msgs[id] ||= {
    input: 0, cacheWrite: 0, cacheRead: 0, output: 0, chars: 0, thinkChars: 0, thinkEst: 0,
    reqAt: null, startAt: null, firstAt: null, lastAt: null, endAt: null, fromStream: false, final: false,
  });
}
function mergeUsage(u, usage) {
  if (!usage) return;
  u.input = Math.max(u.input, usage.input_tokens || 0);
  u.cacheWrite = Math.max(u.cacheWrite, usage.cache_creation_input_tokens || 0);
  u.cacheRead = Math.max(u.cacheRead, usage.cache_read_input_tokens || 0);
  u.output = Math.max(u.output, usage.output_tokens || 0);
}
const estOut = (u) => Math.round((u.chars - u.thinkChars) / 4) + Math.max(u.thinkEst, Math.round(u.thinkChars / 4));

function handleClaudeEvent(m, r, ev) {
  const now = Date.now();
  ev.t = now;
  const scope = ev.parent_tool_use_id || 'main';
  r._cur ||= {}; r._blk ||= {}; r._toolIds ||= new Set(); r._toolNames ||= {};
  const curMsg = () => { const id = r._cur[scope]; return id ? r._msgs[id] : null; };

  if (ev.type === 'system') {
    if (ev.subtype === 'init') {
      Object.assign(r, { sessionModel: ev.model, ccVersion: ev.claude_code_version });
      activity(r, 'info', ev.harness === 'neutral'
        ? `Neutral agent loop started · model ${ev.model}`
        : `Claude Code ${ev.claude_code_version || ''} started · model ${ev.model}`);
    } else if (ev.subtype === 'status' && ev.status === 'requesting') {
      r._reqAt = now;
      r.current = m.kind === 'local' ? 'Model is reading the prompt…' : 'Waiting for the API…';
    } else if (ev.subtype === 'thinking_tokens') {
      // Hidden reasoning (Haiku doesn't return thinking text): Claude Code sends an estimate.
      const u = curMsg();
      if (u && !u.final) {
        u.thinkEst = ev.estimated_tokens || 0;
        u.output = Math.max(u.output, estOut(u));
        u.firstAt ||= now; u.lastAt = now;
        r.firstTokenAt ||= now;
        r.current = `Thinking… ~${fmtK(u.thinkEst)} tokens`;
      }
    } else if (/retry/i.test(ev.subtype || '')) {
      activity(r, 'warn', `API retry${ev.attempt ? ` #${ev.attempt}` : ''}${ev.error ? `: ${firstLine(ev.error)}` : ''}`);
    }
  } else if (ev.type === 'stream_event') {
    const e = ev.event || {};
    if (e.type === 'message_start') {
      const id = e.message?.id || `msg_${now}`;
      r._cur[scope] = id;
      const u = msgUsage(r, id);
      Object.assign(u, { fromStream: true, startAt: now, reqAt: r._reqAt && r._reqAt <= now ? r._reqAt : now });
      r._reqAt = null;
      mergeUsage(u, e.message?.usage);
      r.turns += 1;
    } else {
      const u = curMsg();
      const bk = `${scope}:${r._cur[scope]}:${e.index}`;
      if (e.type === 'content_block_start') {
        const cb = e.content_block || {};
        r._blk[bk] = { type: cb.type, name: cb.name, chars: 0, t0: now, text: '' };
        if (cb.type === 'thinking' || cb.type === 'redacted_thinking') { r.current = 'Thinking…'; r.thinkTail = ''; r.thinkStart = now; }
        else if (cb.type === 'text') r.current = 'Writing a reply…';
        else if (cb.type === 'tool_use') r.current = `Calling ${cb.name}…`;
      } else if (e.type === 'content_block_delta') {
        const d = e.delta || {};
        const str = d.text || d.thinking || d.partial_json || '';
        const b = r._blk[bk];
        if (u) {
          u.firstAt ||= now; u.lastAt = now;
          u.chars += str.length;
          if (d.type === 'thinking_delta') u.thinkChars += str.length;
          // Output usage only arrives at message end; estimate (~4 chars/token) meanwhile.
          if (!u.final) u.output = Math.max(u.output, estOut(u));
        }
        r.firstTokenAt ||= now;
        if (b) {
          b.chars += str.length;
          if (b.type === 'text' && b.text.length < 240) b.text += str;
          if (b.type === 'thinking' && str) r.thinkTail = (r.thinkTail + str).slice(-320);
          if (b.type === 'tool_use') r.current = `${b.name} · generating input, ${fmtK(b.chars)} chars`;
          else if (b.type === 'thinking') r.current = `Thinking… ~${fmtK(Math.round(b.chars / 4))} tokens so far`;
        }
      } else if (e.type === 'content_block_stop') {
        const b = r._blk[bk];
        if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
          r.thinkStart = null;
          const est = Math.max(Math.round(b.chars / 4), u?.thinkEst || 0);
          activity(r, 'think', `Thought for ${((now - b.t0) / 1000).toFixed(1)}s${est ? ` · ~${fmtK(est)} tokens` : ''}`);
        } else if (b?.type === 'text' && b.text.trim()) {
          activity(r, 'text', b.text.trim().replace(/\s+/g, ' '));
        }
        delete r._blk[bk];
      } else if (e.type === 'message_delta' && u && e.usage) {
        mergeUsage(u, { ...e.usage, output_tokens: 0 });
        if (typeof e.usage.output_tokens === 'number') { u.output = e.usage.output_tokens; u.final = true; }
      } else if (e.type === 'message_stop' && u) {
        u.endAt = now;
      }
    }
  } else if (ev.type === 'assistant') {
    const msg = ev.message || {};
    const u = msgUsage(r, msg.id || `msg_${now}`);
    if (!u.fromStream) {
      // No partial stream for this message: take its usage and content as-is.
      mergeUsage(u, msg.usage);
      u.reqAt ||= r._reqAt || now; u.startAt ||= now; u.firstAt ||= now; u.endAt = now;
      if (!u.counted) { r.turns += 1; u.counted = true; }
    }
    for (const b of msg.content || []) {
      if (b.type === 'tool_use' && !r._toolIds.has(b.id)) {
        r._toolIds.add(b.id);
        r._toolNames[b.id] = b.name;
        r.toolCounts[b.name] = (r.toolCounts[b.name] || 0) + 1;
        activity(r, 'tool', toolLabel(m, b.name, b.input));
        r.current = `Running ${b.name}…`;
        const written = (b.name === 'Write' || b.name === 'Edit') ? relPath(m, b.input?.file_path)
          : (b.name === 'write_file' || b.name === 'edit_file') ? b.input?.path : null;
        if (written && !r.files.includes(written)) r.files.push(written);
      } else if (!u.fromStream && b.type === 'text' && b.text?.trim()) {
        activity(r, 'text', b.text.trim().replace(/\s+/g, ' '));
      } else if (!u.fromStream && b.type === 'thinking') {
        activity(r, 'think', 'Thought');
      }
    }
  } else if (ev.type === 'user') {
    for (const c of ev.message?.content || []) {
      if (c.type === 'tool_result' && c.is_error) {
        r.toolErrors += 1;
        activity(r, 'error', `${r._toolNames[c.tool_use_id] || 'Tool'} failed: ${firstLine(resultText(c.content).replace(/<\/?tool_use_error>/g, ''))}`);
      }
    }
  } else if (ev.type === 'result') {
    r.durationMs = ev.duration_ms ?? null;
    if (typeof ev.num_turns === 'number') r.turnsReported = ev.num_turns;
    if (m.kind === 'api' && typeof ev.total_cost_usd === 'number') { r.costUsd = ev.total_cost_usd; r.costFinal = true; }
    if (m.kind === 'local') { r.costUsd = 0; r.costFinal = true; }
    // Claude Code's own per-model totals cover every API call it made.
    const mu = Object.values(ev.modelUsage || {});
    if (mu.length) {
      const sum = (k) => mu.reduce((a, x) => a + (x[k] || 0), 0);
      r.tokens = {
        input: sum('inputTokens'), cacheWrite: sum('cacheCreationInputTokens'),
        cacheRead: sum('cacheReadInputTokens'), output: sum('outputTokens'),
      };
      r.tokensFinal = true;
      if (sum('thinkingTokens')) { r.thinkTokens = sum('thinkingTokens'); r.thinkFinal = true; }
    }
    r.resultText = typeof ev.result === 'string' ? ev.result : '';
    const ok = !ev.is_error && ev.subtype === 'success';
    if (!ok) r.error = firstLine(r.resultText) || ev.subtype || 'error';
    r.current = '';
    r.thinkStart = null;
    activity(r, ok ? 'done' : 'error', ok ? 'Task complete' : `Run ended: ${r.error}`);
  }
  recompute(r, m);
  emit(m.id, ev);
  pushState(m.id);
}

async function runModel(m, job, r) {
  const task = job.prompt;
  const live = () => runs[m.id] === r && r.status !== 'stopped';
  if (!live()) return;
  if (m.kind === 'local') {
    r.status = 'waiting';
    pushState(m.id);
    const ok = await waitForServer(m, r);
    if (!live()) return;
    if (!ok) {
      Object.assign(r, { status: 'error', error: `model server ${servers[m.id].status}` });
      pushState(m.id);
      return;
    }
  }
  archiveSite(m.id);
  if (job.task.seed) fs.cpSync(job.task.seed, siteDir(m.id), { recursive: true }); // starting files, e.g. data.json or the buggy app
  r._log = fs.createWriteStream(path.join(RUNS, m.id, 'events.jsonl')); // every event, for later inspection
  const cmd = harnessCommand(m, r, task);
  harness(m.id, `[${job.task.title} · ${harnessById[r.harness].name}] ${cmd.note}`);

  const child = spawn(cmd.cmd, cmd.args, { cwd: siteDir(m.id), env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  r._child = child;
  Object.assign(r, { status: 'running', detail: '', startedAt: Date.now() });
  pushState(m.id);
  const raw = fs.createWriteStream(path.join(RUNS, m.id, `${r.harness}-stream.jsonl`)); // untouched harness output

  r._timer = setTimeout(() => {
    if (runs[m.id] === r) harness(m.id, `Timed out after ${RUN_TIMEOUT_MS / 60000} min — stopping.`, 'error');
    r.error = 'timeout';
    child.kill('SIGTERM');
  }, RUN_TIMEOUT_MS);

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    raw.write(line + '\n');
    if (runs[m.id] !== r) return;
    let ev;
    try { ev = JSON.parse(line); } catch { harness(m.id, line, 'stdout'); return; }
    handleClaudeEvent(m, r, ev);
  });
  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    if (!line.trim() || runs[m.id] !== r) return;
    // Expected for local model aliases; keep it in the log but out of the feed.
    harness(m.id, line, /unrecognized_model/.test(line) ? 'info' : 'stderr');
  });

  const code = await new Promise((resolve) => child.on('close', resolve));
  children.delete(child);
  clearTimeout(r._timer);
  raw.end();
  r._child = null;
  r.endedAt = r.endedAt || Date.now();
  r.siteFiles = listSite(m.id);
  if (r.status !== 'stopped') r.status = (code === 0 && !r.error) ? 'done' : 'error';
  if (code !== 0 && !r.error && r.status !== 'stopped') r.error = `harness exited with code ${code}`;
  if (runs[m.id] === r) pushState(m.id);
  if (r.status !== 'stopped') await gradeAndRecord(m, r, task);
  fs.writeFileSync(path.join(RUNS, m.id, 'state.json'), JSON.stringify(publicRun(r)));
  r._log?.end();
  r._log = null;
  if (runs[m.id] === r) pushState(m.id);
}

// Copy the output into results/runs/<runId>/, autograde that copy, and append
// one line to results/runs.jsonl (the comparison page reads that file).
async function gradeAndRecord(m, r, task) {
  const dir = path.join(RESULT_RUNS, r.runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(siteDir(m.id), path.join(dir, 'site'), { recursive: true });
  for (const f of ['events.jsonl', `${r.harness}-stream.jsonl`]) {
    const src = path.join(RUNS, m.id, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  r.grading = true;
  activity(r, 'info', 'Autograding…');
  pushState(m.id);
  try {
    const g = await gradeSite(path.join(dir, 'site'), specs[r.task], { outDir: dir });
    fs.writeFileSync(path.join(dir, 'grade.json'), JSON.stringify(g, null, 2));
    r.grade = {
      score: g.score, passed: g.passed, total: g.total,
      failed: g.checks.filter((c) => !c.pass).map(({ id, label, detail }) => ({ id, label, detail })),
      checks: Object.fromEntries(g.checks.map((c) => [c.id, c.pass])),
      screenshots: g.screenshots,
    };
    activity(r, g.passed === g.total ? 'done' : 'warn', `Autograder: ${g.passed}/${g.total}${g.passed < g.total ? ` · failed ${r.grade.failed.map((f) => f.id).join(', ')}` : ''}`);
  } catch (e) {
    r.grade = { error: String(e.message || e).split('\n')[0].slice(0, 200) };
    activity(r, 'error', `Autograder failed: ${r.grade.error}`);
  }
  r.grading = false;
  const record = {
    runId: r.runId, batchId: r.batchId, at: new Date(r.startedAt).toISOString(),
    taskId: r.task, taskTitle: taskById[r.task]?.title || r.task,
    model: m.id, modelName: m.name, harness: r.harness, repeat: r.repeat,
    status: r.status, error: r.error,
    wallMs: r.endedAt - r.startedAt, durationMs: r.durationMs,
    ttftMs: r.firstTokenAt ? r.firstTokenAt - r.startedAt : null,
    apiRequests: r.turns, agentTurns: r.turnsReported ?? null,
    tokens: r.tokens, thinkTokens: r.thinkTokens, contextPeak: r.contextPeak,
    tokPerSec: r.genMs ? r.streamOut / (r.genMs / 1000) : null,
    waitMs: r.waitMs, genMs: r.genMs,
    costUsd: r.costUsd, toolCounts: r.toolCounts, toolErrors: r.toolErrors,
    files: r.siteFiles, grade: r.grade,
    config: { reasoningEffort: m.reasoningEffort || 'default', sampling: m.sampling || null, quant: m.quant || null },
    task,
  };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(record, null, 2));
  fs.appendFileSync(RESULT_INDEX, JSON.stringify(record) + '\n');
  send({ type: 'result', record });
}

function stopModels(ids) {
  if (batch && batch.status === 'running') { batch.status = 'stopped'; sendBatch(); }
  for (const id of ids) {
    const r = runs[id];
    if (['queued', 'waiting', 'running'].includes(r.status)) { r.status = 'stopped'; r.endedAt = Date.now(); }
    if (r._child) r._child.kill('SIGTERM');
    pushState(id);
  }
}

const publicBatch = (b) => b && { ...b, jobs: b.jobs.map((j) => ({ ...j })) };
function sendBatch() { send({ type: 'batch', batch: publicBatch(batch) }); }

// A batch = harnesses × repeats jobs, run one after another. Within a job the
// API model runs alongside the first local model; local models go one at a time
// (they share the GPU) unless mode is "parallel". `only` limits the models.
function startBatch({ tasks, prompt, mode, only, harnesses, repeats }) {
  const targets = only?.length ? MODELS.filter((m) => only.includes(m.id)) : MODELS;
  stopModels(targets.map((m) => m.id));
  currentTasks = tasks;
  currentTask = tasks.length === 1 ? (prompt || taskById[tasks[0]].prompt) : '';
  currentMode = mode;
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  // A custom prompt only applies when a single task is selected; its grader still applies.
  const promptFor = (tid) => (tasks.length === 1 && prompt ? prompt : taskById[tid].prompt);
  const jobs = [];
  for (let rep = 1; rep <= repeats; rep++) for (const tid of tasks) for (const h of harnesses) jobs.push({ task: tid, harness: h, repeat: rep });
  const b = { id, tasks, mode, harnesses, repeats, models: targets.map((m) => m.id), jobs, index: 0, status: 'running', startedAt: Date.now() };
  batch = b;
  sendBatch();
  (async () => {
    for (let i = 0; i < jobs.length; i++) {
      if (batch !== b || b.status !== 'running') return;
      b.index = i;
      sendBatch();
      const job = jobs[i];
      const run = { task: taskById[job.task], prompt: promptFor(job.task) };
      for (const m of targets) {
        runs[m.id] = freshRun(m.id, {
          task: job.task, harness: job.harness, repeat: job.repeat, batchId: id,
          runId: `${id}__${job.task}__${m.id}__${job.harness}__r${job.repeat}`,
        });
        runs[m.id].status = 'queued';
        archiveSite(m.id); // a queued model shows an empty page, not the previous run's app
        send({ type: 'clear', id: m.id });
        pushState(m.id);
      }
      const locals = targets.filter((m) => m.kind === 'local');
      const work = targets.filter((m) => m.kind === 'api').map((m) => runModel(m, run, runs[m.id]));
      if (mode === 'parallel') {
        work.push(...locals.map((m) => runModel(m, run, runs[m.id])));
      } else {
        const chain = locals.map((m) => runs[m.id]);
        locals.slice(1).forEach((m, k) => { chain[k + 1].detail = `starts after ${locals[k].name} (one local model at a time)`; pushState(m.id); });
        work.push((async () => { for (const [k, m] of locals.entries()) await runModel(m, run, chain[k]); })());
      }
      await Promise.all(work);
    }
    if (batch === b && b.status === 'running') { b.status = 'done'; b.endedAt = Date.now(); sendBatch(); }
  })();
}

function readResults() {
  if (!fs.existsSync(RESULT_INDEX)) return [];
  return fs.readFileSync(RESULT_INDEX, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .map((r) => ({ ...r, taskId: r.taskId || 'pomodoro', taskTitle: r.taskTitle || 'Pomodoro timer' })); // runs from before tasks existed
}

// ---------------------------------------------------------------- restore last runs on restart
for (const m of MODELS) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(RUNS, m.id, 'state.json'), 'utf8'));
    runs[m.id] = Object.assign(freshRun(m.id), st);
  } catch { /* no finished run yet */ }
}

// ---------------------------------------------------------------- file watching → file list + iframe reload
function listSite(id) {
  const out = [];
  const walk = (dir, rel = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || out.length > 40) continue;
      const full = path.join(dir, ent.name);
      const name = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(full, name); continue; }
      const { size } = fs.statSync(full);
      let lines = null;
      if (size < 2e6 && /\.(html?|css|m?js|json|txt|md|svg)$/i.test(ent.name)) lines = fs.readFileSync(full, 'utf8').split('\n').length;
      out.push({ name, bytes: size, lines });
    }
  };
  try { walk(siteDir(id)); } catch { /* folder being swapped */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

for (const m of MODELS) {
  fs.mkdirSync(siteDir(m.id), { recursive: true });
  let t = null;
  fs.watch(path.join(RUNS, m.id), { recursive: true }, (_e, file) => {
    if (!file || !String(file).startsWith('site')) return;
    clearTimeout(t);
    t = setTimeout(() => {
      if (runs[m.id].startedAt) { runs[m.id].siteFiles = listSite(m.id); pushState(m.id); }
      send({ type: 'reload', id: m.id, file: String(file) });
    }, 350);
  });
}

// ---------------------------------------------------------------- HTTP helpers
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}
function safeJoin(base, urlPath) {
  const p = path.normalize(path.join(base, decodeURIComponent(urlPath)));
  return p.startsWith(base) ? p : null;
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const PLACEHOLDER = (m) => `<!doctype html><meta charset="utf-8"><style>
html,body{height:100%;margin:0;background:#0d1117;color:#6e7681;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center}
</style><div>${m.name} hasn't written index.html yet…</div>`;

// One static server per model, on its own origin, serving that model's output.
for (const m of MODELS) {
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const base = siteDir(m.id);
    const file = safeJoin(base, p);
    if (!file) { res.writeHead(403); res.end(); return; }
    if (p === '/index.html' && !fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PLACEHOLDER(m));
      return;
    }
    serveFile(res, file);
  }).listen(m.sitePort, '127.0.0.1');
}

// ---------------------------------------------------------------- dashboard
function snapshot() {
  return {
    type: 'snapshot',
    task: currentTask,
    mode: currentMode,
    models: MODELS,
    harnesses: HARNESSES,
    tasks: TASKS.map(publicTask),
    currentTasks,
    batch: publicBatch(batch),
    runs: Object.fromEntries(Object.entries(runs).map(([id, r]) => [id, publicRun(r)])),
    servers,
    now: Date.now(),
  };
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/run') {
    const body = await readBody(req);
    const tasks = (Array.isArray(body.tasks) ? body.tasks : [TASKS[0].id]).filter((t) => taskById[t]);
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.slice(0, 8000) : null;
    const mode = body.mode === 'parallel' ? 'parallel' : 'sequential';
    const only = Array.isArray(body.only) ? body.only.filter((id) => byId[id]) : null;
    const harnesses = (Array.isArray(body.harnesses) ? body.harnesses : ['claude-code']).filter((h) => harnessById[h]);
    const repeats = Math.min(10, Math.max(1, parseInt(body.repeats, 10) || 1));
    startBatch({ tasks: tasks.length ? tasks : [TASKS[0].id], prompt, mode, only, harnesses: harnesses.length ? harnesses : ['claude-code'], repeats });
    json(res, { ok: true, mode, tasks, harnesses, repeats });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    const body = await readBody(req);
    stopModels(Array.isArray(body.only) ? body.only.filter((id) => byId[id]) : MODELS.map((m) => m.id));
    json(res, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/results') {
    json(res, { runs: readResults(), models: MODELS, harnesses: HARNESSES, tasks: TASKS.map(publicTask) });
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/results/')) {
    const file = safeJoin(RESULTS, url.pathname.slice('/results'.length));
    if (file) { serveFile(res, file); return; }
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    json(res, snapshot());
    return;
  }
  if (req.method === 'GET') {
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = safeJoin(PUBLIC, p);
    if (file) { serveFile(res, file); return; }
  }
  res.writeHead(404); res.end();
});

// ---------------------------------------------------------------- boot
function shutdown() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (process.argv.includes('--check')) {
  console.log('llama-server:', fs.existsSync(LLAMA_SERVER) ? LLAMA_SERVER : 'MISSING');
  for (const m of MODELS.filter((x) => x.kind === 'local')) console.log(`${m.name}:`, resolveGguf(m) || 'MISSING');
  process.exit(0);
}

app.listen(DASHBOARD_PORT, '127.0.0.1', () => {
  console.log(`Bake-off dashboard: http://localhost:${DASHBOARD_PORT}`);
  for (const m of MODELS) console.log(`  ${m.name.padEnd(18)} output → http://localhost:${m.sitePort}`);
});
for (const m of MODELS.filter((x) => x.kind === 'local')) startLlama(m);

if (process.argv.includes('--autorun')) {
  const mode = process.argv.includes('--parallel') ? 'parallel' : 'sequential';
  const waitReady = setInterval(() => {
    if (MODELS.filter((x) => x.kind === 'local').every((m) => servers[m.id].status === 'ready')) {
      clearInterval(waitReady);
      startBatch({ tasks: TASKS.map((t) => t.id), mode, harnesses: ['claude-code', 'neutral'], repeats: 1 });
    }
  }, 1000);
}
