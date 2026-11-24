#!/usr/bin/env node
// A deliberately plain agent loop, the "neutral harness": no model was tuned
// for it. Every model gets the same short system prompt, the same five tools,
// the same turn limit and the same effort setting, each through its own native
// API (OpenAI-style chat completions on llama-server, the Messages API for Claude).
//
// It prints events in the same stream-json shape as `claude -p --output-format
// stream-json --include-partial-messages`, so the dashboard's metrics code
// treats both harnesses identically.
//
//   node harness/neutral-agent.mjs --backend openai --base-url http://127.0.0.1:8081/v1 --model inkling-2-mini --cwd <dir> --task-file <file>
//   node harness/neutral-agent.mjs --backend bedrock --model global.anthropic.claude-haiku-5-5 --cwd <dir> --task-file <file> --effort medium
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const CFG = {
  backend: arg('backend', 'openai'),
  baseUrl: arg('base-url', 'http://127.0.0.1:8081/v1'),
  model: arg('model'),
  cwd: path.resolve(arg('cwd', process.cwd())),
  task: fs.readFileSync(arg('task-file'), 'utf8'),
  maxTurns: +arg('max-turns', 60),
  maxTokens: +arg('max-tokens', 32000),
  effort: arg('effort', 'medium'),
  price: { input: +arg('price-in', 0), output: +arg('price-out', 0), cacheWrite: +arg('price-cw', 0), cacheRead: +arg('price-cr', 0) },
};

const SYSTEM_PROMPT = `You are an autonomous software engineer working in a project directory.
Use the provided tools to inspect, create and edit files; paths are relative to the project directory.
Work until the task is fully complete, then reply with a one-line summary and stop calling tools.`;

const TOOLS = [
  {
    name: 'list_files',
    description: 'List files and folders under a directory of the project (recursive, up to 200 entries).',
    schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory, default "."' } }, required: [] },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the project.',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'edit_file',
    description: 'Replace exactly one occurrence of old_text with new_text in a file. Fails if old_text is missing or appears more than once.',
    schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
  },
  {
    name: 'check_javascript',
    description: 'Check a JavaScript file for syntax errors (runs `node --check`).',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sessionId = randomUUID();

// ---------------------------------------------------------------- tools (sandboxed to cwd)
function resolveInside(p) {
  const full = path.resolve(CFG.cwd, p || '.');
  if (full !== CFG.cwd && !full.startsWith(CFG.cwd + path.sep)) throw new Error(`path is outside the project: ${p}`);
  return full;
}

function validate(tool, input) {
  if (!input || typeof input !== 'object') return 'input must be an object';
  for (const k of tool.schema.required) if (typeof input[k] !== 'string') return `missing or non-string "${k}"`;
  return null;
}

async function runTool(name, input) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, text: `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(', ')}` };
  const bad = validate(tool, input);
  if (bad) return { ok: false, text: `Invalid input for ${name}: ${bad}` };
  try {
    switch (name) {
      case 'list_files': {
        const root = resolveInside(input.path);
        const items = [];
        const walk = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (items.length >= 200) return;
            const rel = path.relative(CFG.cwd, path.join(dir, e.name));
            items.push(e.isDirectory() ? `${rel}/` : `${rel} (${fs.statSync(path.join(dir, e.name)).size} bytes)`);
            if (e.isDirectory()) walk(path.join(dir, e.name));
          }
        };
        walk(root);
        return { ok: true, text: items.length ? items.join('\n') : '(empty)' };
      }
      case 'read_file': {
        const text = fs.readFileSync(resolveInside(input.path), 'utf8');
        return { ok: true, text: text.length > 100_000 ? `${text.slice(0, 100_000)}\n…(truncated)` : text };
      }
      case 'write_file': {
        const p = resolveInside(input.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, input.content);
        return { ok: true, text: `Wrote ${input.content.split('\n').length} lines to ${input.path}` };
      }
      case 'edit_file': {
        const p = resolveInside(input.path);
        const src = fs.readFileSync(p, 'utf8');
        const n = src.split(input.old_text).length - 1;
        if (n !== 1) return { ok: false, text: `old_text found ${n} times in ${input.path}; it must match exactly once` };
        fs.writeFileSync(p, src.replace(input.old_text, () => input.new_text));
        return { ok: true, text: `Edited ${input.path}` };
      }
      case 'check_javascript': {
        const p = resolveInside(input.path);
        return await new Promise((resolve) => execFile(process.execPath, ['--check', p], { timeout: 20_000 }, (err, _so, se) => {
          resolve(err ? { ok: false, text: String(se || err.message).trim().slice(0, 4000) } : { ok: true, text: 'No syntax errors.' });
        }));
      }
      default: return { ok: false, text: 'unreachable' };
    }
  } catch (e) {
    return { ok: false, text: String(e.message || e).slice(0, 2000) };
  }
}

