/**
 * Opt-in host installation window. Suppress only operational side effects so
 * verification cannot send owner alerts or replace the sealed runtime.
 * It is deliberately not a transport/message gate: user replies, Ask and live
 * cards retain their ordinary behavior. No audit timestamp is fabricated.
 */
export function runHostOperationalEffect<T>(
  effect: () => T,
  env: NodeJS.ProcessEnv = process.env,
): T | undefined {
  if (env.BOTMUX_MAINTENANCE_MODE === '1') return undefined;
  return effect();
}
