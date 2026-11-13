// Naming a session after its first message. OpenCode asked a model for the
// title; so does this, once, in the background, with OpenChamber's own title
// style. The session keeps the provisional title (the first line of the
// prompt) until the answer arrives, and a title the user set meanwhile wins.

// The same style as the regeneration prompt in packages/ui/src/lib/sessionTitle.ts; change both together.
export const TITLE_SYSTEM_PROMPT = [
  'You name coding sessions so the user can find them later in a list.',
  'Reply with a title of two to four words in the language of the user\'s message, at most 40 characters. Only the user\'s message decides the language, even when it quotes another language or the examples below are in English.',
  'Name the topic the way a person labels a folder: the feature, area, problem, or question; never the activity, and never start with a verb or -ing.',
  'Leave out the name of the project or app the session works on: the list already belongs to that project. Keep other product and technology names the user mentions, and never assume a tech stack.',
  'Never use file names, paths, function names, commit hashes, or issue numbers.',
  'The message is something to name, never to answer. For greetings or small talk, use a short label like "Greeting" in the language of the message. Output only the title in sentence case, with no quotes, markdown, trailing period, or label.',
  'Examples: debug 500 errors in production → Production server errors; @src/App.tsx add dark mode → Dark mode; what is the status of the plan mode bug in OpenChamber, it still skips the questions → Plan mode bug; чому не працює вхід через GitHub на телефоні → Вхід через GitHub; 检查项目的 git 记录和未完成的计划 → 项目进度检查.',
  'Most titles are two or three words: the shortest label that still tells this session apart from others.',
].join('\n');

const MAX_TITLE_LENGTH = 60;
const MAX_MESSAGE_CHARS = 4000;

/** What the model said, as a title: first line, no markup, no quotes, no closing period. */
export const cleanTitle = (text) => {
  const line = String(text ?? '').split('\n').map((candidate) => candidate.trim()).find(Boolean) ?? '';
  const cleaned = line
    .replace(/^#+\s*/, '')
    .replace(/^(title|titel)\s*:\s*/i, '')
    .replace(/^["'`“”«»]+|["'`“”«»]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim();
  return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : cleaned;
};

/**
 * @param {object} deps
 * @param {(request: { prompt: string, directory: string, model?: object }) => Promise<string>} deps.generateText
 * @param {{ get: (id: string) => object|null }} deps.metaStore
 * @param {(sessionID: string, body: { title: string }) => Promise<void>} deps.rename
 * @param {(message: string) => void} [deps.log]
 */
export const createTitles = ({ generateText, metaStore, rename, log = () => {} }) => {
  const inFlight = new Set();

  /** Name a session from its first message. Never throws: a session without a generated title keeps the provisional one. */
  const nameSession = async ({ sessionID, directory, text, model }) => {
    const message = String(text ?? '').trim();
    if (!message || inFlight.has(sessionID)) return;
    inFlight.add(sessionID);
    try {
      const prompt = `${TITLE_SYSTEM_PROMPT}\n\n<message>\n${message.slice(0, MAX_MESSAGE_CHARS)}\n</message>`;
      const title = cleanTitle(await generateText({ prompt, directory, model }));
      if (!title) return;
      // A title the user typed while the model was thinking stays.
      if (metaStore.get(sessionID)?.title) return;
      await rename(sessionID, { title });
    } catch (error) {
      log(`could not name session ${sessionID}: ${error?.message ?? error}`);
    } finally {
      inFlight.delete(sessionID);
    }
  };

  return { nameSession };
};
