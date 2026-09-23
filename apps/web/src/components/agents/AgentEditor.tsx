import {
  supportsAgentCoordination,
  AGENT_CHAT_ONLY_NOTICE,
  ProjectId,
  ProviderInstanceId,
  type AssistantAction,
  type AssistantProfile,
  type ModelSelection,
} from "@t3tools/contracts";
import { useState } from "react";
import type { useEnvironments } from "../../state/environments";
import type { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
const selectClass =
  "min-h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
type ProviderChoice = NonNullable<
  ReturnType<typeof useEnvironments>["environments"][number]["serverConfig"]
>["providers"][number];
export function ModelFields({
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

export function AssistantEditor({
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
      className="mt-4 space-y-4"
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
      {profile?.kind !== "main" && (
        <label className="flex flex-col gap-2 text-sm">
          Project
          <select
            className={selectClass}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {!profile && <option value="">Create a workspace for this agent</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {profile && projectId !== profile.projectId && (
        <p className="text-xs text-muted-foreground">
          Changing project starts a fresh conversation and clears saved project memory. Previous
          conversations and tasks stay in their original projects. Finish or stop active work first.
        </p>
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
      {profile && projectId === profile.projectId && (
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
