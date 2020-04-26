import * as vscode from 'vscode';
import { StoppedEvent, LoggingDebugSession, logger, Logger, InitializedEvent, Breakpoint, StackFrame, Source, BreakpointEvent, OutputEvent, TerminatedEvent, Thread, Handles, Scope } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { SimpleRuntime, MockBreakpoint } from './simple-runtime';
import { unexpected } from './utils';
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
  private runtime = new SimpleRuntime();

  private configurationDone = new AwaitNotifySubject();
  // TODO | HIGH | Raf: What are these?
  private variableHandles = new Handles<string>();

  // TODO | HIGH | Raf: Think about how to handle commands that potentially jump
  // from 1 file to another like `continue`, `step`
  /** Currently, SimpleRuntime assumes that there is only 1 file being debugged
  (i.e. no references to other files). */
  private entryPointFile: string | undefined = undefined;

  constructor() {
    super("microvium-debug.txt");

    // setup event handlers
    this.runtime.on('stopOnEntry', () => {
      this.sendEvent(new StoppedEvent('entry', threadId));
    });
    this.runtime.on('stopOnStep', () => {
      this.sendEvent(new StoppedEvent('step', threadId));
    });
    this.runtime.on('stopOnBreakpoint', () => {
      this.sendEvent(new StoppedEvent('breakpoint', threadId));
    });
    this.runtime.on('stopOnDataBreakpoint', () => {
      this.sendEvent(new StoppedEvent('data breakpoint', threadId));
    });
    this.runtime.on('stopOnException', () => {
      this.sendEvent(new StoppedEvent('exception', threadId));
    });
    this.runtime.on('breakpointValidated', (bp: MockBreakpoint) => {
      this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
    });
    this.runtime.on('output', (text, filePath, line, column) => {
      const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);

      if (text === 'start' || text === 'startCollapsed' || text === 'end') {
        e.body.group = text;
        e.body.output = `group-${text}\n`;
      }

      e.body.source = this.createSource(filePath);
      e.body.line = this.convertDebuggerLineToClient(line);
      e.body.column = this.convertDebuggerColumnToClient(column);
      this.sendEvent(e);
    });
    this.runtime.on('end', () => {
      this.sendEvent(new TerminatedEvent());
    });
  }

  // TODO | HIGH | Raf: What does this do, exactly?
  private createSource(filePath: string): Source {
    return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
    logger.init(event => console.log('Event: ', event.body && event.body.output));
    logger.setup(Logger.LogLevel.Verbose);

    // Wait until configuration has finished (and configurationDoneRequest has been called)
    await this.configurationDone.wait(1000);

    this.entryPointFile = args.program;
    this.runtime.start(args.program, !!args.stopOnEntry);

    this.sendResponse(response);
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

  protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

    const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
    const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
    const endFrame = startFrame + maxLevels;

    const stack = this.runtime.stack(this.entryPointFile!, startFrame, endFrame);

    response.body = {
      stackFrames: stack.frames.map((f: any) => new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line))),
      totalFrames: stack.count
    };
    this.sendResponse(response);
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    this.runtime.continue(this.entryPointFile!, 'forwards');
    this.sendResponse(response);
  }

  protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
    this.runtime.continue(this.entryPointFile!, 'backwards');
    this.sendResponse(response);
  }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    this.runtime.step(this.entryPointFile!, 'forwards');
    this.sendResponse(response);
  }

  protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
    this.runtime.step(this.entryPointFile!, 'backwards');
    this.sendResponse(response);
  }

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