// A deterministic OpenAI-compatible streaming server that stands in for a model.
// The last user message picks the behavior: SLOW streams until aborted, ERR500
// resets the connection, `TOOL:<name>:<json object>` calls that tool with those
// arguments, PWD or anything else with tools calls `bash`.
import http from 'node:http';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const startMockOpenAi = async () => {
  const requests = [];
  const heldResponses = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      if (req.url.endsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* not JSON */ }
      requests.push({ url: req.url, toolNames: (payload.tools ?? []).map((tool) => tool.function?.name), tools: payload.tools ?? [], messages: payload.messages ?? [] });

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      const base = { id: 'mock-1', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
      const choice = (delta, finish = null) => send({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
      const usage = (prompt, completion, extra = {}) => send({ ...base, choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...extra } });

      const messages = payload.messages ?? [];
      const last = messages.at(-1);
      const lastUserContent = messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
      const userText = JSON.stringify(lastUserContent);
      // The unescaped text, for the directive whose JSON arguments the escaped form would mangle.
      const plainUserText = typeof lastUserContent === 'string'
        ? lastUserContent
        : (Array.isArray(lastUserContent) ? lastUserContent.map((part) => part?.text ?? '').join('\n') : '');
      const toolDirective = /TOOL:([A-Za-z0-9_.-]+):(\{.*\})/s.exec(plainUserText);

      if (userText.includes('ERR500')) {
        res.destroy();
        return;
      }
      if (!payload.tools || payload.tools.length === 0) {
        choice({ role: 'assistant', content: '## Goal\nMock summary' });
        choice({}, 'stop');
        usage(50, 5);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (last?.role === 'tool') {
        choice({ role: 'assistant', content: 'Done: ' });
        choice({ content: 'tool said hi' });
        choice({}, 'stop');
        usage(200, 12, { prompt_tokens_details: { cached_tokens: 100 } });
        res.end('data: [DONE]\n\n');
        return;
      }
      if (toolDirective) {
        const [, toolName, toolArguments] = toolDirective;
        choice({ role: 'assistant', content: 'Calling the tool. ' });
        choice({ tool_calls: [{ index: 0, id: 'call_directive', type: 'function', function: { name: toolName, arguments: toolArguments } }] });
        choice({}, 'tool_calls');
        usage(100, 20);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (userText.includes('HOLD')) {
        choice({ role: 'assistant', content: 'waiting ' });
        const finish = () => {
          heldResponses.delete(finish);
          if (res.destroyed) return;
          choice({ content: 'finished' });
          choice({}, 'stop');
          usage(80, 6);
          res.end('data: [DONE]\n\n');
        };
        heldResponses.add(finish);
        res.once('close', () => heldResponses.delete(finish));
        return;
      }
      if (userText.includes('SLOW')) {
        choice({ role: 'assistant', content: 'slow ' });
        for (let i = 0; i < 200 && !res.destroyed; i += 1) {
          await sleep(50);
          choice({ content: 'tick ' });
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      if (userText.includes('PLAIN')) {
        choice({ role: 'assistant', content: 'plain ' });
        choice({ content: 'answer' });
        choice({}, 'stop');
        usage(80, 6);
        res.end('data: [DONE]\n\n');
        return;
      }
      const command = userText.includes('PWD') ? '"pwd"}' : '"echo hi"}';
      choice({ role: 'assistant', reasoning_content: 'Let me think. ' });
      choice({ reasoning_content: 'Use the tool.' });
      choice({ content: 'Running it. ' });
      choice({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":' } }] });
      choice({ tool_calls: [{ index: 0, function: { arguments: command } }] });
      choice({}, 'tool_calls');
      usage(100, 20, { completion_tokens_details: { reasoning_tokens: 8 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    releaseHeld: () => { for (const finish of [...heldResponses]) finish(); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
};
