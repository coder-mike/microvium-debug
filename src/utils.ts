export function unexpected(message?: string): never {
  throw new Error('Unexpected: ' + (message || '<No message>'));
}