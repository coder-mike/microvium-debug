import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('Activated microvium-debug');
	let disposable = vscode.commands.registerCommand('microvium-debug.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from test!');
  });
	context.subscriptions.push(disposable);
}

export function deactivate() {}