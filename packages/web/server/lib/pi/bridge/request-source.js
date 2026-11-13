// Which assistant message holds the tool call a permission request or a form
// belongs to. The translator that numbers the messages supplies the answer
// (`resolveSource`); a request that cannot be linked is still shown, so a
// lookup that fails or takes too long costs the card its link and nothing else.

export const SOURCE_WAIT_MS = 2_000;

/**
 * @param {(sessionID: string, toolCallId: string) => ({ messageID?: string } | undefined) | Promise<{ messageID?: string } | undefined>} resolveSource
 * @returns {Promise<{ messageID?: string } | undefined>}
 */
export const lookupSource = async (resolveSource, sessionID, toolCallId, waitMs = SOURCE_WAIT_MS) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(resolveSource(sessionID, toolCallId)),
      new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};
