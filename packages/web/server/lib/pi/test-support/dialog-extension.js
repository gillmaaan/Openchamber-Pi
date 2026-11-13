// A Pi extension that holds every bash call behind a confirm dialog with no
// timeout and no signal: the case that makes Pi's `abort` wait for an answer.
export default function (pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    const allowed = await ctx.ui.confirm('Allow bash?', String(event.input.command));
    return allowed ? undefined : { block: true, reason: 'Denied' };
  });
}
