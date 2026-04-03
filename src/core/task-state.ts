export type TaskState = 'IDLE' | 'PLANNING' | 'EXECUTING' | 'PAUSED' | 'VALIDATION' | 'DONE' | 'ERROR';

export type Intent =
  | 'NEW_TASK'
  | 'CLARIFICATION'
  | 'PAUSE'
  | 'RESUME'
  | 'CONFIRM'
  | 'QUESTION'
  | 'OTHER';

const TRANSITIONS: Record<TaskState, Partial<Record<Intent, TaskState>>> = {
  IDLE: {
    NEW_TASK: 'PLANNING',
    QUESTION: 'IDLE',
    OTHER: 'IDLE',
    CLARIFICATION: 'IDLE',
  },
  PLANNING: {
    CONFIRM: 'EXECUTING',
    NEW_TASK: 'PLANNING',
    CLARIFICATION: 'PLANNING',
    QUESTION: 'PLANNING',
    OTHER: 'EXECUTING',
  },
  EXECUTING: {
    PAUSE: 'PAUSED',
    CONFIRM: 'VALIDATION',
    OTHER: 'EXECUTING',
    QUESTION: 'EXECUTING',
    CLARIFICATION: 'EXECUTING',
  },
  PAUSED: {
    RESUME: 'EXECUTING',
    OTHER: 'PAUSED',
  },
  VALIDATION: {
    CONFIRM: 'DONE',
    OTHER: 'EXECUTING',
    CLARIFICATION: 'EXECUTING',
  },
  DONE: {
    NEW_TASK: 'PLANNING',
    OTHER: 'IDLE',
  },
  ERROR: {
    NEW_TASK: 'PLANNING',
    OTHER: 'IDLE',
  },
};

export class TaskStateMachine {
  state: TaskState = 'IDLE';

  transition(intent: Intent): TaskState {
    const next = TRANSITIONS[this.state]?.[intent];
    if (next) this.state = next;
    return this.state;
  }

  forceError(): void {
    this.state = 'ERROR';
  }

  forceDone(): void {
    this.state = 'DONE';
  }
}

export function parseMetadataLine(text: string): { intent: Intent; rawLine: string } | null {
  const lineMatch = text.match(/\{[^}\n]*"intent"[^}\n]*\}/);
  if (!lineMatch) return null;
  try {
    const obj = JSON.parse(lineMatch[0]) as { intent: Intent };
    return { intent: obj.intent ?? 'OTHER', rawLine: lineMatch[0] };
  } catch {
    return null;
  }
}

export function stripMetadataLine(text: string): string {
  return text.replace(/[ \t]*\{[^\n]*"intent"[^\n]*\}\n?/g, '').trimEnd();
}
