export interface RuntimeOwner {
  sessionId: string
  connectionGeneration: string
}

export interface ExecutionId {
  projectId: string
  runId: string
  nonce: string
  owner: RuntimeOwner
}

export interface RuntimeBuildRef {
  buildId: string
  sourceRevision: string
}

export interface RuntimeProjection {
  workspaceRevision: string
  generation: number
  loadedBuild: RuntimeBuildRef
}

export interface RuntimeProjectionExpectation {
  workspaceRevision: string
  generation: number
}

export interface RuntimeIdentity {
  execution: ExecutionId
  projection: RuntimeProjection
}

export type RuntimeProtocolErrorCode =
  | 'ACTIVE_CONFIRMATION_REQUIRED'
  | 'RUNTIME_COMMAND_STATE'
  | 'RUNTIME_EVIDENCE_INVALID'
  | 'RUNTIME_EXECUTION_STALE'
  | 'RUNTIME_OWNER_FOREIGN'
  | 'RUNTIME_PROJECTION_STALE'
  | 'RUNTIME_REFERENCE_STALE'

const RUNTIME_PROTOCOL_ERROR_MESSAGES = {
  ACTIVE_CONFIRMATION_REQUIRED: 'Active Runtime confirmation is required',
  RUNTIME_COMMAND_STATE: 'Runtime Harness command state is invalid',
  RUNTIME_EVIDENCE_INVALID: 'Runtime Harness evidence is invalid',
  RUNTIME_EXECUTION_STALE: 'Runtime execution is stale or incomplete',
  RUNTIME_OWNER_FOREIGN: 'Runtime belongs to another Harness owner',
  RUNTIME_PROJECTION_STALE: 'Runtime projection is stale',
  RUNTIME_REFERENCE_STALE: 'Runtime reference is stale',
} as const satisfies Record<RuntimeProtocolErrorCode, string>

export type RuntimeCommandFailureStage = 'prepare' | 'execute' | 'settle'

export type RuntimeCommandFailureCode =
  | 'TARGET_PREPARATION_FAILED'
  | 'TARGET_EXECUTION_FAILED'
  | 'EVIDENCE_REJECTED'

export type RuntimeCommandOutcome =
  | { status: 'succeeded'; evidence: unknown }
  | {
      status: 'failed'
      stage: RuntimeCommandFailureStage
      code: RuntimeCommandFailureCode
      message: string
    }
  | { status: 'cancelled'; reason: string }
  | { status: 'expired'; stage: RuntimeCommandFailureStage }

export class RuntimeProtocolError extends Error {
  readonly code: RuntimeProtocolErrorCode

  constructor(
    code: RuntimeProtocolErrorCode,
    detail: string = RUNTIME_PROTOCOL_ERROR_MESSAGES[code],
  ) {
    super(runtimeProtocolErrorMessage(code, detail))
    this.name = 'RuntimeProtocolError'
    this.code = code
  }
}

export function runtimeProtocolErrorMessage(
  code: RuntimeProtocolErrorCode,
  detail: string = RUNTIME_PROTOCOL_ERROR_MESSAGES[code],
): string {
  return `[${code}] ${detail}`
}

export function sameRuntimeOwner(left: RuntimeOwner, right: RuntimeOwner): boolean {
  return left.sessionId === right.sessionId
    && left.connectionGeneration === right.connectionGeneration
}

export function sameRuntimeExecution(
  left: ExecutionId,
  right: ExecutionId,
): boolean {
  return left.projectId === right.projectId
    && left.runId === right.runId
    && left.nonce === right.nonce
    && sameRuntimeOwner(left.owner, right.owner)
}

export function sameRuntimeProjection(
  left: RuntimeProjection,
  right: RuntimeProjection,
): boolean {
  return left.workspaceRevision === right.workspaceRevision
    && left.generation === right.generation
    && left.loadedBuild.buildId === right.loadedBuild.buildId
    && left.loadedBuild.sourceRevision === right.loadedBuild.sourceRevision
}

export function sameRuntimeIdentity(
  left: RuntimeIdentity,
  right: RuntimeIdentity,
): boolean {
  return sameRuntimeExecution(left.execution, right.execution)
    && sameRuntimeProjection(left.projection, right.projection)
}

export function advanceRuntimeProjection(
  current: RuntimeProjection,
  expected: RuntimeProjectionExpectation,
  workspaceRevision: string,
  loadedBuild: RuntimeBuildRef = current.loadedBuild,
): RuntimeProjection {
  if (current.workspaceRevision !== expected.workspaceRevision
    || current.generation !== expected.generation) {
    throw new RuntimeProtocolError(
      'RUNTIME_PROJECTION_STALE',
      'Runtime projection changed before commit',
    )
  }
  return {
    workspaceRevision,
    generation: current.generation + 1,
    loadedBuild,
  }
}

export function runtimeCommandOutcomeMessage(outcome: RuntimeCommandOutcome): string {
  switch (outcome.status) {
    case 'succeeded':
      return 'Runtime Harness command succeeded'
    case 'failed':
      return `[${outcome.code}] Runtime Harness ${outcome.stage} failed: ${outcome.message}`
    case 'cancelled':
      return `[RUNTIME_COMMAND_CANCELLED] ${outcome.reason}`
    case 'expired':
      return `[RUNTIME_COMMAND_EXPIRED] Runtime Harness ${outcome.stage} timed out`
  }
}
