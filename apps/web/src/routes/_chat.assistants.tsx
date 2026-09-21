import { supportsAgentCoordination, AGENT_CHAT_ONLY_NOTICE } from "@t3tools/contracts";
import { assistantTaskStatus } from "@t3tools/client-runtime/state/assistants";
import * as Cause from "effect/Cause";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BotIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type AssistantAction,
  type AssistantProfile,
  type ModelSelection,
} from "@t3tools/contracts";
import { assistants } from "../state/assistants";
import { useEnvironments } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

export const Route = createFileRoute("/_chat/assistants")({ component: AssistantsPage });

const selectClass =
  "min-h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

function AssistantsPage() {
  const { environments } = useEnvironments();
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>("");
  const environment =
    environments.find((entry) => entry.environmentId === selectedEnvironment) ?? environments[0];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background">
      <WorkspacePageHeader electron={isElectron}>
        <SidebarTrigger />
        <h1 className="text-sm font-medium">Agents</h1>
        {environments.length > 1 && (
          <select
            aria-label="Environment"
            className={`${selectClass} ml-auto no-drag`}
            value={environment?.environmentId ?? ""}
            onChange={(event) => setSelectedEnvironment(event.target.value)}
          >
            {environments.map((entry) => (
              <option key={entry.environmentId} value={entry.environmentId}>
                {entry.label}
              </option>
            ))}
          </select>
        )}
      </WorkspacePageHeader>
      {environment ? (
        <AssistantWorkspace
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p className="p-6 text-muted-foreground">
          Connect an environment to create your first agent.
        </p>
      )}
    </SidebarInset>
  );
}

