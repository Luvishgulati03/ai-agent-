export type ProviderName = "codex" | "claude";

/**
 * Dispatch tier (MASTER_PLAN §11.1): t0 = nano/triage, t1 = standard
 * implementation, t2 = frontier reasoning. Subscription CLIs only — tiers map
 * to CLI model/effort flags, never to API calls.
 */
export type DispatchTier = "t0" | "t1" | "t2";

export type ActivityKind =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "agent.dispatched"
  | "memory.recalled"
  | "memory.saved"
  | "approval.created"
  | "approval.approved"
  | "approval.executed"
  | "workflow.started"
  | "workflow.completed"
  | "workflow.failed"
  | "gmail.read"
  | "pr.reviewed"
  | "job.discovered"
  | "job.prepared"
  | "job.filled"
  | "job.submitted"
  | "resume.generated"
  | "provider.switched"
  | "task.started"
  | "task.completed"
  | "social.drafted";

export interface ActivityEvent {
  id: string;
  timestamp: string;
  kind: ActivityKind;
  message: string;
  runId?: string;
  role?: string;
  provider?: ProviderName;
  metadata?: Record<string, unknown>;
}

export interface RunResult {
  runId: string;
  provider: ProviderName;
  response: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  events: ProviderEvent[];
}

export interface ProviderEvent {
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
  parsed?: Record<string, unknown>;
}

export interface ApprovalItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  kind: "gmail.send" | "github.review" | "message.send" | "job.application";
  status: "pending" | "approved" | "executing" | "executed" | "rejected" | "failed";
  title: string;
  recipient?: string;
  subject?: string;
  body: string;
  payload: Record<string, unknown>;
  result?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  cron: string;
  kind: "memory.dream" | "gmail.inbox" | "agent.prompt" | "knowledge.distill";
  enabled: boolean;
  prompt?: string;
  /** knowledge.distill only: modules distilled into strategy cards per run (default 15 in the scheduler). */
  batchLimit?: number;
}

export interface ReviewFinding {
  severity: "blocker" | "warning" | "nit";
  title: string;
  body: string;
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
}

export interface ReviewReport {
  id: string;
  repository: string;
  pullRequest: number;
  url?: string;
  verdict: "approved" | "changes-requested" | "blocker";
  summary: string;
  findings: ReviewFinding[];
  passes: Record<string, string>;
  generatedAt: string;
  provider: ProviderName;
  approvalId?: string;
  headSha?: string;
}
