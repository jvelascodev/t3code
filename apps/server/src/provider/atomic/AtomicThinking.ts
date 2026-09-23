import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ATOMIC_DEFAULT_THINKING_LEVEL = "default";
export const AtomicThinkingLevel = Schema.Literals(THINKING_LEVELS);
export const isAtomicThinkingLevel = Schema.is(AtomicThinkingLevel);

export function selectedAtomicThinkingLevel(
  selection: ModelSelection | null | undefined,
): string | undefined {
  return getModelSelectionStringOptionValue(selection, "effort");
}

export function atomicModelCapabilities(model: {
  reasoning?: boolean | undefined;
  thinkingLevelMap?: Readonly<Record<string, string | null>> | undefined;
}): ModelCapabilities {
  if (model.reasoning !== true) return createModelCapabilities({ optionDescriptors: [] });

  // Atomic requires explicit mappings for xhigh and max; null disables any level.
  const options = THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (level !== "xhigh" && level !== "max" ? true : mapped !== undefined);
  }).map((level) => ({
    id: level,
    label: level.charAt(0).toUpperCase() + level.slice(1),
  }));

  return createModelCapabilities({
    optionDescriptors:
      options.length > 1
        ? [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: ATOMIC_DEFAULT_THINKING_LEVEL, label: "Atomic setting", isDefault: true },
                ...options,
              ],
            },
          ]
        : [],
  });
}
