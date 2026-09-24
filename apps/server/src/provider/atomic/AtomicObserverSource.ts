/** Loaded into Atomic's RPC process to forward its public workflow hooks. */
export const atomicObserverSource = `
export default function (pi) {
  let subscription;
  const publish = (ctx, value) => {
    if (ctx.mode === "rpc") {
      ctx.ui.setWidget("t3-atomic-observer", [JSON.stringify(value)]);
    }
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "rpc" || ctx.subagentPolicy || ctx.orchestrationContext) return;
    subscription?.dispose();
    subscription = ctx.observeWorkflowActivity((frame) => publish(ctx, { kind: "activity", frame }));
  });
  pi.on("workflow_lifecycle", (event, ctx) => {
    if (!ctx.subagentPolicy && !ctx.orchestrationContext) {
      publish(ctx, { kind: "lifecycle", event });
    }
  });
  pi.on("session_shutdown", () => {
    subscription?.dispose();
    subscription = undefined;
  });
}
`;
