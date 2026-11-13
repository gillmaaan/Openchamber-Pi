// An isolated Pi installation for tests: its own agent directory, its own HOME,
// and one model served by the mock OpenAI server. Nothing here reads the
// developer's real ~/.pi.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPiChildEnv } from '../launch.js';

export const createPiFixture = ({ mockPort, extraSettings = {} }) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oc-pi-fixture-'));
  const agentDir = path.join(root, 'agent');
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  for (const dir of [agentDir, home, project]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      mock: {
        name: 'Mock',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        api: 'openai-completions',
        apiKey: 'test-key',
        models: [{ id: 'mock-model', name: 'Mock Model', reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 4096 }],
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'mock',
    defaultModel: 'mock-model',
    defaultThinkingLevel: 'low',
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 50 },
    ...extraSettings,
  }));

  const env = buildPiChildEnv(
    { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    { PI_CODING_AGENT_DIR: agentDir, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
  );

  return {
    root,
    agentDir,
    home,
    project,
    sessionsDir: path.join(agentDir, 'sessions'),
    env,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
};
