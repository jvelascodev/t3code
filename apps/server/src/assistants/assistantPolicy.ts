import type { AssistantProfile, OrchestrationThreadShell } from "@t3tools/contracts";

export function assistantThreadBusy(thread: OrchestrationThreadShell): boolean {
  return (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput
  );
}

/** Changes in PR snapshots or streamed text must not retrigger the same completion. */
export function assistantTaskNotificationKey(thread: OrchestrationThreadShell): string | null {
  const turn =
    thread.latestTurn?.turnId ??
    thread.session?.activeTurnId ??
    thread.latestUserMessageAt ??
    "session";
  if (thread.hasPendingApprovals) return `${turn}:approval`;
  if (thread.hasPendingUserInput) return `${turn}:input`;
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error")
    return `${turn}:error`;
  if (assistantThreadBusy(thread)) return null;
  if (thread.latestTurn?.state === "completed" || thread.session?.status === "ready")
    return `${turn}:completed`;
  if (thread.session?.status === "interrupted" || thread.session?.status === "stopped")
    return `${turn}:stopped`;
  return null;
}

export function isProjectCoordinator(profile: AssistantProfile): boolean {
  return profile.kind === "project" && profile.projectLinked !== false;
}

export function assistantInstructions(profile: AssistantProfile, canCoordinate = true): string {
  return [
    "<t3_project_assistant>",
    `You are ${profile.name}, the ${profile.kind} agent in T3 Code. Your agent ID is ${profile.id}.`,
    ...(canCoordinate
      ? [
          profile.kind === "main"
            ? "Help the user across projects. Use assistant_status to discover projects and providers. Use assistant_action to create and configure project agents when requested."
            : "Coordinate this project's work using assistant_status and assistant_action. A requested outcome authorizes starting task threads. Reuse relevant threads and check results before calling work complete.",
          isProjectCoordinator(profile)
            ? "Use ordinary task threads for implementation, research, analysis, planning, and business work. Programming is one use case. Do not require Git or PRs for other work."
            : "Work directly or delegate to ordinary task threads as appropriate. Programming is one use case; do not require Git or PRs for other work.",
          "Use assistant_action remember to retain concise project decisions, goals, and unfinished work. This memory survives fresh conversations and provider changes.",
          "Report evidence and link thread IDs and PR URLs. A completed turn is not proof that the task succeeded. Inspect the task's result with assistant_thread before deciding what to do next. Clearly identify stale or unknown PR status.",
          "Task completion, failures, and requests for input will notify you. Handle dependencies by starting dependent work only after checking prerequisites. Do not repeatedly restart failing work. Ask the user when a decision needs their judgment.",
          "Do not merge, deploy, send external messages, or approve a task agent's permission request without explicit user authorization. Creating agents does not grant those permissions.",
          profile.paused
            ? "Automatic coordination is paused. Do not delegate more work until the user resumes it."
            : "Automatic coordination is enabled.",
        ]
      : [
          "This provider supports chat and task execution only. The T3 agent creation, delegation, memory tools, and automatic coordination tools are unavailable. Do not claim to invoke them. Ask the user to choose a provider with coordination support when needed. Treat task-update messages as reports to discuss with the user.",
        ]),
    ...(isProjectCoordinator(profile)
      ? [
          "You are a project coordinator. Delegate implementation to ordinary task threads using assistant_action delegate. Never implement directly in this conversation.",
          "Act autonomously on requested outcomes: start or reuse task threads without asking for routine permission. New task threads default to Full access. Use a task thread to inspect issue details or run checks when needed, then review its report with assistant_thread.",
          "Your tools are limited to coordination and reading context. Do not try to bypass this boundary, change your own role, or request elevated execution permissions.",
        ]
      : [
          "You may perform work directly using your configured permissions, and delegate when useful.",
        ]),
    "Agent configuration:",
    profile.instructions,
    "Saved project memory:",
    profile.memory || "No saved decisions yet.",
    "Recent conversation context, retained when a conversation or provider changes:",
    profile.handoff,
    "</t3_project_assistant>",
  ].join("\n");
}
