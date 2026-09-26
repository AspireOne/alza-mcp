import type { AuthMode, Provider } from "../domain/contracts.js";
import type { Operation } from "./operation.js";

export interface Document {
  url: string;
  html: string;
  status: number | null;
  headers: Record<string, string>;
}
export interface Reader {
  readonly provider: Provider;
  readonly canPost: boolean;
  readonly context: string;
  page(url: string, options?: { detail?: boolean }): Promise<Document>;
  json(url: string, body?: unknown): Promise<unknown>;
}
export interface Access {
  run<T>(op: Operation, work: (reader: Reader) => Promise<T>, expectedContext?: string): Promise<T>;
  status(): unknown;
  close(): Promise<void>;
}
export interface BrowserOptions { auth: AuthMode; signal?: AbortSignal }
