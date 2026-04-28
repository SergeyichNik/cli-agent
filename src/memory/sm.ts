import type { Message } from '../providers/base.js';
import { TaskStateMachine } from '../core/task-state.js';

export class SessionMemory {
  readonly sessionId: string;
  messages: Message[] = [];
  taskMachine: TaskStateMachine = new TaskStateMachine();
  consecutiveToolErrors = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  addMessage(msg: Message): void {
    this.messages.push(msg);
  }
}
