import { BotIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assistants } from "../../state/assistants";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useSidebar } from "../ui/sidebar";

export function SidebarAssistants({ threads }: { threads: readonly EnvironmentThreadShell[] }) {
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(true);
  return (
    <section aria-label="Agents" className="px-3 pt-3 pb-4">
      <div className="flex items-center justify-between">
        <button
          className="flex min-h-8 items-center gap-1 text-xs font-medium text-sidebar-foreground/70 hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}{" "}
          Agents
        </button>
        <button
          aria-label="Manage agents"
          className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => void navigate({ to: "/assistants" })}
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      {environments.map((environment) => (
        <EnvironmentAssistants
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environments.length > 1 ? environment.label : null}
          threads={threads}
          expanded={expanded}
        />
      ))}
    </section>
  );
}

function EnvironmentAssistants({
  environmentId,
  label,
  threads,
  expanded,
}: {
  environmentId: EnvironmentId;
  label: string | null;
  threads: readonly EnvironmentThreadShell[];
  expanded: boolean;
}) {
  const projects = useProjects();
  const projectNames = useMemo(
    () =>
      new Map(
        projects
          .filter((project) => project.environmentId === environmentId)
          .map((project) => [project.id, project.title]),
      ),
    [projects, environmentId],
  );
  const query = useEnvironmentQuery(assistants.list({ environmentId, input: {} }));
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const threadIds = threads
    .filter((thread) => thread.environmentId === environmentId)
    .map((thread) => `${thread.id}:${thread.session?.status}`)
    .join("|");
  const refresh = query.refresh;
  useEffect(() => {
    if (threadIds !== undefined) refresh();
  }, [threadIds, refresh]);
  async function open(id?: string) {
    setPending(id ?? "main");
    setError(null);
    try {
      const result = await runAtomCommand(appAtomRegistry, assistants.act, {
        environmentId,
        input: id ? { type: "open", id } : { type: "open-main" },
      });
      if (result._tag !== "Success") {
        const cause = Cause.squash(result.cause);
        setError(cause instanceof Error ? cause.message : "Could not open agent.");
        return;
      }
      refresh();
      if (result.value.threadId) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: result.value.threadId },
        });
        if (isMobile) setOpenMobile(false);
      }
    } finally {
      setPending(null);
    }
  }
  if (!expanded) return null;
  const profiles = [...(query.data?.assistants ?? [])].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "main" ? -1 : 1,
  );
  return (
    <div className="space-y-0.5">
      {label && <p className="truncate px-2 pt-2 text-xs text-muted-foreground">{label}</p>}
      {profiles.map((assistant) => {
        const current = threads.find(
          (thread) => thread.environmentId === environmentId && thread.id === assistant.threadId,
        );
        const selected = [assistant.threadId, ...(assistant.conversationThreadIds ?? [])].some(
          (threadId) => threadId !== null && pathname.endsWith(`/${environmentId}/${threadId}`),
        );
        const status = assistant.paused
          ? "Paused"
          : current?.hasPendingApprovals || current?.hasPendingUserInput
            ? "Needs you"
            : current?.session?.status === "running" || current?.session?.status === "starting"
              ? "Working"
              : null;
        return (
          <button
            key={assistant.id}
            aria-current={selected ? "page" : undefined}
            disabled={pending !== null}
            onClick={() => void open(assistant.id)}
            className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 ${selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60"}`}
          >
            <BotIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                {assistant.kind === "main" && assistant.name === "Main assistant"
                  ? "Main agent"
                  : assistant.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {assistant.kind === "main"
                  ? "Across projects"
                  : (projectNames.get(assistant.projectId) ?? "Project unavailable")}
              </span>
            </span>
            {status && <span className="shrink-0 text-[10px] text-muted-foreground">{status}</span>}
          </button>
        );
      })}
      {query.data && !profiles.some((assistant) => assistant.kind === "main") && (
        <button
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent/60"
          disabled={pending !== null}
          onClick={() => void open()}
        >
          <BotIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">Main agent</span>
            <span className="block truncate text-xs text-muted-foreground">Across projects</span>
          </span>
        </button>
      )}
      {(error || query.error) && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error ?? query.error}
        </p>
      )}
    </div>
  );
}
