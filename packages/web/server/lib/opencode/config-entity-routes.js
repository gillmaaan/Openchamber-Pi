import os from 'node:os';

import { registerAgentConfigRoutes } from '../pi/config-routes/agents.js';
import { registerCommandConfigRoutes } from '../pi/config-routes/commands.js';
import { registerMcpConfigRoutes } from '../pi/config-routes/mcp.js';

export const registerConfigEntityRoutes = (app, dependencies) => {
  const {
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    piAgentStore,
    onPiAgentsChanged,
    piCommandStore,
    onPiCommandsChanged,
    piMcpStore,
    piMcpStatusCache,
    piAgentDir,
    piRunPi,
    listSnippets,
    getSnippet,
    createSnippet,
    updateSnippet,
    deleteSnippet,
    expandSnippets,
    previewSnippet,
  } = dependencies;

  registerAgentConfigRoutes(app, {
    store: piAgentStore,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    onChanged: onPiAgentsChanged,
  });

  registerCommandConfigRoutes(app, {
    store: piCommandStore,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    onChanged: onPiCommandsChanged,
  });

  // MCP servers live in Pi's own `mcp.json`; the same routes also serve live
  // status, connect/disconnect and `pi mcp login`.
  if (piMcpStore) {
    registerMcpConfigRoutes(app, {
      store: piMcpStore,
      statusCache: piMcpStatusCache,
      resolveOptionalProjectDirectory,
      agentDir: piAgentDir ?? (() => os.homedir()),
      runPi: piRunPi,
    });
  }

  app.get('/api/config/snippets', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      res.json(listSnippets(directory));
    } catch (error) {
      console.error('[API:GET /api/config/snippets] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to list snippets' });
    }
  });

  app.post('/api/config/snippets/expand', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      // `content` asks for a snippet body's preview, `text` for a prompt's expansion.
      const content = req.body?.content;
      res.json({ text: content !== undefined ? previewSnippet(String(content), directory) : expandSnippets(req.body?.text ?? '', directory) });
    } catch (error) {
      console.error('[API:POST /api/config/snippets/expand] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to expand snippets' });
    }
  });

  app.get('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const snippet = getSnippet(name, directory);
      if (!snippet) {
        return res.status(404).json({ error: `Snippet "${name}" not found` });
      }
      res.json(snippet);
    } catch (error) {
      console.error('[API:GET /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('Snippet name')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to get snippet' });
    }
  });

  app.post('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const snippet = createSnippet(name, req.body || {}, directory, req.body?.scope || 'global');
      res.json({ success: true, snippet });
    } catch (error) {
      console.error('[API:POST /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('already exists')) {
        return res.status(409).json({ error: error.message });
      }
      if (error.message?.includes('Snippet name') || error.message?.includes('Project directory')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to create snippet' });
    }
  });

  app.patch('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      res.json({ success: true, snippet: updateSnippet(name, req.body || {}, directory) });
    } catch (error) {
      console.error('[API:PATCH /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      if (error.message?.includes('already exists')) {
        return res.status(409).json({ error: error.message });
      }
      if (error.message?.includes('Snippet name') || error.message?.includes('Project directory')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to update snippet' });
    }
  });

  app.delete('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      deleteSnippet(name, directory);
      res.json({ success: true });
    } catch (error) {
      console.error('[API:DELETE /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      if (error.message?.includes('Snippet name')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to delete snippet' });
    }
  });
};
