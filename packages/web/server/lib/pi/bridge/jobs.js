// The non-shell jobs `GET /api/experimental/job` lists: a subagent's child run,
// whether a model called the subagent tool or a command with `subagent: true`
// started it. OpenCode keeps such a job while it runs and reports how it ended;
// the run's own terminal wire event is the authority, so a child stopped by an
// interrupt is marked interrupted without the caller having to remember it.
//
// Finished jobs stay for a short window, as the shell store's records do, so a
// status reader that polls a second later still sees how a run ended.

const RETAIN_MS = 5 * 60_000;

const STATUS_OF_EVENT = {
  'session.execution.succeeded': 'completed',
  'session.execution.failed': 'failed',
  'session.execution.interrupted': 'interrupted',
};

/**
 * @param {{ now?: () => number }} [options]
 */
export const createJobRegistry = ({ now = () => Date.now() } = {}) => {
  /** childSessionID -> job */
  const jobs = new Map();

  const prune = () => {
    const cutoff = now() - RETAIN_MS;
    for (const [id, job] of jobs) {
      if (job.time.ended !== undefined && job.time.ended < cutoff) jobs.delete(id);
    }
  };

  return {
    /** A child run just started. `sessionID` is the parent the job belongs to. */
    start({ parentSessionID, childSessionID, agent, description }) {
      jobs.set(childSessionID, {
        kind: 'subagent',
        id: childSessionID,
        sessionID: parentSessionID,
        childSessionID,
        status: 'running',
        agent,
        ...(description ? { title: description, description } : {}),
        time: { started: now() },
      });
    },

    /** End a job whose child never got to run, so it does not stay "running" forever. */
    finish(childSessionID, status) {
      const job = jobs.get(childSessionID);
      if (!job || job.status !== 'running') return;
      job.status = status;
      job.time.ended = now();
    },

    /** The child's terminal wire event ends its job, whichever call path started it. */
    onWireEvent(sessionID, wire) {
      const job = jobs.get(sessionID);
      if (!job || job.status !== 'running') return;
      const status = STATUS_OF_EVENT[wire?.type];
      if (!status) return;
      job.status = status;
      job.time.ended = now();
    },

    list() {
      prune();
      return [...jobs.values()].map((job) => ({ ...job, time: { ...job.time } }));
    },
  };
};
