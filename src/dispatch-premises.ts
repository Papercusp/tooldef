/** Reserved dispatch argument, peeled once for every transport before tool validation. */
export function prepareDispatchPremises(input: unknown, toolName: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.prototype.hasOwnProperty.call(input, 'premises')) {
    return { input, provided: false, refs: [] as string[], error: undefined as string | undefined };
  }
  const { premises, ...args } = input as Record<string, unknown>;
  const valid = Array.isArray(premises) && premises.length <= 32 &&
    premises.every(ref => typeof ref === 'string' && ref.trim().length > 0 && ref.length <= 500);
  if (!valid) return { input: args, provided: true, refs: [] as string[],
    error: 'premises must be an array of at most 32 non-empty fact keys or fact references' };
  const refs = [...new Set((premises as string[]).map(ref => ref.trim()))];
  // An envelope's target must enforce its outer premises, too.
  if (toolName === 'tools:invoke' && args.args && typeof args.args === 'object' && !Array.isArray(args.args)) {
    const nested = args.args as Record<string, unknown>;
    args.args = { ...nested, premises: Object.prototype.hasOwnProperty.call(nested, 'premises')
      ? Array.isArray(nested.premises) ? [...refs, ...nested.premises] : nested.premises
      : refs };
  }
  return { input: args, provided: true, refs, error: undefined as string | undefined };
}
