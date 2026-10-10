import type { Token } from "./drive";

export type StepStatus = "pending" | "running" | "ok" | "warn" | "fail" | "stopped";
export type JobStatus = "idle" | "running" | "done" | "errors" | "failed" | "stopped";

export type Progress = { pct: number; n: number; total: number; done: number; err: number; rate: number; eta: string };

export type LogLine = { t: string; status: string; id: string; name: string; err: string | null };

export type JobState = {
  status: JobStatus;
  steps: { name: string; status: StepStatus }[];
  console: string[];
  live: string;
  progress: Progress | null;
  scanned: number | null;
  root: string | null;
  rootName: string | null;
  authExpired: boolean;
  items: LogLine[];
};

export type RootRow = { id: string; name: string; done: number; skip: number; todo: number; err: number };

export type StartMsg = { cmd: "start"; mode?: "retry"; root: string; emailA: string; emailB: string; tokens: { A: Token; B: Token } };
export type ToWorker = StartMsg | { cmd: "stop" } | { cmd: "roots" } | { cmd: "state" }
  | { cmd: "forget"; root: string } | { cmd: "clearAll" };
export type FromWorker = { type: "state"; state: JobState } | { type: "roots"; roots: RootRow[] } | { type: "error"; error: string };
