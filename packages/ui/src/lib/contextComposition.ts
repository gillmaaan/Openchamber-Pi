import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

// What fills a session's context besides the conversation: the system prompt,
// instruction files, skills and tool definitions, as the agent reports them
// (packages/web/server/lib/pi/bridge/context-composition.js). The server
// estimates the tokens; this module asks and parses the answer once.

const itemSchema = z.object({
  id: z.string().min(1),
  /** A name from the agent (tool, file path, skill). Empty for the parts of the system prompt, which the UI names by `id`. */
  label: z.string(),
  tokens: z.number().nonnegative(),
  /** Where a custom tool comes from (MCP server, extension file). */
  detail: z.string().optional(),
  text: z.string(),
});

const CATEGORY_IDS = ['system', 'instructions', 'skills', 'builtinTools', 'customTools'] as const;

const categorySchema = z.object({
  id: z.enum(CATEGORY_IDS),
  tokens: z.number().nonnegative(),
  items: z.array(itemSchema),
});

const responseSchema = z.object({
  data: z.object({
    totalTokens: z.number().nonnegative(),
    categories: z.array(categorySchema),
  }),
});

export type ContextCompositionItem = z.infer<typeof itemSchema>;
export type ContextCompositionCategory = z.infer<typeof categorySchema>;
export type ContextComposition = z.infer<typeof responseSchema>['data'];

/** `failed` is any answer that is not a composition: the agent did not respond, or the server has no such route. It is never an empty composition. */
export type ContextCompositionResult =
  | { status: 'ok'; composition: ContextComposition }
  | { status: 'failed' };

export const fetchContextComposition = async (sessionId: string, signal?: AbortSignal): Promise<ContextCompositionResult> => {
  try {
    const response = await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/context-composition`, { signal });
    if (!response.ok) return { status: 'failed' };
    const parsed = responseSchema.safeParse(await response.json());
    return parsed.success ? { status: 'ok', composition: parsed.data.data } : { status: 'failed' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 'failed' };
  }
};
