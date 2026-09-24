import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { assistantTaskStatus } from "@t3tools/client-runtime/state/assistants";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, EllipsisIcon, ListIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useProjects, useThreadShells } from "../../state/entities";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import { Sheet, SheetPopup, SheetTitle, SheetDescription } from "../ui/sheet";
import { agentName, useAgentManagement } from "./AgentManagement";
import { agentConversationIds, agentForConversation } from "./agentThreads";

export function AgentChatHeader({
  environmentId,
  threadId,
  children,
  rightPanelOpen,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  children: ReactNode;
  rightPanelOpen: boolean;
}) {
  const management = useAgentManagement(environmentId);
  const { query, act, pending, error } = management;
  const profiles = query.data?.assistants ?? [];
  const agent = agentForConversation(profiles, threadId);
  const task = query.data?.tasks.find((task) => task.threadId === threadId);
  const coordinator = task
    ? profiles.find((profile) => profile.id === task.assistantId)
    : undefined;
  const [threadsOpen, setThreadsOpen] = useState(false);
  const navigate = useNavigate();
  const threads = useThreadShells().filter((thread) => thread.environmentId === environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const activity = threads
    .map(
      (thread) =>
        `${thread.id}:${thread.session?.status}:${thread.hasPendingApprovals}:${thread.hasPendingUserInput}`,
    )
    .join("|");
  const { refresh } = query;
  useEffect(() => {
    if (activity !== undefined) refresh();
  }, [activity, refresh]);
  async function openThread(id: ThreadId) {
    await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId: id } });
    setThreadsOpen(false);
  }
  if (!agent)
    return (
      <>
        {coordinator && (
          <Button
            className="no-drag max-w-40 shrink-0"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => void act({ type: "open", id: coordinator.id }, true)}
            title={`Back to ${agentName(coordinator)}`}
          >
            <BotIcon className="size-4 shrink-0" />
            <span className="truncate">{agentName(coordinator)}</span>
          </Button>
        )}
        {children}
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </>
    );
  const tasks = query.data?.tasks.filter((task) => task.assistantId === agent.id) ?? [];
  const projectName =
    agent.kind === "main"
      ? "Across projects"
      : agent.projectLinked === false
        ? "No project"
        : (projects.find((project) => project.id === agent.projectId)?.title ??
          "Project unavailable");
  return (
    <>
      <div
        className={`no-drag flex min-w-0 flex-1 items-center gap-2 ${rightPanelOpen ? "" : "pr-[calc(--spacing(18)+1px)] sm:pr-[calc(--spacing(14)+1px)]"}`}
      >
        <BotIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{agentName(agent)}</h1>
          <p className="truncate text-[11px] text-muted-foreground">
            {projectName}
            {agent.paused ? " · Paused" : ""}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setThreadsOpen(true)}>
          <ListIcon className="size-4" />
          Threads
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost" size="icon" aria-label={`Actions for ${agentName(agent)}`} />
            }
          >
            <EllipsisIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={pending}
              onClick={() => management.setDialog({ kind: "edit", agent })}
            >
              Edit agent
            </MenuItem>
            <MenuItem
              disabled={pending}
              onClick={() => void act({ type: "open", id: agent.id, fresh: true }, true)}
            >
              Start a new conversation
            </MenuItem>
            <MenuItem
              disabled={pending}
              onClick={() => void act({ type: "pause", id: agent.id, paused: !agent.paused })}
            >
              {agent.paused ? "Resume coordination" : "Pause coordination"}
            </MenuItem>
            <MenuItem
              disabled={pending}
              variant="destructive"
              onClick={() => management.setDialog({ kind: "remove", agent })}
            >
              Remove agent
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => management.setDialog({ kind: "create" })}>
              Create an agent
            </MenuItem>
            <MenuItem onClick={() => management.setDialog({ kind: "defaults" })}>
              Defaults for new agents
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {management.dialogs}
      <Sheet open={threadsOpen} onOpenChange={setThreadsOpen}>
        <SheetPopup side="right" className="w-full sm:max-w-md">
          <div className="border-b border-border p-5 pr-12">
            <SheetTitle>Threads</SheetTitle>
            <SheetDescription>{agentName(agent)}</SheetDescription>
          </div>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
            {query.error && (
              <div role="alert">
                <p className="text-sm text-destructive">{query.error}</p>
                <Button variant="ghost" onClick={refresh}>
                  Try again
                </Button>
              </div>
            )}
            <section aria-label="Conversations">
              <h2 className="mb-2 text-sm font-medium">Conversations</h2>
              <ul className="space-y-1">
                {agentConversationIds(agent).map((id, index) => {
                  const thread = threads.find((thread) => thread.id === id);
                  return (
                    <li key={id}>
                      <button
                        className={`w-full rounded-md p-3 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring ${id === threadId ? "bg-accent" : ""}`}
                        aria-current={id === threadId ? "page" : undefined}
                        onClick={() => void openThread(id)}
                      >
                        <span className="block truncate">
                          {thread?.title ?? `Conversation ${index + 1}`}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {thread?.hasPendingApprovals || thread?.hasPendingUserInput
                            ? "Needs you"
                            : thread?.session?.status === "running" ||
                                thread?.session?.status === "starting"
                              ? "Working"
                              : id === agent.threadId
                                ? "Latest conversation"
                                : "Previous conversation"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section aria-label="Tasks">
              <h2 className="mb-2 text-sm font-medium">Tasks</h2>
              {tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Tasks delegated by this agent will appear here.
                </p>
              ) : (
                <ul className="space-y-1">
                  {tasks.map((task) => {
                    const live =
                      threads.find((thread) => thread.id === task.threadId) ?? task.thread;
                    const status = assistantTaskStatus({ ...task, thread: live });
                    const project = projects.find((project) => project.id === live?.projectId);
                    return (
                      <li key={task.threadId} className="flex items-center gap-1">
                        <button
                          className="min-w-0 flex-1 rounded-md p-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                          onClick={() => void openThread(task.threadId)}
                        >
                          <span className="block truncate text-sm">{task.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {status.label}
                            {project ? ` · ${project.title}` : ""}
                          </span>
                        </button>
                        {status.canStop && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            aria-label={`Stop ${task.title}`}
                            onClick={() => void act({ type: "stop-task", threadId: task.threadId })}
                          >
                            Stop
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
}
