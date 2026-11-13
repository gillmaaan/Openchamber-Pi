// OpenCode's own schemas for the workspace routes (`@opencode/schema`, Effect
// Schema), usable from plain Node: the tests decode what the routes serve with
// the decoder the generated client is built from, `onExcessProperty: 'error'`
// included, so a field OpenCode's schema does not know fails the test. See
// opencode-schema.js for why `effect` is resolved next to the schema.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const loadWorkspaceSchemas = async () => {
  const modelUrl = import.meta.resolve('@opencode/schema/model');
  const effectPath = createRequire(fs.realpathSync(fileURLToPath(modelUrl))).resolve('effect');
  const { Schema } = await import(pathToFileURL(effectPath).href);
  const load = (name) => import(import.meta.resolve(`@opencode/schema/${name}`));
  const [shell, job, vcs, filesystem] = await Promise.all([load('shell'), load('job'), load('vcs'), load('filesystem')]);

  const strict = (schema) => {
    const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' });
    return (value) => decode(value);
  };
  const each = (schema) => strict(Schema.Array(schema));

  return {
    shellInfo: strict(shell.Shell.Info),
    shellInfos: each(shell.Shell.Info),
    shellOutput: strict(shell.Shell.Output),
    jobs: each(job.Job.Info),
    fileStatuses: each(vcs.Vcs.FileStatus),
    base: strict(vcs.Vcs.Base),
    entries: each(filesystem.FileSystem.Entry),
    written: strict(filesystem.FileSystem.Write),
  };
};
