import * as vscode from 'vscode';
import { StoppedEvent, LoggingDebugSession, logger, Logger, InitializedEvent, Breakpoint, StackFrame, Source, BreakpointEvent, OutputEvent, TerminatedEvent, Thread, Handles, Scope } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { SimpleRuntime, MockBreakpoint } from './simple-runtime';
import { unexpected } from './utils';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
const { Subject: AwaitNotifySubject } = require('await-notify');

const threadId = 1;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('microvium-debug.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from test!');
  }));

  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('microvium-debug', new MicroviumDebugAdapterDescriptorFactory()));
}

export function deactivate() { }

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
  private configurationDone = new AwaitNotifySubject();
  private debugClientWebSocketOpen = new AwaitNotifySubject();
  // TODO | HIGH | Raf: Fix the code so this event emitter isn't needed
  private debuggerEventEmitter = new EventEmitter();
  private debugClientWebSocket: typeof WebSocket; 

  constructor() {
    super("microvium-debug.txt");

    this.debuggerEventEmitter.on('from-app:stop-on-entry', () => this.sendEvent(new StoppedEvent('entry', threadId)));
    this.debuggerEventEmitter.on('from-app:stop-on-step', () => this.sendEvent(new StoppedEvent('step', threadId)));
    this.debuggerEventEmitter.on('from-app:stop-on-breakpoint', () => this.sendEvent(new StoppedEvent('breakpoint', threadId)));

    this.debugClientWebSocket = new WebSocket('ws://localhost:8080', {});
    this.debugClientWebSocket.on('message', (messageStr: string) => {
      console.log('WS MESSAGE:', messageStr);
      const { type, data } = JSON.parse(messageStr);
      this.debuggerEventEmitter.emit(type, data);
    });
    this.debugClientWebSocket.on('open', () => {
      this.sendToVM({ type: 'from-debugger:start-session' });
      this.debugClientWebSocketOpen.notify();
      console.log('Open sesame');
    });
  }

  private sendToVM(message: { type: string, data?: any }) {
    this.debugClientWebSocket.send(JSON.stringify(message));
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  protected async initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments
  ) {
    console.log('Init args', JSON.stringify(args, null, 2));
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());

  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
    logger.init(event => console.log('Event: ', event.body && event.body.output));
    logger.setup(Logger.LogLevel.Verbose);

    // It seems like Babel(?) starts lines at 1. Also, I can't figure out how to
    // set InitializeRequestArguments.linesStartAt1 or columnsStartAt1 (luckily
    // they both default to 1 so things just work out). The debugger lines and
    // columns start at 0 by default and luckily they're set-able here, so
    // again, things just work out for us :D
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);

    // Wait until configuration has finished (and configurationDoneRequest has been called)
    await this.configurationDone.wait(1000);

  }

  /**
   * Called at the end of the configuration sequence.
   * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
   */
  protected async configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    args: DebugProtocol.ConfigurationDoneArguments
  ) {
    super.configurationDoneRequest(response, args);

    // await this.debugClientWebSocketOpen.wait(1000);

    // Notify the launchRequest that configuration has finished
    this.configurationDone.notify();
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    // runtime supports no threads so just return a default thread.
    response.body = {
      threads: [
        new Thread(threadId, "thread 1")
      ]
    };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
    console.log('FROM DEBUGGER: STACK REQUEST');
    this.sendToVM({ type: 'from-debugger:stack-request'});

    const stackFrames = await new Promise<any[]>(resolve => {
      this.debuggerEventEmitter.once('from-app:stack', resolve);
    });
    console.log('FROM APP: STACK');

    response.body = {
      stackFrames: stackFrames.map((data, i) =>
        new StackFrame(
          i + (args.startFrame || 0),
          basename(data.filePath),
          new Source(
            basename(data.filePath),
            this.convertDebuggerPathToClient(data.filePath),
            undefined,
            undefined,
            '{placeholder-source-data}'
          ),
          this.convertDebuggerLineToClient(data.line),
          this.convertDebuggerColumnToClient(data.column)
        )
      ),
      totalFrames: stackFrames.length
    };

    this.sendResponse(response);
  }

  protected async scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments,
    request?: DebugProtocol.Request
  ) {
    console.log('FROM DEBUGGER: SCOPES REQUEST');
    this.sendToVM({ type: 'from-debugger:scopes-request' });
    const scopes = await new Promise<DebugProtocol.Scope[]>(resolve =>
      this.debuggerEventEmitter.on('from-app:scopes', resolve));
    console.log('FROM APP: SCOPES', JSON.stringify(scopes, null, 2));

    response.body = { scopes };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
    request?: DebugProtocol.Request
  ) {
    console.log('DEBUGGER: VARIABLES REQUEST', JSON.stringify(args.variablesReference));
    this.sendToVM({ type: 'from-debugger:variables-request', data: args.variablesReference });
    const variables = await new Promise<DebugProtocol.Variable[]>(resolve =>
      this.debuggerEventEmitter.on('from-app:variables', resolve));
    response.body = { variables };
    this.sendResponse(response);
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    this.sendToVM({ type: 'from-debugger:continue-request' });
    this.sendResponse(response);
  }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
    this.sendToVM({ type: 'from-debugger:step-request' });
    this.sendResponse(response);
  }

  /** 
   * Called as part of the initialization event and whenever the user
   * adds/removes/updates breakpoints 
   */
  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ) {
    // QUESTION When can this happen?
    if (!args.source.path) return;

    // For some reason, this is one of the first requests so we have to make
    // sure that the WS connection is ready
    await this.debugClientWebSocketOpen.wait(1500);

    // TODO Account for source being modified (see args.sourceModified)
    this.sendToVM({
      type: 'from-debugger:set-and-verify-breakpoints', data: {
        filePath: args.source.path,
        breakpoints: args.breakpoints || []
      }
    });

    const verifiedBreakpoints = await new Promise<DebugProtocol.SourceBreakpoint[]>(resolve =>
      this.debuggerEventEmitter.once('from-app:verified-breakpoints', resolve))
      // TODO Look into what happens if a Source object was passed into the
      // Breakpoint constructor
      // TODO Also, look into whether BP IDs are needed
      .then(bps => bps.map(bp => new Breakpoint(true, bp.line, bp.column)));

    response.body = { breakpoints: verifiedBreakpoints };
    this.sendResponse(response);
  }

  protected async breakpointLocationsRequest(
    response: DebugProtocol.BreakpointLocationsResponse,
    args: DebugProtocol.BreakpointLocationsArguments,
  ) {
    if (!args.source.path) return;

    this.sendToVM({ type: 'from-debugger:get-breakpoints', data: { filePath: args.source.path } });
    const breakpoints: DebugProtocol.SourceBreakpoint[] =
      await new Promise(resolve => this.debuggerEventEmitter.once('from-app:breakpoints', resolve));

    response.body = {
      // TODO What are endLine/Column for? Also, what about the breakpoint
      // conditions,etc?
      breakpoints: breakpoints.map(bp => ({ line: bp.line, column: bp.column }))
    };
    this.sendResponse(response);
  }

}