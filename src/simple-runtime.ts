import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import { unexpected } from './utils';

export interface MockBreakpoint {
  id: number;
  line: number;
  verified: boolean;
}

export type Event =
  | 'stopOnEntry'
  | 'stopOnStep'
  | 'end'
  | 'output'
  | 'stopOnDataBreakpoint'
  | 'stopOnException'
  | 'stopOnBreakpoint'
  | 'breakpointValidated'

export class SimpleRuntime extends EventEmitter {
  private lastGeneratedBreakpointId = 1;
  private currentLineByFile = new Map<string, number>();
  private sourceLinesByFile = new Map<string, string[]>();
  private breakPointsByFile = new Map<string, MockBreakpoint[]>();
  // TODO | HIGH | Raf: What is this exactly for??
  private breakPointAddresses = new Set<string>();

  // ..................................
  // Public methods
  // ..................................

  public start(entryPointFile: string, stopOnEntry: boolean) {
    this.cacheSourceLines(entryPointFile, this.extractSourceLines(entryPointFile));

    if (stopOnEntry) {
      this.stopOnEntry(entryPointFile);
    } else {
      // we just start to run until we hit a breakpoint or an exception
      this.continue(entryPointFile, 'forwards');
    }
  }

  public stopOnEntry(file: string) {
    this.run(file, 'forwards', 'stopOnEntry');
  }

  public continue(file: string, direction: 'forwards' | 'backwards') {
    this.run(file, direction, undefined);
  }

  public step(file: string, direction: 'forwards' | 'backwards') {
    this.run(file, direction, 'stopOnStep');
  }

  /**
 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
 */
  public stack(file: string, startFrame: number, endFrame: number): any {
    const sourceLines = this.extractSourceLines(file);
    const currentLine = this.currentLineByFile.get(file);
    if (currentLine === undefined) {
      return unexpected(`current line for file: ${file} is ${currentLine}`);
    }

    const words = sourceLines[currentLine].trim().split(/\s+/);

    const frames = new Array<any>();
    // every word of the current line becomes a stack frame.
    for (let i = startFrame; i < Math.min(endFrame, words.length); i++) {
      const name = words[i];	// use a word of the line as the stackframe name
      frames.push({
        index: i,
        name: `${name}(${i})`,
        file: file,
        line: currentLine
      });
    }
    return {
      frames: frames,
      count: words.length
    };
  }

  // Regular breakpoints
  public getBreakpoints(file: string, lineNumber: number): number[] {
    const sourceLine = this.extractSourceLines(file)[lineNumber];
    let sawSpace = true;
    const bps: number[] = [];
    for (let i = 0; i < sourceLine.length; i++) {
      if (sourceLine[i] !== ' ') {
        if (sawSpace) {
          bps.push(i);
          sawSpace = false;
        }
      } else {
        sawSpace = true;
      }
    }
    return bps;
  }

  public setBreakPoint(file: string, line: number): MockBreakpoint {
    const bp: MockBreakpoint = { verified: false, line, id: this.lastGeneratedBreakpointId++ };
    let bps = this.breakPointsByFile.get(file);
    if (!bps) {
      bps = [];
      this.breakPointsByFile.set(file, bps);
    }
    bps.push(bp);
    this.verifyBreakpoints(file);
    return bp;
  }

  public clearBreakPoint(file: string, line: number): MockBreakpoint | undefined {
    let bps = this.breakPointsByFile.get(file);
    if (bps) {
      const index = bps.findIndex(bp => bp.line === line);
      if (index >= 0) {
        const bp = bps[index];
        bps.splice(index, 1);
        return bp;
      }
    }
    return undefined;
  }

  public clearBreakpoints(file: string) { this.breakPointsByFile.delete(file); }

  // Data breakpoints
  public setDataBreakpoint(address: string): boolean {
    if (address) {
      this.breakPointAddresses.add(address);
      return true;
    }
    return false;
  }

  public clearAllDataBreakpoints() { this.breakPointAddresses.clear(); }


  // ..................................
  // Private methods
  // ..................................

