import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapGuidance, addGuidance, missingVersionedClient } from './browserjack-guidance.mjs';

test('reset and tool listing carry stable guidance without changing schemas', () => {
  const guidance = bootstrapGuidance('/Applications/ChatGPT.app');
  assert.match(guidance, /file:\/\/\/Applications\/ChatGPT.app/);
  assert.doesNotMatch(guidance, /chrome\/26\./);
  const schema = {type: 'object', properties: {code: {type: 'string'}}};
  const listing = addGuidance({id: 2, result: {tools: [{name: 'js', inputSchema: schema}]}}, {method: 'tools/list'}, guidance);
  assert.deepEqual(listing.result.tools[0].inputSchema, schema);
  assert.ok(listing.result.tools[0].description.includes(guidance));
  const reset = {id: 3, result: {content: [{type: 'text', text: 'reset'}]}};
  assert.equal(addGuidance(reset, {method: 'tools/call', params: {name: 'js_reset'}}, guidance).result.content.length, 2);
  const failed = {result: {isError: true}};
  assert.equal(addGuidance(failed, {method: 'tools/call', params: {name: 'js_reset'}}, guidance), failed);
});

test('removed versioned imports are rejected while present and unrelated imports pass', async () => {
  const request = code => ({method: 'tools/call', params: {name: 'js', arguments: {code}}});
  const code = 'await import("file:///tmp/test/.codex/plugins/cache/openai-bundled/chrome/26.901.20858/scripts/browser-client.mjs")';
  assert.equal(await missingVersionedClient(request(code), async () => false), true);
  assert.equal(await missingVersionedClient(request(code), async () => true), false);
  assert.equal(await missingVersionedClient(request('await import("node:path")'), async () => false), false);
});
