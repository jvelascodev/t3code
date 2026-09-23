import type { AssistantProfile, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { useAgentActions } from "../../hooks/useAgentActions";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { AssistantEditor, ModelFields } from "./AgentEditor";

export function agentName(agent: AssistantProfile) {
  return agent.kind === "main" && agent.name === "Main assistant" ? "Main agent" : agent.name;
}
type ManagementDialog =
  | { kind: "edit" | "remove"; agent: AssistantProfile }
  | { kind: "create" | "defaults" };

export function useAgentManagement(environmentId: EnvironmentId, onNavigated?: () => void) {
  const actions = useAgentActions(environmentId, onNavigated);
  const [dialog, setDialog] = useState<ManagementDialog | null>(null);
  async function openMenu(agent: AssistantProfile, position: { x: number; y: number }) {
    if (actions.pending) return;
    const api = readLocalApi();
    if (!api) return;
    const selected = await api.contextMenu.show(
      [
        { id: "edit", label: "Edit agent" },
        { id: "new", label: "Start a new conversation" },
        { id: "pause", label: agent.paused ? "Resume coordination" : "Pause coordination" },
        { id: "remove", label: "Remove agent" },
      ],
      position,
    );
    if (selected === "edit" || selected === "remove") setDialog({ kind: selected, agent });
    if (selected === "new") await actions.act({ type: "open", id: agent.id, fresh: true }, true);
    if (selected === "pause")
      await actions.act({ type: "pause", id: agent.id, paused: !agent.paused });
  }
  return {
    ...actions,
    openMenu,
    setDialog,
    dialogs: (
      <AgentManagementDialog
        environmentId={environmentId}
        dialog={dialog}
        onClose={() => setDialog(null)}
        actions={actions}
      />
    ),
  };
}
function AgentManagementDialog({
  environmentId,
  dialog,
  onClose,
  actions,
}: {
  environmentId: EnvironmentId;
  dialog: ManagementDialog | null;
  onClose: () => void;
  actions: ReturnType<typeof useAgentActions>;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const providers =
    environments.find((e) => e.environmentId === environmentId)?.serverConfig?.providers ?? [];
  const { query, act, error, pending } = actions;
  const profile = dialog && "agent" in dialog ? dialog.agent : null;
  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-lg overflow-y-auto p-6">
        <DialogTitle>
          {dialog?.kind === "remove"
            ? `Remove ${profile ? agentName(profile) : "agent"}?`
            : dialog?.kind === "defaults"
              ? "Defaults for new agents"
              : profile
                ? "Edit agent"
                : "Create an agent"}
        </DialogTitle>
        <DialogDescription>
          {dialog?.kind === "remove"
            ? "Its project, conversations, and task threads will remain."
            : dialog?.kind === "defaults"
              ? "Existing agents keep their own provider and model."
              : "Choose what this agent helps with and where it works."}
        </DialogDescription>
        {(error || query.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? query.error}
          </p>
        )}
        {!query.data && (
          <Button variant="outline" disabled={query.isPending} onClick={query.refresh}>
            {query.isPending ? "Loading agents…" : "Try again"}
          </Button>
        )}
        {query.data && (dialog?.kind === "edit" || dialog?.kind === "create") && (
          <AssistantEditor
            key={profile?.id ?? "new"}
            profile={profile}
            defaultModel={query.data.defaultModelSelection}
            projects={projects.filter(
              (project) =>
                !query.data?.assistants.some(
                  (agent) => agent.projectId === project.id && agent.id !== profile?.id,
                ),
            )}
            providers={providers}
            pending={pending}
            onCancel={onClose}
            onSave={async (action) => {
              if (await act(action, dialog.kind === "create")) onClose();
            }}
          />
        )}
        {dialog?.kind === "defaults" && query.data && (
          <ModelFields
            model={query.data.defaultModelSelection}
            providers={providers}
            disabled={pending}
            onChange={(modelSelection) => {
              void act({ type: "set-default", modelSelection });
            }}
          />
        )}
        {dialog?.kind === "remove" && profile && (
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                void act({ type: "delete", id: profile.id }).then((saved) => {
                  if (saved) onClose();
                });
              }}
            >
              Remove agent
            </Button>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}
