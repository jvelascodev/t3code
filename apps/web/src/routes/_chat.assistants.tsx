import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironment, useEnvironments } from "../state/environments";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useAgentManagement } from "../components/agents/AgentManagement";

export const Route = createFileRoute("/_chat/assistants")({
  validateSearch: (search: Record<string, unknown>): { create?: boolean } =>
    search.create === true || search.create === "true" ? { create: true } : {},
  component: AssistantsPage,
});
function AssistantsPage() {
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState("");
  const environment = environments.find((e) => e.environmentId === selected) ?? environments[0];
  const { create } = Route.useSearch();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background">
      <WorkspacePageHeader electron={isElectron}>
        <SidebarTrigger />
        <h1 className="text-sm font-medium">Agents</h1>
        {environments.length > 1 && (
          <select
            aria-label="Environment"
            className="no-drag ml-auto rounded-md border border-input bg-background p-2 text-sm"
            value={environment?.environmentId ?? ""}
            onChange={(e) => setSelected(e.target.value)}
          >
            {environments.map((e) => (
              <option key={e.environmentId} value={e.environmentId}>
                {e.label}
              </option>
            ))}
          </select>
        )}
      </WorkspacePageHeader>
      {environment ? (
        <OpenAgent
          key={`${environment.environmentId}:${Boolean(create)}`}
          environmentId={environment.environmentId}
          create={Boolean(create)}
        />
      ) : (
        <p className="p-6 text-muted-foreground">
          Connect an environment to talk to your main agent.
        </p>
      )}
    </SidebarInset>
  );
}
function OpenAgent({ environmentId, create }: { environmentId: EnvironmentId; create: boolean }) {
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const management = useAgentManagement(environmentId);
  const { act, setDialog, pending, error } = management;
  const started = useRef(false);
  useEffect(() => {
    if (started.current || (!create && !connected)) return;
    started.current = true;
    if (create) setDialog({ kind: "create" });
    else void act({ type: "open-main" }, true);
  }, [act, connected, create, setDialog]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {!connected
            ? "Waiting for the environment to connect…"
            : pending
              ? "Opening your main agent…"
              : create
                ? "Create an agent or continue with your main agent."
                : "Opening your main agent…"}
        </p>
      )}
      {(error || create) && (
        <Button disabled={pending} onClick={() => void act({ type: "open-main" }, true)}>
          Open main agent
        </Button>
      )}
      {create && (
        <Button variant="outline" disabled={pending} onClick={() => setDialog({ kind: "create" })}>
          Create an agent
        </Button>
      )}
      {management.dialogs}
    </div>
  );
}
