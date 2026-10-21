export function sessionActivationTarget(session, event = null) {
  const matchingSession = event && event.sessionId !== session?.id ? null : session;
  return {
    projectDir: event?.cwd ?? matchingSession?.projectDir ?? null,
    shellPid: event?.shellPid ?? matchingSession?.shellPid ?? null
  };
}
