import type { Message } from '../providers/base.js';

export type TaskState = 'IDLE' | 'PLANNING' | 'EXECUTING' | 'PAUSED' | 'VALIDATION' | 'DONE' | 'ERROR';

export class SessionMemory {
  readonly sessionId: string;
  messages: Message[] = [];
  taskState: TaskState = 'IDLE';
  currentTask: string | null = null;
  consecutiveToolErrors = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  addMessage(msg: Message): void {
    this.messages.push(msg);
  }
}
