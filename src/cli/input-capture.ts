export function parseInputCaptureCommand(args: string[]) {
  const operation = args[0];
  if (!['register', 'inspect', 'revoke'].includes(operation)) throw new Error('Expected register, inspect or revoke');
  const allowed = new Set(['--bot', '--session', ...(operation === 'register'
    ? ['--plugin', '--request', '--ref', '--input-anchor'] : ['--binding', ...(operation === 'revoke' ? ['--revision'] : [])])]);
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.has(key) || flags.has(key) || !value || value.startsWith('--')
      || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid input-capture arguments');
    flags.set(key, value);
  }
  if ([...allowed].some(key => key !== '--input-anchor' && !flags.has(key))) throw new Error('All input-capture identity flags are required');
  if (operation === 'revoke' && (!/^[1-9][0-9]*$/.test(flags.get('--revision')!)
    || !Number.isSafeInteger(Number(flags.get('--revision'))))) throw new Error('Invalid binding revision');
  const larkAppId = flags.get('--bot')!;
  return { larkAppId, path: `/api/sessions/${encodeURIComponent(flags.get('--session')!)}/input-capture`,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      larkAppId, operation, ...(operation === 'register' ? {
        pluginId: flags.get('--plugin'), requestId: flags.get('--request'), providerRef: flags.get('--ref'),
        ...(flags.has('--input-anchor') ? { inputAnchor: flags.get('--input-anchor') } : {}),
      } : { bindingId: flags.get('--binding'), ...(operation === 'revoke' ? { expectedRevision: Number(flags.get('--revision')) } : {}) }),
    }) } };
}
