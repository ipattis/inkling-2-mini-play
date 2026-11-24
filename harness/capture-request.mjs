#!/usr/bin/env node
// Show what Claude Code actually sends to a model: starts a throwaway local
// endpoint that records the first /v1/messages request body (and answers with
// an error), then runs `claude -p` against it with dummy auth. Nothing leaves
// this machine. Prints the generation settings, not the prompt text.
//   node harness/capture-request.mjs [model ...] [-- extra claude flags]     default models: inkling-2-mini claude-haiku-5-5
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

// Extra claude flags after "--", e.g. -- --effort medium
const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const extra = dd >= 0 ? argv.slice(dd + 1) : [];
const named = dd >= 0 ? argv.slice(0, dd) : argv;
const models = named.length ? named : ['inkling-2-mini', 'claude-haiku-5-5'];
const captured = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
      try {
        const j = JSON.parse(body);
        const { messages, system, tools, metadata, ...params } = j;
        captured.push({
          url: req.url,
          beta: req.headers['anthropic-beta'] || null,
          params,
          tools: (tools || []).map((t) => t.name),
          systemChars: JSON.stringify(system ?? '').length,
          messageRoles: (messages || []).map((m) => m.role),
        });
      } catch { /* not JSON */ }
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'capture endpoint: request recorded' } }));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

for (const model of models) {
  const start = captured.length;
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_USE_|^ANTHROPIC_(API_KEY|BEDROCK|VERTEX|FOUNDRY)|^ANTHROPIC_CUSTOM_HEADERS$|^AWS_BEARER_TOKEN_BEDROCK$/.test(k)) delete env[k];
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-capture-')),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: 'capture-only',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_MAX_RETRIES: '0',
  });
  await new Promise((resolve) => {
    const child = spawn('claude', [
      '-p', 'hi', '--model', model, '--output-format', 'json',
      '--tools', 'Bash,Read,Write,Edit,Glob,Grep,TodoWrite',
      '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', ...extra,
    ], { cwd: os.tmpdir(), env, stdio: ['ignore', 'ignore', 'ignore'] });
    const t = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.on('close', () => { clearTimeout(t); resolve(); });
  });
  const reqs = captured.slice(start);
  console.log(`\n=== --model ${model}: ${reqs.length} request(s)`);
  for (const r of reqs.slice(0, 2)) {
    console.log(JSON.stringify({ ...r.params, anthropic_beta: r.beta, tools: r.tools.length, system_chars: r.systemChars, roles: r.messageRoles.join(',') }, null, 1));
  }
}
server.close();
