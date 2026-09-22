import { BotIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon, EllipsisIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { agentName, useAgentManagement } from "../agents/AgentManagement";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
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
          aria-label="Create an agent"
          className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => void navigate({ to: "/assistants", search: { create: true } })}
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
  const { isMobile, setOpenMobile } = useSidebar();
  const closeAfterNavigation = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  const management = useAgentManagement(environmentId, closeAfterNavigation);
  const { query, act, pending, error } = management;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const threadIds = threads
    .filter((thread) => thread.environmentId === environmentId)
    .map((thread) => `${thread.id}:${thread.session?.status}`)
    .join("|");
  const refresh = query.refresh;
  useEffect(() => {
    if (threadIds !== undefined) refresh();
  }, [threadIds, refresh]);
  async function open(id?: string) {
    await act(id ? { type: "open", id } : { type: "open-main" }, true);
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
          <div
            key={assistant.id}
            className="group/agent relative"
            onContextMenu={(event) => {
              event.preventDefault();
              void management.openMenu(assistant, { x: event.clientX, y: event.clientY });
            }}
            onKeyDown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                void management.openMenu(assistant, { x: rect.right, y: rect.bottom });
              }
            }}
          >
            <button
              aria-current={selected ? "page" : undefined}
              disabled={pending}
              onClick={() => void open(assistant.id)}
              className={`flex h-[4.875rem] w-full cursor-pointer items-center gap-2 rounded-md pl-2 pr-9 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 ${selected ? "bg-sidebar-row-active text-sidebar-foreground" : "text-sidebar-foreground hover:bg-sidebar-row-hover"}`}
            >
              <BotIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{agentName(assistant)}</span>
                <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                  {assistant.kind === "main"
                    ? "Across projects"
                    : assistant.projectLinked === false
                      ? "No project"
                      : (projectNames.get(assistant.projectId) ?? "Project unavailable")}
                </span>
              </span>
              {status && (
                <span className="shrink-0 text-[10px] text-muted-foreground">{status}</span>
              )}
            </button>
            <button
              aria-label={`Actions for ${agentName(assistant)}`}
              disabled={pending}
              className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                void management.openMenu(assistant, { x: rect.right, y: rect.bottom });
              }}
            >
              <EllipsisIcon className="size-4" />
            </button>
          </div>
        );
      })}
      {query.data && !profiles.some((assistant) => assistant.kind === "main") && (
        <button
          className="flex h-[4.875rem] w-full cursor-pointer items-center gap-2 rounded-md pl-2 pr-9 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
          disabled={pending}
          onClick={() => void open()}
        >
          <BotIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">Main agent</span>
            <span className="block truncate text-[11px] leading-4 text-muted-foreground">
              Across projects
            </span>
          </span>
        </button>
      )}
      {management.dialogs}
      {(error || query.error) && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error ?? query.error}
        </p>
      )}
    </div>
  );
}
