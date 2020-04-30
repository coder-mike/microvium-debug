import * as vscode from 'vscode';
import { StoppedEvent, LoggingDebugSession, logger, Logger, InitializedEvent, Breakpoint, StackFrame, Source, BreakpointEvent, OutputEvent, TerminatedEvent, Thread, Handles, Scope } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { SimpleRuntime, MockBreakpoint } from './simple-runtime';
import { unexpected } from './utils';
import * as fs from 'fs';
import { VirtualMachineFriendly } from 'microvium';
import { EventEmitter } from 'events';
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
  private debuggerEventEmitter = new EventEmitter();

  constructor() {
    super("microvium-debug.txt");
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
    // console.log('Init args', JSON.stringify(args, null, 2));
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

    this.debuggerEventEmitter.on('from-app:stop-on-entry', () => this.sendEvent(new StoppedEvent('entry', threadId)));
    this.debuggerEventEmitter.on('from-app:stop-on-step', () => this.sendEvent(new StoppedEvent('step', threadId)));
    this.debuggerEventEmitter.on('from-app:stop-on-breakpoint', () => this.sendEvent(new StoppedEvent('breakpoint', threadId)));

    const vm = new VirtualMachineFriendly(undefined, {}, {}, this.debuggerEventEmitter);
    try {
      vm.importNow({ sourceText: fs.readFileSync(args.program, 'utf8'), debugFilename: args.program });
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * Called at the end of the configuration sequence.
   * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
   */
  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    args: DebugProtocol.ConfigurationDoneArguments
  ): void {
    super.configurationDoneRequest(response, args);

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
    this.debuggerEventEmitter.emit('from-debugger:stack-request');

    const stackFrames = await new Promise<any[]>(resolve => {
      this.debuggerEventEmitter.once('from-app:stack', resolve);
    });

    // console.log('debugger:stack-received');
    // console.log(JSON.stringify(stackFrames, null, 2));

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
            '{test-data}'
          ),
          this.convertDebuggerLineToClient(data.line),
          this.convertDebuggerColumnToClient(data.column)
        )
      ),
      totalFrames: stackFrames.length
    };

    // console.log('debugger:stack-response');
    // console.log(JSON.stringify(response.body.stackFrames, null, 2));
    this.sendResponse(response);
  }

  protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): void {
    response.body = {
      scopes: [{
        name: '{scope}',
        variablesReference: 0,
        expensive: false
      }]
    }
    this.sendResponse(response);
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    this.debuggerEventEmitter.emit('from-debugger:continue-request');
    this.sendResponse(response);
  }

  // protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
  //   this.runtime.continue(this.entryPointFile!, 'backwards');
  //   this.sendResponse(response);
  // }

  protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
    this.debuggerEventEmitter.emit('from-debugger:step-request');
    this.sendResponse(response);
  }

  // protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
  //   this.sendResponse(response);
  // }

  // protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
  //   const file = args.source.path || unexpected();
  //   const clientLines = args.lines || [];

  //   // clear all breakpoints for this file
  //   this.runtime.clearBreakpoints(file);

  //   // set and verify breakpoint locations
  //   const actualBreakpoints = clientLines.map(l => {
  //     let { verified, line, id } = this.runtime.setBreakPoint(file, this.convertClientLineToDebugger(l));
  //     const bp = <DebugProtocol.Breakpoint>new Breakpoint(verified, this.convertDebuggerLineToClient(line));
  //     bp.id = id;
  //     return bp;
  //   });

  //   // send back the actual breakpoint positions
  //   response.body = {
  //     breakpoints: actualBreakpoints
  //   };
  //   this.sendResponse(response);
  // }

  // protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
  //   if (args.source.path) {
  //     const bps = this.runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line));
  //     response.body = {
  //       breakpoints: bps.map(col => {
  //         return {
  //           line: args.line,
  //           column: this.convertDebuggerColumnToClient(col)
  //         }
  //       })
  //     };
  //   } else {
  //     response.body = {
  //       breakpoints: []
  //     };
  //   }
  //   this.sendResponse(response);
  // }

}