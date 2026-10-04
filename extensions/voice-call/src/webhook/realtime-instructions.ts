export function buildGreetingInstructions(
  baseInstructions: string | undefined,
  greeting: string | undefined,
): string | undefined {
  const trimmedGreeting = greeting?.trim();
  if (!trimmedGreeting) {
    return undefined;
  }
  const intro =
    "Start the call by greeting the caller naturally. Include this greeting in your first spoken reply:";
  return baseInstructions
    ? `${baseInstructions}\n\n${intro} "${trimmedGreeting}"`
    : `${intro} "${trimmedGreeting}"`;
}

export function buildBridgeInstructions(
  instructions: string,
  handlesAgentConsult: boolean,
  agentConsultEnabled: boolean,
): string {
  if (!handlesAgentConsult) {
    return instructions;
  }
  const delegation = agentConsultEnabled
    ? "Use native agent delegation for OpenClaw work."
    : "Agent delegation is unavailable. Handle the conversation from the supplied context and ask the caller about missing facts.";
  return `${instructions}\n\n${delegation} End-call and custom realtime function tools are unavailable in this session; the caller can hang up to end the call.`;
}
