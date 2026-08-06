export type JobSource = "linkedin" | "twitter" | "generic";

export type ApplicationStatus =
  | "discovered"
  | "drafted"
  | "ready-for-review"
  | "filled"
  | "submitted"
  | "rejected"
  | "failed";

export interface JobQuestion {
  id: string;
  label: string;
  required: boolean;
  kind: "text" | "textarea" | "boolean" | "single" | "multi";
  options?: string[];
}

export interface JobPosting {
  id: string;
  url: string;
  source: JobSource;
  title: string;
  company: string;
  description: string;
  descriptionHash: string;
  questions: JobQuestion[];
  discoveredAt: string;
}

export interface JobApplicationDraft {
  id: string;
  posting: JobPosting;
  coverLetter: string;
  answers: Record<string, string>;
  rationale: Record<string, string>;
  missingFacts: string[];
  memoryIds: string[];
  resumeMarkdownPath?: string;
  resumePdfPath?: string;
  status: ApplicationStatus;
  createdAt: string;
  updatedAt: string;
  approvalId?: string;
  submittedAt?: string;
  submissionUrl?: string;
  error?: string;
}

export interface JobApplicationSummary {
  total: number;
  discovered: number;
  drafted: number;
  readyForReview: number;
  filled: number;
  submitted: number;
  rejected: number;
  failed: number;
}

export interface JobPageSnapshot {
  url: string;
  title: string;
  company: string;
  description: string;
  questions: JobQuestion[];
  capturedAt: string;
}
