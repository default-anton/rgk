import type { Candidate } from "./candidates.js";

export type PromptBudget = {
  readonly perRequestMaxBytes: number;
  readonly totalMaxBytes: number;
};

export type PromptBudgetFailure = "request" | "total";

export type PromptBudgetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PromptBudgetFailure };

export type PromptBudgetTracker = {
  readonly add: (candidate: Candidate) => PromptBudgetResult;
};

export function buildPromptText(condition: string, candidates: readonly Candidate[]): string {
  return `Condition:\n${condition}\n\nCandidates:\n${candidates.map((candidate) => candidate.promptLine).join("\n")}\n`;
}

export function batchCandidates(
  condition: string,
  candidates: readonly Candidate[],
  maxBytes = 400_000,
): readonly (readonly Candidate[])[] {
  const baseBytes = fixedPromptBytes(condition);
  const batches: Candidate[][] = [];
  let batch: Candidate[] = [];
  let batchBytes = baseBytes;

  for (const candidate of candidates) {
    const singleCandidateBytes = baseBytes + candidatePromptBytes(candidate, true);
    if (singleCandidateBytes > maxBytes) {
      throw new Error(
        `single keep candidate is above RGK_PROMPT_MAX_BYTES=${maxBytes}. Lower RGK_PROMPT_LINE_MAX_BYTES or raise RGK_PROMPT_MAX_BYTES.`,
      );
    }

    const appendBytes = candidatePromptBytes(candidate, batch.length === 0);
    if (batch.length > 0 && batchBytes + appendBytes > maxBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = baseBytes;
    }

    batch.push(candidate);
    batchBytes += candidatePromptBytes(candidate, batch.length === 1);
  }

  if (batch.length > 0) {
    batches.push(batch);
  }

  return batches;
}

export function createPromptBudgetTracker(
  condition: string,
  budget: PromptBudget,
): PromptBudgetTracker {
  const baseBytes = fixedPromptBytes(condition);
  let completedBatchBytes = 0;
  let currentBatchBytes = baseBytes;
  let currentBatchCandidates = 0;

  return {
    add: (candidate) => {
      const singleCandidateBytes = baseBytes + candidatePromptBytes(candidate, true);
      if (singleCandidateBytes > budget.perRequestMaxBytes) {
        return { ok: false, reason: "request" };
      }

      const appendBytes = candidatePromptBytes(candidate, currentBatchCandidates === 0);
      if (
        currentBatchCandidates > 0 &&
        currentBatchBytes + appendBytes > budget.perRequestMaxBytes
      ) {
        const nextCompletedBatchBytes = completedBatchBytes + currentBatchBytes;
        const nextCurrentBatchBytes = singleCandidateBytes;
        if (nextCompletedBatchBytes + nextCurrentBatchBytes > budget.totalMaxBytes) {
          return { ok: false, reason: "total" };
        }

        completedBatchBytes = nextCompletedBatchBytes;
        currentBatchBytes = nextCurrentBatchBytes;
        currentBatchCandidates = 1;
        return { ok: true };
      }

      const nextCurrentBatchBytes = currentBatchBytes + appendBytes;
      if (completedBatchBytes + nextCurrentBatchBytes > budget.totalMaxBytes) {
        return { ok: false, reason: "total" };
      }

      currentBatchBytes = nextCurrentBatchBytes;
      currentBatchCandidates += 1;
      return { ok: true };
    },
  };
}

export function totalPromptBytes(
  condition: string,
  batches: readonly (readonly Candidate[])[],
): number {
  return batches.reduce((total, batch) => total + promptBytes(condition, batch), 0);
}

export function promptBytes(condition: string, candidates: readonly Candidate[]): number {
  return candidates.reduce(
    (total, candidate, index) => total + candidatePromptBytes(candidate, index === 0),
    fixedPromptBytes(condition),
  );
}

export function fixedPromptBytes(condition: string): number {
  return Buffer.byteLength(buildPromptText(condition, []), "utf8");
}

function candidatePromptBytes(candidate: Candidate, first: boolean): number {
  return Buffer.byteLength(candidate.promptLine, "utf8") + (first ? 0 : 1);
}