  private verifyBreakpoints(file: string): void {
    const bpsOfFile = this.breakPointsByFile.get(file);
    if (bpsOfFile) {
      const sourceLines = this.extractSourceLines(file);
      bpsOfFile.forEach(bp => {
        if (!bp.verified && bp.line < sourceLines.length) {
          const srcLine = sourceLines[bp.line].trim();

          // if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
          if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
            bp.line++;
          }
          // if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
          if (srcLine.indexOf('-') === 0) {
            bp.line--;
          }
          // don't set 'verified' to true if the line contains the word 'lazy'
          // in this case the breakpoint will be verified 'lazy' after hitting it once.
          if (srcLine.indexOf('lazy') < 0) {
            bp.verified = true;
            this.sendEvent('breakpointValidated', bp);
          }
        }
      });
    }
  }

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
  private run(file: string, direction: 'forwards' | 'backwards', event?: Event) {
    let currentLine = this.currentLineByFile.get(file);
    if (currentLine === undefined) {
      currentLine = -1;
      this.currentLineByFile.set(file, currentLine);
    }

    // Backwards
    if (direction === 'backwards') {
      for (let lineNumber = currentLine - 1; lineNumber >= 0; lineNumber--) {
        const stopAfterProcessingLine = this.processSourceLine(file, lineNumber, event);
        if (stopAfterProcessingLine) {
          this.currentLineByFile.set(file, lineNumber);
          return;
        }
      }
      // no more lines: stop at first line
      this.currentLineByFile.set(file, 0);
      this.sendEvent('stopOnEntry');
      return;
    }

    // Forwards
    const sourceLines = this.extractSourceLines(file);
    for (let lineNumber = currentLine + 1; lineNumber < sourceLines.length; lineNumber++) {
      const stopAfterProcessingLine = this.processSourceLine(file, lineNumber, event);
      if (stopAfterProcessingLine) {
        this.currentLineByFile.set(file, lineNumber);
        return;
      }
    }

    // No more lines: run to end
    this.sendEvent('end');
  }

  // TODO | HIGH | Raf: Document why this returns a boolean
  private processSourceLine(file: string, lineNumber: number, event?: Event): boolean {
    const sourceLines = this.extractSourceLines(file);
    const sourceLine = sourceLines[lineNumber];

    // if 'log(...)' found in source -> send argument to debug console
    const matches = /log\((.*)\)/.exec(sourceLine);
    if (matches && matches.length === 2) {
      this.sendEvent('output', matches[1], file, lineNumber, matches.index);
    }

    // if a word in a line matches a data breakpoint, fire a 'dataBreakpoint' event
    const words = sourceLine.split(' ');
    for (let word of words) {
      if (this.breakPointAddresses.has(word)) {
        this.sendEvent('stopOnDataBreakpoint');
        return true;
      }
    }

    // if word 'exception' found in source -> throw exception
    if (sourceLine.indexOf('exception') >= 0) {
      this.sendEvent('stopOnException');
      return true;
    }

    // is there a breakpoint?
    const breakpoints = this.breakPointsByFile.get(file);
    if (breakpoints) {
      const bps = breakpoints.filter(bp => bp.line === lineNumber);
      if (bps.length > 0) {

        // send 'stopped' event
        this.sendEvent('stopOnBreakpoint');

        // the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
        // if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
        if (!bps[0].verified) {
          bps[0].verified = true;
          this.sendEvent('breakpointValidated', bps[0]);
        }
        return true;
      }
    }

    // non-empty line
    if (event && sourceLine.length > 0) {
      this.sendEvent(event);
      return true;
    }

    // nothing interesting found -> continue
    return false;
  }

  private cacheSourceLines(file: string, sourceLines: string[]) {
    this.sourceLinesByFile.set(file, sourceLines);
  }

  private extractSourceLines(file: string) {
    const cached = this.sourceLinesByFile.get(file);
    if (cached) return cached;

    const sourceLines = fs
      .readFileSync(file, 'utf8')
      .split(os.EOL)
      .map(l => l.trim());
    this.cacheSourceLines(file, sourceLines);
    return sourceLines;
  }


  private sendEvent(event: Event, ...args: any[]) {
    setImmediate(() => this.emit(event, ...args));
  }
}