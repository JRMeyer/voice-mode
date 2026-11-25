// Types for narration.mjs, so Claude Code's hooks module (hooks/register.ts) can import it.

export const NARRATOR: string;
export const ASK: {
  start(prompt: string, said?: string[]): string;
  progress(prompt: string, steps: string[], event?: string, said?: string[]): string;
  end(prompt: string, answer: string, steps?: string[], said?: string[]): string;
};
export const FALLBACK: {
  progress(): string;
  end(prompt: string, answer: string): string;
};
export function stripTags(text: string): string;
export function addSaid(said: string[], text: string): string[];
export function wantsQuiet(text: string): boolean;
export function wantsVoice(text: string): boolean;
export const ACKS: string[];
export function pickAck(last?: number): number;
export function describeCall(tool: string, input: unknown): string;
export function activityOf(tool: string, input?: unknown): 'read' | 'write' | 'delete' | 'run' | 'web';
export function approvalLine(tool: string): string;
export function questionLine(input: unknown): string;
export function afterStep(
  turn: { steps: string[]; lastSpoke: number; t0: number },
  step: string,
  started: number,
  now?: number,
): { event: string | undefined; due: boolean };
export function resultTone(answer: string, steps: string[], t0: number): string;
