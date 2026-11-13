// A minimal MCP server over stdio for tests: speaks `initialize`, `tools/list`
// and `tools/call` as newline-delimited JSON-RPC, with one tool, `echo`.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tiny', version: '1.0.0' }, instructions: 'A tiny test server.' } });
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [{ name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (method === 'tools/call') {
    send({ id, result: { content: [{ type: 'text', text: `echo: ${params?.arguments?.text ?? ''}` }] } });
  } else if (method === 'ping') {
    send({ id, result: {} });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
