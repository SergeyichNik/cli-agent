import type { Tool } from '../base.js';

export const helloWorldTool: Tool = {
  name: 'hello_world',
  description: 'Выводит "hello world" в консоль',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  requiresConfirmation: false,
  async execute() {
    console.log('hello world');
    return 'Выведено "hello world" в консоль';
  },
};