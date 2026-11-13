// OpenCode's own response schemas (`@opencode/schema`, Effect Schema), usable
// from plain Node: the tests decode what the routes serve with the decoder the
// OpenCode generated client is built from, `onExcessProperty: 'error'`
// included, so a field OpenCode's schema does not know fails the test.
//
// `effect` is a dependency of `@opencode/schema`, not of this package, so it
// is resolved next to the schema instead of being imported by name.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const loadOpencodeSchemas = async () => {
  const modelUrl = import.meta.resolve('@opencode/schema/model');
  const effectPath = createRequire(fs.realpathSync(fileURLToPath(modelUrl))).resolve('effect');
  const { Schema } = await import(pathToFileURL(effectPath).href);
  const load = async (name) => import(import.meta.resolve(`@opencode/schema/${name}`));

  const [model, provider, agent, skill, command, mcp, integration, plugin, credential, project, location, vcs, config, configShell] = await Promise.all([
    load('model'), load('provider'), load('agent'), load('skill'), load('command'), load('mcp'), load('integration'),
    load('plugin'), load('credential'), load('project'), load('location'), load('vcs'), load('config'), load('config/shell'),
  ]);

  const strict = (schema) => {
    const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' });
    return (value) => decode(value);
  };
  const each = (schema) => strict(Schema.Array(schema));

  return {
    model: each(model.Model.Info),
    modelOne: strict(model.Model.Info),
    provider: each(provider.Provider.Info),
    agent: each(agent.Agent.Info),
    agentOne: strict(agent.Agent.Info),
    skill: each(skill.Skill.Info),
    command: each(command.Command.Info),
    mcp: each(mcp.Mcp.Server),
    integration: each(integration.Integration.Info),
    plugin: each(plugin.Plugin.Info),
    credential: each(credential.Credential.Entry),
    project: each(project.Project.Info),
    location: strict(location.Location.PublicInfo),
    vcs: strict(vcs.Vcs.Info),
    branches: strict(vcs.Vcs.BranchList),
    config: each(config.Config.Entry),
    configShell: each(configShell.ConfigShell.Option),
  };
};
