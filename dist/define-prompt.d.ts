/**
 * definePrompt — symmetric to defineTool / defineResource.
 *
 * Place files under `src/prompts/<group>/<verb>.ts`. The macro derives
 * the prompt name from the file path and self-registers.
 */
import type { PromptDefinition, PromptDefinitionInput } from './types';
export declare function definePrompt(input: PromptDefinitionInput): PromptDefinition;
