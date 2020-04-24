import * as vscode from 'vscode';
import { DebugSession, StoppedEvent, LoggingDebugSession, logger, Logger, InitializedEvent, Breakpoint } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
const { Subject: AwaitNotifySubject } = require('await-notify');

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('microvium-debug.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from test!');
  }));

  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('microvium-debug', new MicroviumDebugAdapterDescriptorFactory));
}

export function deactivate() {}

class MicroviumDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new MicroviumDebugSession());
  }
};

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  /** An absolute path to the program to debug. */
  program: string;
  /** Automatically stop target after launch. If not specified, target does not stop. */
  stopOnEntry?: boolean;
}

/*

This class is adapted from the mock class example in:

  https://code.visualstudio.com/api/extension-guides/debugger-extension
  https://github.com/microsoft/vscode-mock-debug/blob/master/src/mockDebug.ts

Although this example doesn't use the adapter in a separate process, I think
under the hood it's still exchanging adapter messages (probably not over the
network), so it might help to reference this documentation:

  https://microsoft.github.io/debug-adapter-protocol/

*/

class MicroviumDebugSession extends LoggingDebugSession {
  private _configurationDone = new AwaitNotifySubject();

  constructor() {
    super("microvium-debug.txt");
    logger.setup(Logger.LogLevel.Verbose, false);
  }
  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
    response.body = response.body || {};
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  /**
   * Called at the end of the configuration sequence.
   * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
   */
  protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
    super.configurationDoneRequest(response, args);

    // Notify the launchRequest that configuration has finished
    this._configurationDone.notify();
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
    // Wait until configuration has finished (and configurationDoneRequest has been called)
    await this._configurationDone.wait(1000);

    if (args.stopOnEntry) {
      setImmediate(() => {
        this.sendEvent(new StoppedEvent('entry'));
      })
    }

    this.sendResponse(response);
  }
}