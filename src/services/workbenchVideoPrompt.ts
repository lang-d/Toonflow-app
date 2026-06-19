import {
  compileWorkbenchVideoPrompt,
  CompileVideoPromptInput,
  CompileVideoPromptOptions,
} from "@/services/videoPromptCompiler";

export async function generateWorkbenchVideoPrompt(input: CompileVideoPromptInput, options: CompileVideoPromptOptions = {}) {
  const result = await compileWorkbenchVideoPrompt(input, options);
  return result.text;
}

export async function generateWorkbenchVideoPromptResult(input: CompileVideoPromptInput, options: CompileVideoPromptOptions = {}) {
  return compileWorkbenchVideoPrompt(input, options);
}
