import type { CodexThreadOptions } from "./codex-app-server-host";
import type { CodexAccountReadResponse } from "./codex-protocol";
import {
  CodexRuntimePool,
  type CodexRuntimeTurnResult,
} from "./codex-runtime-pool";
import {
  CodexSkillActivator,
  type CodexSkillActivation,
} from "./codex-skill-activator";

export interface CodexThinRunnerInput extends CodexThreadOptions {
  runId: string;
  workspaceId: string;
  prompt: string;
  /**
   * Exact installed plugin skill keys (`plugin-id/skill-id`) to activate.
   * Omit to restore the existing run activation. Pass [] to explicitly clear it.
   */
  skillKeys?: readonly string[];
}

export interface CodexThinRunnerResult extends CodexRuntimeTurnResult {
  skillActivation: CodexSkillActivation | null;
}

/**
 * P2 coordinator: native Codex execution plus bounded exact skill projection.
 *
 * There is intentionally no AgentModelAdapter, runAgentLoop, model-side router,
 * marketplace downloader, or second reasoning loop in this path.
 */
export class CodexThinRunner {
  private initialized = false;

  constructor(
    private readonly runtimes: CodexRuntimePool,
    private readonly skills: CodexSkillActivator,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.skills.initialize();
    await this.runtimes.initialize();
    this.initialized = true;
  }

  async account(cwd: string): Promise<CodexAccountReadResponse> {
    await this.initialize();
    return this.runtimes.account({ cwd });
  }

  async run(input: CodexThinRunnerInput): Promise<CodexThinRunnerResult> {
    await this.initialize();
    const activation = input.skillKeys === undefined
      ? await this.skills.restore(input.runId)
      : await this.skills.activate({
          runId: input.runId,
          workspaceId: input.workspaceId,
          skillKeys: input.skillKeys,
        });
    if (activation && activation.workspaceId !== input.workspaceId) {
      throw new Error("Codex skill activation belongs to a different workspace");
    }

    const activeSkills = activation?.skills ?? [];
    const result = await this.runtimes.runTurn({
      runId: input.runId,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      prompt: input.prompt,
      ...(input.sandbox ? { sandbox: input.sandbox } : {}),
      ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      skillRoots: activeSkills.length > 0 && activation ? [activation.root] : [],
      skills: activeSkills.map((skill) => ({ name: skill.name, path: skill.path })),
    });
    return { ...result, skillActivation: activation };
  }

  async release(runId: string): Promise<void> {
    await this.initialize();
    await this.runtimes.release(runId).catch(() => false);
    await this.skills.release(runId).catch(() => false);
  }

  async cancel(runId: string): Promise<void> {
    await this.initialize();
    await this.runtimes.cancel(runId).catch(() => false);
    await this.skills.release(runId).catch(() => false);
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;
    await this.runtimes.shutdown();
    this.initialized = false;
  }
}
