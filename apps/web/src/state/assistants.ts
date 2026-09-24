import { createAssistantAtoms } from "@t3tools/client-runtime/state/assistants";
import { connectionAtomRuntime } from "../connection/runtime";

export const assistants = createAssistantAtoms(connectionAtomRuntime);
