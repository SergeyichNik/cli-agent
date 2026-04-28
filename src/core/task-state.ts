export type TaskState = 'planning' | 'execution' | 'validation' | 'done' | 'paused' | 'error';

export type Intent =
  | 'NEW_TASK'
  | 'CLARIFICATION'
  | 'PAUSE'
  | 'RESUME'
  | 'CONFIRM'
  | 'QUESTION'
  | 'OTHER';

export interface Task {
  task: string;      // original user request
  state: TaskState;
  step: number;      // current step index (0-based)
  total: number;     // total planned steps
  plan: string[];    // approved plan
  done: string[];    // completed step descriptions
  current: string;   // current step description
}

const TRANSITIONS: Record<TaskState, Partial<Record<Intent, TaskState>>> = {
  planning: {
    CONFIRM: 'execution',
    NEW_TASK: 'planning',
    CLARIFICATION: 'planning',
    QUESTION: 'planning',
    OTHER: 'planning',
    PAUSE: 'paused',
  },
  execution: {
    CONFIRM: 'validation',
    NEW_TASK: 'planning',
    CLARIFICATION: 'execution',
    QUESTION: 'execution',
    OTHER: 'execution',
    PAUSE: 'paused',
  },
  validation: {
    CONFIRM: 'done',
    OTHER: 'execution',
    CLARIFICATION: 'execution',
    NEW_TASK: 'planning',
    PAUSE: 'paused',
  },
  done: {
    NEW_TASK: 'planning',
    OTHER: 'planning',
  },
  paused: {
    NEW_TASK: 'planning',
    OTHER: 'paused',
    // RESUME handled explicitly in transition()
  },
  error: {
    NEW_TASK: 'planning',
    OTHER: 'planning',
  },
};

export class TaskStateMachine {
  state: TaskState = 'planning';
  task: Task | null = null;
  private previousState: TaskState = 'planning';

  checkTransitionGuard(intent: Intent): { allowed: boolean; reason?: string } {
    // planning → execution: plan must be set
    if (intent === 'CONFIRM' && this.state === 'planning') {
      if (!this.task || this.task.plan.length === 0) {
        return { allowed: false, reason: 'Cannot move to execution: no plan has been defined yet. Present a complete plan first.' };
      }
    }
    // execution → validation: all steps must be done
    if (intent === 'CONFIRM' && this.state === 'execution') {
      if (this.task && this.task.step < this.task.total) {
        const remaining = this.task.total - this.task.step;
        return { allowed: false, reason: `Cannot move to validation: ${remaining} step(s) still incomplete. Finish all steps first.` };
      }
    }
    return { allowed: true };
  }

  transition(intent: Intent): TaskState {
    if (intent === 'PAUSE' && this.state !== 'paused' && this.state !== 'done') {
      this.previousState = this.state;
      this.state = 'paused';
      if (this.task) this.task.state = 'paused';
      return this.state;
    }
    if (intent === 'RESUME' && this.state === 'paused') {
      this.state = this.previousState;
      if (this.task) this.task.state = this.state;
      return this.state;
    }

    const next = TRANSITIONS[this.state]?.[intent];
    if (next) {
      this.state = next;
      if (this.task) this.task.state = next;
    }
    return this.state;
  }

  setTask(taskText: string): void {
    this.task = {
      task: taskText,
      state: 'planning',
      step: 0,
      total: 0,
      plan: [],
      done: [],
      current: '',
    };
    this.state = 'planning';
  }

  setPlan(plan: string[]): void {
    if (!this.task || plan.length === 0) return;
    this.task.plan = plan;
    this.task.total = plan.length;
    this.task.step = 0;
    this.task.done = [];
    this.task.current = plan[0] ?? '';
  }

  completeStep(): void {
    if (!this.task) return;
    const { plan, step } = this.task;
    if (step < plan.length) {
      this.task.done.push(plan[step]);
      this.task.step = step + 1;
      this.task.current = plan[step + 1] ?? '';
    }
  }

  loadTask(task: Task): void {
    this.task = { ...task };
    this.state = task.state;
    // Restore previousState heuristic: if paused, assume was in execution
    if (task.state === 'paused') {
      this.previousState = 'execution';
    }
  }

  forceError(): void {
    this.state = 'error';
    if (this.task) this.task.state = 'error';
  }

  forceDone(): void {
    this.state = 'done';
    if (this.task) this.task.state = 'done';
  }

  toJSON(): string {
    return this.task ? JSON.stringify(this.task) : '';
  }
}

export interface ParsedMeta {
  intent: Intent;
  plan?: string[];
  step_done?: boolean;
  options?: string[];
  recommended?: number; // index into options array
  rawLine: string;
}

export function parseMetadataLine(text: string): ParsedMeta | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"intent"')) continue;
    try {
      const obj = JSON.parse(trimmed) as { intent?: Intent; plan?: string[]; step_done?: boolean; options?: string[]; recommended?: number };
      return {
        intent: obj.intent ?? 'OTHER',
        plan: Array.isArray(obj.plan) && obj.plan.length > 0 ? obj.plan : undefined,
        step_done: obj.step_done === true ? true : undefined,
        options: Array.isArray(obj.options) && obj.options.length > 0 ? obj.options : undefined,
        recommended: typeof obj.recommended === 'number' ? obj.recommended : undefined,
        rawLine: trimmed,
      };
    } catch {
      // not valid JSON, skip
    }
  }
  return null;
}

export function stripMetadataLine(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t.startsWith('{') || !t.includes('"intent"')) return true;
      try {
        JSON.parse(t);
        return false;
      } catch {
        return true;
      }
    })
    .join('\n')
    .trimEnd();
}