function AssistantWorkspace({ environmentId }: { environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const threads = useThreadShells().filter((thread) => thread.environmentId === environmentId);
  const query = useEnvironmentQuery(assistants.list({ environmentId, input: {} }));
  const [editing, setEditing] = useState<AssistantProfile | "new" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaultOpen, setDefaultOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const providers = environment?.serverConfig?.providers ?? [];
  const main = query.data?.assistants.find((assistant) => assistant.kind === "main");
  const projectAssistants =
    query.data?.assistants.filter((assistant) => assistant.kind === "project") ?? [];

  // Shell updates already arrive over the shared connection. No polling while the page is hidden.
  const activityKey = threads
    .map(
      (thread) =>
        `${thread.id}:${thread.session?.status}:${thread.hasPendingApprovals}:${thread.hasPendingUserInput}`,
    )
    .join("|");
  const refresh = query.refresh;
  useEffect(() => {
    if (activityKey !== undefined) refresh();
  }, [activityKey, refresh]);

  async function act(action: AssistantAction, openChat = false) {
    setPending(true);
    setError(null);
    try {
      const result = await runAtomCommand(appAtomRegistry, assistants.act, {
        environmentId,
        input: action,
      });
      if (result._tag !== "Success") {
        const cause = Cause.squash(result.cause);
        setError(
          cause instanceof Error
            ? cause.message
            : "The change could not be saved. Check the connection and try again.",
        );
        return false;
      }
      query.refresh();
      if (openChat && result.value.threadId)
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: result.value.threadId },
        });
      return true;
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-8">
        <section className="space-y-4">
          <BotIcon className="size-7 text-muted-foreground" />
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold">What would you like to get done?</h2>
            <p className="max-w-xl text-sm leading-6 text-muted-foreground">
              Talk to your main agent to set up help for a project, follow progress, or decide what
              needs your attention. Coding, business, and everyday work all belong here.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending || query.isPending}
              onClick={() => void act({ type: "open-main" }, true)}
            >
              Talk to{" "}
              {main?.name === "Main assistant" ? "Main agent" : (main?.name ?? "your main agent")}
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => setEditing("new")}>
              <PlusIcon className="size-4" />
              Create an agent
            </Button>
          </div>
          {main && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(main)}>
              Edit main agent
            </Button>
          )}
          {main &&
            !supportsAgentCoordination(
              providers.find((provider) => provider.instanceId === main.modelSelection.instanceId)
                ?.driver,
            ) && <p className="text-xs text-muted-foreground">{AGENT_CHAT_ONLY_NOTICE}</p>}
          {main && <AssistantConversationHistory profile={main} environmentId={environmentId} />}
          <p className="text-xs text-muted-foreground">
            Try: “Create an agent to help with my business and plan next week's priorities.”
          </p>
        </section>
        {(error || query.error) && (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{error ?? query.error}</p>
            <Button variant="outline" size="sm" onClick={query.refresh}>
              Try again
            </Button>
          </div>
        )}
        {editing && query.data && (
          <AssistantEditor
            key={editing === "new" ? "new" : editing.id}
            profile={editing === "new" ? null : editing}
            defaultModel={query.data.defaultModelSelection}
            projects={projects.filter(
              (project) => !query.data?.assistants.some((agent) => agent.projectId === project.id),
            )}
            providers={providers}
            pending={pending}
            onCancel={() => setEditing(null)}
            onSave={async (action) => {
              if (await act(action)) setEditing(null);
            }}
          />
        )}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-medium">Your project agents</h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh agents"
              disabled={query.isPending}
              onClick={query.refresh}
            >
              <RefreshCwIcon className="size-4" />
            </Button>
          </div>
          {query.isPending && !query.data ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading agents…
            </p>
          ) : projectAssistants.length === 0 ? (
            <p className="py-5 text-sm text-muted-foreground">
              No project agents yet. Ask your main agent to create one, or create one yourself.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {projectAssistants.map((assistant) => {
                const tasks =
                  query.data?.tasks.filter((task) => task.assistantId === assistant.id) ?? [];
                return (
                  <li key={assistant.id} className="space-y-3 py-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <h3 className="font-medium break-words">
                          {assistant.kind === "main" && assistant.name === "Main assistant"
                            ? "Main agent"
                            : assistant.name}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {projects.find((project) => project.id === assistant.projectId)?.title ??
                            "Project unavailable"}{" "}
                          ·{" "}
                          {providers.find(
                            (provider) =>
                              provider.instanceId === assistant.modelSelection.instanceId,
                          )?.displayName ?? assistant.modelSelection.instanceId}
                          {assistant.paused ? " · Paused" : ""}
                        </p>
                      </div>
                      <Button
                        disabled={pending}
                        onClick={() => void act({ type: "open", id: assistant.id }, true)}
                      >
                        Open chat
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => setEditing(assistant)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void act({ type: "pause", id: assistant.id, paused: !assistant.paused })
                        }
                      >
                        {supportsAgentCoordination(
                          providers.find(
                            (provider) =>
                              provider.instanceId === assistant.modelSelection.instanceId,
                          )?.driver,
                        )
                          ? assistant.paused
                            ? "Resume coordination"
                            : "Pause coordination"
                          : assistant.paused
                            ? "Resume task updates"
                            : "Pause task updates"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void act({ type: "open", id: assistant.id, fresh: true }, true)
                        }
                      >
                        New conversation
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => setConfirmDelete(assistant.id)}
                      >
                        Remove
                      </Button>
                    </div>
                    {!supportsAgentCoordination(
                      providers.find(
                        (provider) => provider.instanceId === assistant.modelSelection.instanceId,
                      )?.driver,
                    ) && <p className="text-xs text-muted-foreground">{AGENT_CHAT_ONLY_NOTICE}</p>}
                    <AssistantConversationHistory
                      profile={assistant}
                      environmentId={environmentId}
                    />
                    {assistant.paused && (
                      <p className="text-xs text-muted-foreground">
                        New delegation and automatic follow-ups are paused. Running tasks can
                        finish.
                      </p>
                    )}
                    {confirmDelete === assistant.id && (
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span>Remove this agent? Conversations will remain.</span>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            void act({ type: "delete", id: assistant.id }).then((saved) => {
                              if (saved) setConfirmDelete(null);
                            })
                          }
                        >
                          Remove agent
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </Button>
                      </div>
                    )}
                    {tasks.length > 0 && (
                      <ul className="space-y-2">
                        {tasks.map((task) => {
                          const live =
                            threads.find((thread) => thread.id === task.threadId) ?? task.thread;
                          const status = assistantTaskStatus({ ...task, thread: live });
                          return (
                            <li
                              key={task.threadId}
                              className="flex flex-wrap items-center justify-between gap-2 text-sm"
                            >
                              <button
                                className="min-w-0 text-left underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                                onClick={() =>
                                  void navigate({
                                    to: "/$environmentId/$threadId",
                                    params: { environmentId, threadId: task.threadId },
                                  })
                                }
                              >
                                {task.title}
                              </button>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">
                                  {status.label}
                                </span>
                                {status.canStop && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={pending}
                                    onClick={() =>
                                      void act({ type: "stop-task", threadId: task.threadId })
                                    }
                                  >
                                    Stop
                                  </Button>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {query.data && (
          <section className="border-t border-border pt-5">
            <Button variant="ghost" size="sm" onClick={() => setDefaultOpen(!defaultOpen)}>
              Default provider for new agents:{" "}
              {providers.find(
                (provider) => provider.instanceId === query.data?.defaultModelSelection.instanceId,
              )?.displayName ?? query.data.defaultModelSelection.instanceId}
            </Button>
            {!supportsAgentCoordination(
              providers.find(
                (provider) => provider.instanceId === query.data?.defaultModelSelection.instanceId,
              )?.driver,
            ) && <p className="mt-2 text-xs text-muted-foreground">{AGENT_CHAT_ONLY_NOTICE}</p>}
            {defaultOpen && (
              <ModelFields
                model={query.data.defaultModelSelection}
                providers={providers}
                onChange={(modelSelection) => void act({ type: "set-default", modelSelection })}
                disabled={pending}
              />
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Changing the default affects new agents. Existing agents keep their own provider.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

type ProviderChoice = NonNullable<
  ReturnType<typeof useEnvironments>["environments"][number]["serverConfig"]
>["providers"][number];
function ModelFields({
  model,
  providers,
  onChange,
  disabled,
}: {
  model: ModelSelection;
  providers: readonly ProviderChoice[];
  onChange: (model: ModelSelection) => void;
  disabled: boolean;
}) {
  const selected = providers.find((provider) => provider.instanceId === model.instanceId);
  return (
    <div className="flex flex-wrap gap-3">
      <label className="flex min-w-40 flex-1 flex-col gap-2 text-sm">
        Provider
        <select
          className={selectClass}
          value={model.instanceId}
          disabled={disabled}
          onChange={(event) => {
            const provider = providers.find((entry) => entry.instanceId === event.target.value);
            onChange({
              instanceId: ProviderInstanceId.make(event.target.value),
              model: provider?.models[0]?.slug ?? model.model,
            });
          }}
        >
          {!selected && <option value={model.instanceId}>{model.instanceId}</option>}
          {providers.map((provider) => (
            <option key={provider.instanceId} value={provider.instanceId}>
              {provider.displayName ?? provider.instanceId}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-40 flex-1 flex-col gap-2 text-sm">
        Model
        <select
          className={selectClass}
          value={model.model}
          disabled={disabled}
          onChange={(event) => onChange({ ...model, model: event.target.value })}
        >
          {!selected?.models.some((entry) => entry.slug === model.model) && (
            <option value={model.model}>{model.model}</option>
          )}
          {selected?.models.map((entry) => (
            <option key={entry.slug} value={entry.slug}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      {!supportsAgentCoordination(selected?.driver) && (
        <p className="w-full text-xs text-muted-foreground">{AGENT_CHAT_ONLY_NOTICE}</p>
      )}
    </div>
  );
}

function AssistantEditor({
  profile,
  defaultModel,
  projects,
  providers,
  pending,
  onSave,
  onCancel,
}: {
  profile: AssistantProfile | null;
  defaultModel: ModelSelection;
  projects: ReturnType<typeof useProjects>;
  providers: readonly ProviderChoice[];
  pending: boolean;
  onSave: (action: AssistantAction) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [instructions, setInstructions] = useState(profile?.instructions ?? "");
  const [projectId, setProjectId] = useState<string>(profile?.projectId ?? "");
  const [model, setModel] = useState(profile?.modelSelection ?? defaultModel);
  return (
    <form
      className="space-y-4 rounded-lg border border-border p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          type: "save",
          ...(profile ? { id: profile.id } : {}),
          ...(projectId ? { projectId: ProjectId.make(projectId) } : {}),
          name: name.trim(),
          instructions,
          modelSelection: model,
        });
      }}
    >
      <h2 className="font-medium">{profile ? "Edit agent" : "Create an agent"}</h2>
      <label className="flex flex-col gap-2 text-sm">
        Name
        <Input
          aria-label="Agent name"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Business agent"
        />
      </label>
      {!profile && (
        <label className="flex flex-col gap-2 text-sm">
          Project
          <select
            className={selectClass}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Create a workspace for this agent</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-2 text-sm">
        What should this agent help with?
        <Textarea
          aria-label="Agent instructions"
          maxLength={16000}
          rows={4}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Help me plan operations, research competitors, and track decisions."
        />
      </label>
      <ModelFields model={model} providers={providers} onChange={setModel} disabled={pending} />
      {profile && (
        <p className="text-xs text-muted-foreground">
          Provider changes apply to the next conversation. Running tasks keep their current
          provider. Saved decisions and task history stay with this agent.
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={pending || !name.trim()} type="submit">
          {pending ? "Saving…" : "Save agent"}
        </Button>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AssistantConversationHistory({
  profile,
  environmentId,
}: {
  profile: AssistantProfile;
  environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const threads = useThreadShells();
  if (!profile.conversationThreadIds?.length) return null;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-ring">
        Previous conversations ({profile.conversationThreadIds.length})
      </summary>
      <ul className="space-y-1 pt-1">
        {profile.conversationThreadIds.map((threadId, index) => (
          <li key={threadId}>
            <button
              className="max-w-full truncate py-1 text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId },
                })
              }
            >
              {threads.find(
                (thread) => thread.environmentId === environmentId && thread.id === threadId,
              )?.title ?? `Conversation ${index + 1}`}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
