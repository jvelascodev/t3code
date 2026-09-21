import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { environmentCatalog } from "../connection/catalog";
import { assistants } from "./assistants";

export const assistantDirectoryAtom = Atom.make((get) =>
  [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))].flatMap((environmentId) => {
    const result = get(assistants.list({ environmentId, input: {} }));
    const snapshot = Option.getOrNull(AsyncResult.value(result));
    return (snapshot?.assistants ?? []).map((assistant) => ({ ...assistant, environmentId }));
  }),
);