// ---------------------------------------------------------------- backend: Claude via Amazon Bedrock (Messages API)
// bedrock-runtime (InvokeModel), the endpoint that serves Haiku 5.5 for this
// account; harness/bedrock-probe.mjs finds the working model ID. It has no
// automatic caching, so cache breakpoints go on the system prompt and on the
// newest message (prompt caching, like Claude Code's).
async function makeBedrock() {
  const { default: AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk');
  const client = new AnthropicBedrock({}); // region: AWS_REGION; credentials: AWS chain / AWS_BEARER_TOKEN_BEDROCK
  const messages = [{ role: 'user', content: CFG.task }];
  let eager = true;
  const tools = () => TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema, ...(eager ? { eager_input_streaming: true } : {}) }));
  const withBreakpoint = () => messages.map((m, i) => {
    if (i !== messages.length - 1) return m;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.map((b) => ({ ...b }));
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
    return { ...m, content: blocks };
  });
  return {
    async turn() {
      const params = {
        model: CFG.model,
        max_tokens: CFG.maxTokens,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: withBreakpoint(),
        tools: tools(),
        thinking: { type: 'adaptive' },
        output_config: { effort: CFG.effort },
      };
      let stream;
      try {
        stream = client.messages.stream(params);
        for await (const event of stream) out({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null });
      } catch (e) {
        // Fall back once if this deployment rejects fine-grained tool streaming.
        if (eager && /eager_input_streaming/i.test(String(e?.message))) { eager = false; return this.turn(); }
        throw e;
      }
      const msg = await stream.finalMessage();
      messages.push({ role: 'assistant', content: msg.content }); // unchanged, thinking blocks included
      const calls = msg.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const u = msg.usage || {};
      return {
        id: msg.id, content: msg.content, calls, text, stop: msg.stop_reason,
        usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 },
      };
    },
    addResults(results) {
      messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text, is_error: !r.ok })) });
    },
  };
}

