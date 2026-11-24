#!/usr/bin/env node
// Find which Bedrock model ID / endpoint reaches a Claude model with your AWS
// credentials. Sends one 16-token request per candidate and prints the outcome.
//   node harness/bedrock-probe.mjs [base-name]      (default: claude-haiku-5-5)
import AnthropicBedrock, { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';

const base = process.argv[2] || 'claude-haiku-5-5';
const candidates = [
  ['runtime', `global.anthropic.${base}`],
  ['runtime', `us.anthropic.${base}`],
  ['runtime', `anthropic.${base}`],
  ['mantle', `anthropic.${base}`],
];
console.log(`region: ${process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '(not set)'}`);
for (const [endpoint, model] of candidates) {
  const client = endpoint === 'mantle' ? new AnthropicBedrockMantle({}) : new AnthropicBedrock({});
  try {
    const msg = await client.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] });
    console.log(`✓ ${endpoint.padEnd(8)} ${model}  → ${msg.content.find((b) => b.type === 'text')?.text?.trim()} (stop: ${msg.stop_reason})`);
  } catch (e) {
    console.log(`✗ ${endpoint.padEnd(8)} ${model}  → ${e.status ?? ''} ${String(e.message).split('\n')[0].slice(0, 140)}`);
  }
}
