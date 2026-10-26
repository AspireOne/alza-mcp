import type { AuthMode, Provider } from "../domain/contracts.js";
import type { Operation } from "./operation.js";

export interface Document {
  url: string;
  html: string;
  status: number | null;
  headers: Record<string, string>;
}
export type DetailSection = "description" | "specifications" | "variants";
/** What shared research logic needs from any backend's per-operation data access. */
export interface Source {
  readonly provider: Provider;
  readonly context: string;
  json(url: string, body?: unknown): Promise<unknown>;
  // Lazy sources must freshly verify this operation before a cache-only result is used.
  verify?(): Promise<void>;
}
export interface Reader extends Source {
  readonly canPost: boolean;
  page(url: string, options?: { detail?: readonly DetailSection[]; stock?: boolean; category?: boolean }): Promise<Document>;
}
export interface Access<S extends Source = Reader> {
  run<T>(op: Operation, work: (source: S) => Promise<T>, expectedContext?: string): Promise<T>;
  status(): Record<string, unknown>;
  close(): Promise<void>;
}
export interface BrowserOptions { auth: AuthMode; signal?: AbortSignal }
