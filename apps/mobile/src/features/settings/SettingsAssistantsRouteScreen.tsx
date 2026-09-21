import { supportsAgentCoordination, AGENT_CHAT_ONLY_NOTICE } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  createAssistantAtoms,
  assistantTaskStatus,
} from "@t3tools/client-runtime/state/assistants";
import {
  type AssistantAction,
  type AssistantProfile,
  type EnvironmentId,
  type ModelSelection,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { useProjects, useThreadShells } from "../../state/entities";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsEnvironmentFilterHeader } from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const assistants = createAssistantAtoms(connectionAtomRuntime);

export function SettingsAssistantsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <SettingsScreen title="Agents">
      <SettingsEnvironmentFilterHeader />
      <ScreenScrollView contentContainerClassName="gap-6 p-5 pb-12">
        <Text className="text-foreground-muted">
          Get help with coding, your business, or everyday work. Ask your main agent to create and
          coordinate project agents.
        </Text>
        {selectedTargets.length === 0 && <Text>Connect an environment to get started.</Text>}
        {selectedTargets.map((target) => (
          <EnvironmentAssistants key={target.environmentId} environmentId={target.environmentId} />
        ))}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentAssistants({ environmentId }: { environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const target = selectedTargets.find((entry) => entry.environmentId === environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const query = useEnvironmentQuery(assistants.list({ environmentId, input: {} }));
  const run = useAtomCommand(assistants.act);
  const threads = useThreadShells().filter((thread) => thread.environmentId === environmentId);
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
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<{
    title: string;
    options: { id: string; text: string; onPress: () => void }[];
  } | null>(null);
  const [editing, setEditing] = useState<AssistantProfile | "new" | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [projectId, setProjectId] = useState<AssistantProfile["projectId"] | null>(null);
  const providers = target?.serverConfig.providers ?? [];

  async function act(action: AssistantAction, open = false) {
    setBusy(true);
    try {
      const result = await run({ environmentId, input: action });
      if (result._tag !== "Success") {
        const cause = Cause.squash(result.cause);
        Alert.alert(
          "Could not update agent",
          cause instanceof Error ? cause.message : "Check the connection and try again.",
        );
        return false;
      }
      query.refresh();
      if (open && result.value.threadId)
        navigation.navigate("Thread", { environmentId, threadId: result.value.threadId });
      return true;
    } finally {
      setBusy(false);
    }
  }
  function edit(profile: AssistantProfile | null) {
    setEditing(profile ?? "new");
    setName(profile?.name ?? "");
    setInstructions(profile?.instructions ?? "");
    setModel(profile?.modelSelection ?? query.data?.defaultModelSelection ?? null);
    setProjectId(profile?.projectId ?? null);
  }
  const chooseProvider = (onChoose: (model: ModelSelection) => void) =>
    setChoices({
      title: "Choose a provider",
      options: providers.map((provider) => ({
        id: provider.instanceId,
        text: provider.displayName ?? provider.instanceId,
        onPress: () => {
          const first = provider.models[0];
          if (first) onChoose({ instanceId: provider.instanceId, model: first.slug });
        },
      })),
    });

  return (
    <View className="gap-4">
      {choices && (
        <SettingsSection title={choices.title}>
          {choices.options.map((choice) => (
            <SettingsRow
              key={choice.id}
              icon="chevron.right"
              label={choice.text}
              onPress={() => {
                choice.onPress();
                setChoices(null);
              }}
            />
          ))}
          <SettingsRow icon="xmark" label="Cancel" onPress={() => setChoices(null)} />
        </SettingsSection>
      )}
      <SettingsSection title={target?.label ?? "Agents"}>
        <SettingsRow
          icon="text.bubble"
          label="Talk to your main agent"
          disabled={busy}
          onPress={() => void act({ type: "open-main" }, true)}
        />
        <SettingsRow
          icon="plus"
          label="Create an agent"
          disabled={busy || !query.data}
          onPress={() => edit(null)}
        />
        <SettingsRow icon="arrow.clockwise" label="Refresh agents" onPress={query.refresh} />
      </SettingsSection>
      {query.error && (
        <Text accessibilityRole="alert" className="text-destructive">
          {query.error}
        </Text>
      )}
      {query.isPending && !query.data && <Text>Loading agents…</Text>}
      {editing && model && (
        <View className="gap-3 rounded-xl bg-card p-4">
          <Text className="text-lg font-semibold">
            {editing === "new" ? "Create an agent" : "Edit agent"}
          </Text>
          <Text>Name</Text>
          <AppTextInput
            accessibilityLabel="Agent name"
            className="rounded-lg border border-border p-3 text-foreground"
            value={name}
            maxLength={120}
            onChangeText={setName}
            placeholder="Business agent"
          />
          <Text>What should this agent help with?</Text>
          <AppTextInput
            accessibilityLabel="Agent instructions"
            className="min-h-24 rounded-lg border border-border p-3 text-foreground"
            multiline
            value={instructions}
            maxLength={16000}
            onChangeText={setInstructions}
          />
          {(editing === "new" || editing?.kind === "project") && (
            <SettingsSection title="Project">
              <SettingsRow
                icon="folder"
                label={projects.find((p) => p.id === projectId)?.title ?? "Create a workspace"}
                onPress={() =>
                  setChoices({
                    title: "Choose a project",
                    options: [
                      ...(editing === "new"
                        ? [
                            {
                              id: "new",
                              text: "Create a workspace",
                              onPress: () => setProjectId(null),
                            },
                          ]
                        : []),
                      ...projects
                        .filter(
                          (project) =>
                            !query.data?.assistants.some(
                              (agent) =>
                                agent.projectId === project.id &&
                                (editing === "new" || agent.id !== editing?.id),
                            ),
                        )
                        .map((project) => ({
                          id: project.id,
                          text: project.title,
                          onPress: () => setProjectId(project.id),
                        })),
                    ],
                  })
                }
              />
            </SettingsSection>
          )}
          {!supportsAgentCoordination(
            providers.find((provider) => provider.instanceId === model.instanceId)?.driver,
          ) && <Text>{AGENT_CHAT_ONLY_NOTICE}</Text>}
          {editing !== "new" && editing && projectId !== editing.projectId && (
            <Text>
              Changing project starts a fresh conversation and clears saved project memory. Previous
              conversations and tasks stay in their original projects. Finish or stop active work
              first.
            </Text>
          )}
          <SettingsSection title="Provider">
            <SettingsRow
              icon="gearshape"
              label={
                providers.find((provider) => provider.instanceId === model.instanceId)
                  ?.displayName ?? model.instanceId
              }
              onPress={() => chooseProvider(setModel)}
            />
            <SettingsRow
              icon="slider.horizontal.3"
              label={model.model}
              onPress={() =>
                setChoices({
                  title: "Choose a model",
                  options: (
                    providers.find((p) => p.instanceId === model.instanceId)?.models ?? []
                  ).map((entry) => ({
                    id: entry.slug,
                    text: entry.name,
                    onPress: () => setModel({ ...model, model: entry.slug }),
                  })),
                })
              }
            />
          </SettingsSection>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !name.trim()}
            className="min-h-12 items-center justify-center rounded-lg bg-primary px-4 disabled:opacity-50"
            onPress={() =>
              void act({
                type: "save",
                ...(editing !== "new" ? { id: editing.id } : {}),
                ...(projectId ? { projectId } : {}),
                name: name.trim(),
                instructions,
                modelSelection: model,
              }).then((saved) => {
                if (saved) setEditing(null);
              })
            }
          >
            <Text className="text-primary-foreground">Save agent</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            className="min-h-12 items-center justify-center"
            onPress={() => setEditing(null)}
          >
            <Text>Cancel</Text>
          </Pressable>
        </View>
      )}
      {query.data?.assistants.length === 0 && (
        <Text className="text-foreground-muted">
          No agents yet. Start a conversation with your main agent.
        </Text>
      )}
      {query.data?.assistants.map((assistant) => (
        <SettingsSection
          key={assistant.id}
          title={`${assistant.kind === "main" && assistant.name === "Main assistant" ? "Main agent" : assistant.name}${assistant.paused ? " · Paused" : ""}`}
        >
          {!supportsAgentCoordination(
            providers.find(
              (provider) => provider.instanceId === assistant.modelSelection.instanceId,
            )?.driver,
          ) && <Text>{AGENT_CHAT_ONLY_NOTICE}</Text>}
          <SettingsRow
            icon="text.bubble"
            label="Open chat"
            disabled={busy}
            onPress={() => void act({ type: "open", id: assistant.id }, true)}
          />
          <SettingsRow
            icon="pencil"
            label="Edit agent"
            disabled={busy}
            onPress={() => edit(assistant)}
          />
          <SettingsRow
            icon="stop.fill"
            label={
              supportsAgentCoordination(
                providers.find(
                  (provider) => provider.instanceId === assistant.modelSelection.instanceId,
                )?.driver,
              )
                ? assistant.paused
                  ? "Resume coordination"
                  : "Pause coordination"
                : assistant.paused
                  ? "Resume task updates"
                  : "Pause task updates"
            }
            disabled={busy}
            onPress={() => void act({ type: "pause", id: assistant.id, paused: !assistant.paused })}
          />
          <SettingsRow
            icon="square.and.pencil"
            label="New conversation"
            disabled={busy}
            onPress={() => void act({ type: "open", id: assistant.id, fresh: true }, true)}
          />
          {query.data?.tasks
            .filter((task) => task.assistantId === assistant.id)
            .map((task) => {
              const status = assistantTaskStatus({
                ...task,
                thread: threads.find((thread) => thread.id === task.threadId) ?? task.thread,
              });
              return (
                <View key={task.threadId}>
                  <SettingsRow
                    icon="text.alignleft"
                    label={task.title}
                    value={status.label}
                    onPress={() =>
                      navigation.navigate("Thread", { environmentId, threadId: task.threadId })
                    }
                  />
                  {status.canStop && (
                    <SettingsRow
                      icon="stop.fill"
                      label="Stop task"
                      disabled={busy}
                      onPress={() => void act({ type: "stop-task", threadId: task.threadId })}
                    />
                  )}
                </View>
              );
            })}
          <SettingsRow
            icon="trash"
            label="Remove agent"
            disabled={busy}
            onPress={() =>
              Alert.alert("Remove agent?", "Conversations will remain.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Remove",
                  style: "destructive",
                  onPress: () => void act({ type: "delete", id: assistant.id }),
                },
              ])
            }
          />
        </SettingsSection>
      ))}
      {query.data && (
        <SettingsSection title="New agents">
          {!supportsAgentCoordination(
            providers.find(
              (provider) => provider.instanceId === query.data?.defaultModelSelection.instanceId,
            )?.driver,
          ) && <Text>{AGENT_CHAT_ONLY_NOTICE}</Text>}
          <SettingsRow
            icon="gearshape"
            label="Default provider"
            value={
              providers.find(
                (provider) => provider.instanceId === query.data?.defaultModelSelection.instanceId,
              )?.displayName ?? query.data.defaultModelSelection.instanceId
            }
            disabled={busy}
            onPress={() =>
              chooseProvider((modelSelection) => void act({ type: "set-default", modelSelection }))
            }
          />
        </SettingsSection>
      )}
    </View>
  );
}
