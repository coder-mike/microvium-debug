import * as vscode from 'vscode';
import { LoggingDebugSession } from 'vscode-debugadapter';

export function activate(context: vscode.ExtensionContext) {
  console.log('actuvated!')
  context.subscriptions.push(vscode.commands.registerCommand('microvium-debug.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from test!');
  }));

  const factory: vscode.DebugAdapterDescriptorFactory = {
		createDebugAdapterDescriptor(
      session: vscode.DebugSession,
      executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
      console.log('x createDebugAdapterDescriptor');
		  return new vscode.DebugAdapterInlineImplementation(new MicroviumDebugSession());
    }
  };
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('microviumdebug', factory));
}

export function deactivate() {}

class MicroviumDebugSession extends LoggingDebugSession {
  constructor() {
    super();
    console.log('MicroviumDebugSession ctr')
  }
}