// ---------------------------------------------------------------- backend: llama-server (OpenAI-style chat completions)
function makeOpenAI() {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: CFG.task }];
  const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  let n = 0;
  return {
    async turn() {
      n += 1;
      const id = `neutral_${n}_${Date.now()}`;
      const res = await fetch(`${CFG.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
        // No sampling parameters: llama-server is started with each model card's recommended values.
        body: JSON.stringify({ model: CFG.model, messages, tools, stream: true, stream_options: { include_usage: true }, max_tokens: CFG.maxTokens }),
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status });

      // Re-emit the stream as Messages-API-shaped events.
      let started = false; let idx = -1; let open = null;
      let thinking = ''; let text = ''; let finish = null; let usage = null; let timings = null;
      const calls = []; // {id, name, args, block}
      const startMsg = () => { if (!started) { started = true; out({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 0, output_tokens: 0 } } }, session_id: sessionId, parent_tool_use_id: null }); } };
      const ev = (event) => out({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null });
      const openBlock = (kind, extra = {}) => {
        if (open) ev({ type: 'content_block_stop', index: idx });
        idx += 1; open = kind;
        ev({ type: 'content_block_start', index: idx, content_block: { type: kind, ...extra } });
        return idx;
      };

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.timings) timings = chunk.timings;
          const ch = chunk.choices?.[0];
          if (!ch) continue;
          const d = ch.delta || {};
          if (d.reasoning_content) {
            startMsg();
            if (open !== 'thinking') openBlock('thinking', { thinking: '' });
            thinking += d.reasoning_content;
            ev({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: d.reasoning_content } });
          }
          if (d.content) {
            startMsg();
            if (open !== 'text') openBlock('text', { text: '' });
            text += d.content;
            ev({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: d.content } });
          }
          for (const tc of d.tool_calls || []) {
            startMsg();
            let call = calls.find((c) => c.k === tc.index);
            if (!call) {
              call = { k: tc.index, id: tc.id || `call_${randomUUID().slice(0, 8)}`, name: tc.function?.name || '', args: '' };
              calls.push(call);
              call.block = openBlock('tool_use', { id: call.id, name: call.name, input: {} });
            }
            if (tc.function?.name && !call.name) call.name = tc.function.name;
            if (tc.function?.arguments) {
              call.args += tc.function.arguments;
              ev({ type: 'content_block_delta', index: call.block, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
            }
          }
          if (ch.finish_reason) finish = ch.finish_reason;
        }
      }
      startMsg();
      if (open) ev({ type: 'content_block_stop', index: idx });

      // llama-server: timings.prompt_n = tokens processed now, cache_n = reused from the KV cache.
      const cached = timings?.cache_n ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const fresh = timings?.prompt_n ?? Math.max(0, (usage?.prompt_tokens || 0) - cached);
      const output = usage?.completion_tokens ?? timings?.predicted_n ?? 0;
      const stop = finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
      ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: { input_tokens: fresh, cache_read_input_tokens: cached, output_tokens: output } });
      ev({ type: 'message_stop' });

      const parsed = calls.map((c) => {
        let input = null;
        try { input = JSON.parse(c.args || '{}'); } catch { input = null; }
        return { id: c.id, name: c.name, input, raw: c.args };
      });
      const content = [
        ...(thinking ? [{ type: 'thinking', thinking }] : []),
        ...(text ? [{ type: 'text', text }] : []),
        ...parsed.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} })),
      ];
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(thinking ? { reasoning_content: thinking } : {}),
        ...(parsed.length ? { tool_calls: parsed.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw || '{}' } })) } : {}),
      });
      return { id, content, calls: parsed, text: text.trim(), stop, usage: { input: fresh, output, cacheWrite: 0, cacheRead: cached } };
    },
    addResults(results) {
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.text });
    },
  };
}

// ---------------------------------------------------------------- loop
async function withRetries(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.status ?? 0;
      const retryable = !status || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt >= 4) throw e;
      out({ type: 'system', subtype: 'api_retry', attempt, error_status: status, error: String(e.message || e).slice(0, 200), session_id: sessionId });
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function main() {
  const t0 = Date.now();
  out({ type: 'system', subtype: 'init', harness: 'neutral', model: CFG.model, cwd: CFG.cwd, tools: TOOLS.map((t) => t.name), session_id: sessionId });
  const backend = CFG.backend === 'bedrock' ? await makeBedrock() : makeOpenAI();
  const total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let turns = 0; let finalText = ''; let subtype = 'success'; let error = '';
  try {
    for (; turns < CFG.maxTurns;) {
      out({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId });
      const r = await withRetries(() => backend.turn());
      turns += 1;
      for (const k of Object.keys(total)) total[k] += r.usage[k] || 0;
      out({ type: 'assistant', message: { id: r.id, role: 'assistant', content: r.content, usage: { input_tokens: r.usage.input, output_tokens: r.usage.output, cache_read_input_tokens: r.usage.cacheRead, cache_creation_input_tokens: r.usage.cacheWrite } }, session_id: sessionId, parent_tool_use_id: null });
      if (!r.calls.length) { finalText = r.text; break; }
      const results = [];
      for (const c of r.calls) {
        // A response cut off at max_tokens may hold a truncated call: don't run it.
        const res = (r.stop === 'max_tokens' && c === r.calls[r.calls.length - 1])
          ? { ok: false, text: 'Your previous response hit the output limit and this call was cut off, so it was not run. Split large files into smaller writes.' }
          : c.input == null ? { ok: false, text: 'Tool arguments were not valid JSON.' } : await runTool(c.name, c.input);
        results.push({ id: c.id, ...res });
      }
      out({ type: 'user', message: { role: 'user', content: results.map((x) => ({ type: 'tool_result', tool_use_id: x.id, content: x.text, is_error: !x.ok })) }, session_id: sessionId, parent_tool_use_id: null });
      backend.addResults(results);
    }
    if (turns >= CFG.maxTurns && !finalText) subtype = 'error_max_turns';
  } catch (e) {
    subtype = 'error_during_execution';
    error = String(e?.message || e).slice(0, 500);
  }
  const p = CFG.price;
  const cost = (total.input * p.input + total.output * p.output + total.cacheWrite * p.cacheWrite + total.cacheRead * p.cacheRead) / 1e6;
  out({
    type: 'result', subtype, is_error: subtype !== 'success', duration_ms: Date.now() - t0, num_turns: turns,
    result: subtype === 'success' ? finalText : error || subtype, total_cost_usd: cost,
    modelUsage: { [CFG.model]: { inputTokens: total.input, outputTokens: total.output, cacheReadInputTokens: total.cacheRead, cacheCreationInputTokens: total.cacheWrite, costUSD: cost } },
    session_id: sessionId,
  });
  process.exit(subtype === 'success' ? 0 : 1);
}

main();
