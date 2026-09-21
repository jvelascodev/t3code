import { WS_METHODS, type AssistantTask } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createAssistantAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "assistants:list",
    tag: WS_METHODS.assistantsList,
    staleTimeMs: 0,
  });
  const act = createEnvironmentRpcCommand(runtime, {
    label: "assistants:act",
    tag: WS_METHODS.assistantsAct,
  });
  return { list, act };
}

export function assistantTaskStatus(task: Pick<AssistantTask, "stopped" | "thread">) {
  const thread = task.thread;
  const label = task.stopped
    ? "Stopped"
    : thread?.hasPendingApprovals
      ? "Needs approval"
      : thread?.hasPendingUserInput
        ? "Needs your input"
        : thread?.session?.status === "error"
          ? "Failed"
          : thread?.session?.status === "running" ||
              thread?.session?.status === "starting" ||
              thread?.latestTurn?.state === "running"
            ? "Working"
            : thread?.session
              ? "Review result"
              : "Status unavailable";
  return { label, canStop: !task.stopped && (label === "Working" || label.startsWith("Needs")) };
}
