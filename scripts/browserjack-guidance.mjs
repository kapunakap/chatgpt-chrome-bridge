import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export function bootstrapGuidance(appPath) {
  const url = pathToFileURL(join(appPath, 'Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs')).href;
  return `Current verified browser bootstrap: var client = await import(${JSON.stringify(url)}); globalThis.agent = await client.setupBrowserRuntime(); Use this URL instead of versioned plugin-cache paths from earlier instructions.`;
}

export function addGuidance(message, request, guidance) {
  if (!message?.result || message.error) return message;
  if (request?.method === 'tools/list' && Array.isArray(message.result.tools)) {
    return {...message, result: {...message.result, tools: message.result.tools.map(tool => tool.name === 'js' ? {...tool, description: `${tool.description ?? ''}\n\n${guidance}`} : tool)}};
  }
  if (request?.method === 'tools/call' && request.params?.name === 'js_reset' && message.result.isError !== true) {
    return {...message, result: {...message.result, content: [...(message.result.content ?? []), {type: 'text', text: guidance}]}};
  }
  return message;
}

export async function missingVersionedClient(message, exists = async path => access(path).then(() => true, () => false)) {
  if (message?.method !== 'tools/call' || message.params?.name !== 'js') return false;
  const code = message.params.arguments?.code;
  if (typeof code !== 'string') return false;
  for (const match of code.matchAll(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g)) {
    const value = match[2];
    if (!/\/plugins\/cache\/openai-bundled\/chrome\/\d[\w.-]*\/scripts\/browser-client\.mjs$/.test(value)) continue;
    const path = value.startsWith('file:') ? fileURLToPath(value) : value;
    if (path.startsWith('/') && !await exists(path)) return true;
  }
  return false;
}
