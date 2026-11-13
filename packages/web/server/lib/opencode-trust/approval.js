export const PI_APPROVE_FLAG = '--approve';
export const PI_NO_APPROVE_FLAG = '--no-approve';

/**
 * The project-trust flag for a Pi child that starts in `directory`. Pi RPC
 * cannot ask, and a flag overrides Pi's own `trust.json`, so this answer is
 * the only trust decision a child gets: `--approve` when the folder runs
 * nothing or its current configuration is trusted, `--no-approve` otherwise,
 * and also when the check itself fails. The assessment is read fresh, right
 * before the child starts.
 *
 * @param {string} directory
 * @param {{ assess: (directory: string, options?: { fresh?: boolean }) => Promise<{ trusted: boolean }> }} openCodeTrust
 * @returns {Promise<'--approve' | '--no-approve'>}
 */
export const approvalFlagFor = async (directory, openCodeTrust) => {
  try {
    const { trusted } = await openCodeTrust.assess(directory, { fresh: true });
    return trusted ? PI_APPROVE_FLAG : PI_NO_APPROVE_FLAG;
  } catch {
    return PI_NO_APPROVE_FLAG;
  }
};
