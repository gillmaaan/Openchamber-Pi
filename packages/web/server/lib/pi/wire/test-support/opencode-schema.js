// Decoders for the wire shapes, taken from `@opencode/schema` (the package the
// reference server and the UI's client are generated from).
//
// The schemas are Effect schemas and `effect` is not a dependency of this
// workspace, only of `@opencode/schema`. It is loaded from the directory that
// package resolves it in, the way the package itself does, so the decoders run
// against the exact schema instances.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

export const loadWireSchemas = async () => {
  const { SessionMessage } = await import('@opencode/schema');
  const { EventManifest } = await import('@opencode/schema/event-manifest');
  const schemaDir = fs.realpathSync(path.join(webRoot, 'node_modules', '@opencode', 'schema'));
  const effectDir = fs.realpathSync(path.join(schemaDir, '..', '..', 'effect'));
  const { Schema } = await import(pathToFileURL(path.join(effectDir, 'dist', 'index.js')).href);
  const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info);

  return {
    /** Throws a SchemaError when `message` is not a message the server could have served. */
    decodeMessage,
    /**
     * Checks an event the translator produced: a known type, `data` that
     * decodes, and a `durable` flag that matches the definition.
     */
    checkEvent: (event) => {
      const definition = EventManifest.Server.get(event.type);
      if (!definition) throw new Error(`Unknown wire event type ${event.type}`);
      Schema.decodeUnknownSync(definition.data)(event.data);
      const durable = event.durable === true;
      if (durable !== (definition.durability === 'durable')) {
        throw new Error(`${event.type} is ${definition.durability} on the wire but durable=${durable} here`);
      }
    },
  };
};
