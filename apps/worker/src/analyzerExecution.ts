export type AnalyzerExecutionStatus =
  | "completed"
  | "deferred_dependencies"
  | "deferred_lock"
  | "retryable_failure"
  | "hard_failure";

export interface AnalyzerExecutionResult {
  status: AnalyzerExecutionStatus;
  reason?: string | null;
  availableAt?: Date | null;
}

export function completedExecution(reason?: string | null): AnalyzerExecutionResult {
  return {
    status: "completed",
    reason: reason || null,
  };
}

export function deferredDependenciesExecution(reason: string, delayMs = 15_000): AnalyzerExecutionResult {
  return {
    status: "deferred_dependencies",
    reason,
    availableAt: new Date(Date.now() + Math.max(1_000, delayMs)),
  };
}

export function deferredLockExecution(reason: string, delayMs = 2_000): AnalyzerExecutionResult {
  return {
    status: "deferred_lock",
    reason,
    availableAt: new Date(Date.now() + Math.max(500, delayMs)),
  };
}

export function retryableFailureExecution(reason: string, delayMs = 15_000): AnalyzerExecutionResult {
  return {
    status: "retryable_failure",
    reason,
    availableAt: new Date(Date.now() + Math.max(1_000, delayMs)),
  };
}

export function hardFailureExecution(reason: string): AnalyzerExecutionResult {
  return {
    status: "hard_failure",
    reason,
  };
}

export class RetryableAnalyzerError extends Error {
  readonly availableAt: Date | null;

  constructor(message: string, availableAt?: Date | null) {
    super(message);
    this.name = "RetryableAnalyzerError";
    this.availableAt = availableAt || null;
  }
}

export interface OutboxTransition {
  processedAt: Date | null;
  availableAt?: Date;
  attemptCount?: number;
  error: string | null;
}

export function resolveOutboxTransition(params: {
  result: AnalyzerExecutionResult;
  now?: Date;
  currentAttemptCount: number;
  maxAttempts: number;
}): OutboxTransition {
  const now = params.now || new Date();
  const currentAttemptCount = Math.max(0, Math.floor(params.currentAttemptCount));
  const maxAttempts = Math.max(1, Math.floor(params.maxAttempts));
  const reason = params.result.reason ? String(params.result.reason).slice(0, 2000) : null;

  if (params.result.status === "completed") {
    return {
      processedAt: now,
      error: null,
    };
  }

  if (params.result.status === "deferred_dependencies" || params.result.status === "deferred_lock") {
    return {
      processedAt: null,
      availableAt: params.result.availableAt || now,
      error: reason,
    };
  }

  if (params.result.status === "retryable_failure") {
    const attemptCount = currentAttemptCount + 1;
    const processedAt = attemptCount >= maxAttempts ? now : null;
    return {
      processedAt,
      availableAt: processedAt ? undefined : params.result.availableAt || now,
      attemptCount,
      error: reason,
    };
  }

  return {
    processedAt: now,
    attemptCount: currentAttemptCount + 1,
    error: reason,
  };
}
