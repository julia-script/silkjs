'use strict';

const { Interface } = require('readline');
const { kAddNewLineOnTTY, kMultilinePrompt, kLastCommandErrored } = require('internal/readline/interface');
const vm = require('vm');
const { inspect, types } = require('util');
const domain = require('domain');
const { Console } = require('console');
const Module = require('module');
const addBuiltinGlobals = require('internal/loader/builtin_globals');
const path = require('path');
const fs = require('fs');
const { kStandaloneREPL, Recoverable, isRecoverableError, isValidSyntax, rememberBindings } = require('internal/repl/syntax');
const { complete } = require('internal/repl/completion');
const { setupPreview } = require('internal/repl/preview');
const host = require('internal/host');
const REPL_MODE_SLOPPY = Symbol('repl-sloppy');
const REPL_MODE_STRICT = Symbol('repl-strict');
const kDomainError = Symbol('repl-domain-error');
const replDomains = new WeakSet();
process.prependListener('newListener', (event, listener) => {
  if (event === 'uncaughtException' && replDomains.has(process.domain) &&
      listener !== domain._clear && listener.name !== 'domainUncaughtExceptionClear') {
    throw Object.assign(new TypeError('Listeners for `uncaughtException` cannot be used in the REPL'), { code: 'ERR_INVALID_REPL_INPUT' });
  }
});
let resource = 0;
let builtinModules = Module.builtinModules.filter(name => !name.startsWith('_') && !name.startsWith('node:'));
const writer = value => inspect(value, writer.options);
writer.options = { ...inspect.defaultOptions, showProxy: true };
function invalid(name, type) {
  return Object.assign(new TypeError(`The "${name}" argument must be of type ${type}`), { code: 'ERR_INVALID_ARG_TYPE' });
}
function emitDomainError(error, callback) {
  const active = process.domain;
  if (!active) { callback(error); return; }
  active.emit('error', error);
  active.exit();
}

function defaultEval(code, context, filename, callback) {
  if (!code.trim()) { callback(null); return; }
  let source = code;
  let transformed = false;
  let script;
  let result;
  try {
    if (/^\s*\{/.test(code) && !/;\s*$/.test(code) && isValidSyntax(code)) source = `(${code.trim()})\n`;
    if (source.includes('await')) {
      const wrapped = require('internal/repl/await').processTopLevelAwait(source);
      if (wrapped !== null) { source = wrapped; transformed = true; }
    }
    if (this.replMode === REPL_MODE_STRICT) source = `'use strict'; void 0;\n${source}`;
    try { script = new vm.Script(source, { filename }); }
    catch (error) {
      if (source !== code && !transformed && this.replMode !== REPL_MODE_STRICT) script = new vm.Script(code, { filename });
      else throw error;
    }
  } catch (error) {
    callback(error instanceof Recoverable || isRecoverableError(error, code) ? new Recoverable(error.err || error) : error);
    return;
  }
  try {
    let guard;
    let previousRawMode;
    let rawModeChanged = false;
    try {
      if (this.breakEvalOnSigint) {
        guard = host.workerNative('startSigintWatch', []);
        previousRawMode = this._setRawMode(false);
        rawModeChanged = true;
      }
      const options = { breakOnSigint: this.breakEvalOnSigint };
      result = this.useGlobal ? script.runInThisContext(options) : script.runInContext(context, options);
    } finally {
      if (guard !== undefined) {
        try { if (rawModeChanged) this._setRawMode(previousRawMode); }
        finally { if (host.workerNative('stopSigintWatch', [guard])) this.emit('SIGINT'); }
      }
    }
  } catch (error) { emitDomainError(error, callback); return; }
  if (transformed) {
    Promise.resolve(result).then(value => callback(null, value && value.value), error => {
      if (error && process.domain) emitDomainError(error, callback);
      else callback(error);
    });
  } else callback(null, result);
}

function REPLServer(prompt, stream, eval_, useGlobal, ignoreUndefined, replMode) {
  if (!(this instanceof REPLServer)) return new REPLServer(prompt, stream, eval_, useGlobal, ignoreUndefined, replMode);
  let options;
  if (prompt && typeof prompt === 'object') options = { ...prompt };
  else options = { prompt, stream, eval: eval_, useGlobal, ignoreUndefined, replMode };
  stream = options.stream || options.socket || process;
  const input = options.input || stream.stdin || stream;
  const output = options.output || stream.stdout || stream;
  if (options.breakEvalOnSigint && options.eval) {
    throw Object.assign(new TypeError('Cannot specify both "breakEvalOnSigint" and "eval" for REPL'), { code: 'ERR_INVALID_REPL_EVAL_CONFIG' });
  }
  for (const name of ['eval', 'writer', 'completer']) if (options[name] !== undefined && typeof options[name] !== 'function') throw invalid(`options.${name}`, 'function');
  this[kStandaloneREPL] = !!options[kStandaloneREPL];
  this.useGlobal = !!options.useGlobal;
  this.ignoreUndefined = !!options.ignoreUndefined;
  this.replMode = options.replMode || REPL_MODE_SLOPPY;
  this.allowBlockingCompletions = !!options.allowBlockingCompletions;
  const terminal = options.terminal === undefined ? !!output.isTTY : !!options.terminal;
  this.useColors = options.useColors === undefined ? terminal && !!require('internal/util/colors').shouldColorize(output) : !!options.useColors;
  this.breakEvalOnSigint = !!options.breakEvalOnSigint;
  this.editorMode = false;
  this.last = undefined;
  this.lastError = undefined;
  this._bufferedCommand = '';
  this._queue = [];
  this._keyQueue = [];
  this._evaluating = false;
  this._draining = false;
  this._inputClosed = false;
  this._exitEmitted = false;
  this._sawSIGINT = false;
  this.commands = Object.create(null);
  this.writer = options.writer || module.exports.writer;
  // The REPL `node` starts is reachable from inside itself as repl.repl, and owns
  // util.inspect.replDefaults.
  if (options[kStandaloneREPL]) module.exports.repl = this;
  if (this.writer === writer) {
    writer.options.colors = this.useColors;
    if (options[kStandaloneREPL]) {
      Object.defineProperty(inspect, 'replDefaults', {
        get() { return writer.options; },
        set(value) {
          if (value === null || typeof value !== 'object') throw invalid('options', 'object');
          return Object.assign(writer.options, value);
        },
        enumerable: true, configurable: true,
      });
    }
  }
  this._domain = options.domain || domain.create();
  replDomains.add(this._domain);
  this.eval = this._domain.bind(options.eval || defaultEval.bind(this));
  Interface.call(this, {
    input, output, terminal,
    prompt: options.prompt === undefined ? '> ' : options.prompt,
    completer: options.completer || complete.bind(this),
    history: options.history,
    historySize: options.historySize,
    removeHistoryDuplicates: options.removeHistoryDuplicates,
    crlfDelay: Infinity,
  });
  this.resetContext();
  this._preview = setupPreview(this, options.preview !== false && !options.eval,
    () => this.replMode === REPL_MODE_STRICT);
  this._domain.on('error', error => {
    if (this._preview) this._preview.cancel();
    if (error !== null && typeof error === 'object' && error.domainThrown) {
      delete error.domain;
      delete error.domainThrown;
    }
    this.lines.level = [];
    if (this._activeFinish) this._activeFinish(error, undefined, kDomainError);
    else {
      this.clearBufferedCommand();
      if (this._writeError(error)) this.displayPrompt();
      this._drain();
    }
  });
  defineCommands(this);
  for (const [alias, name] of [['inputStream', 'input'], ['outputStream', 'output']]) {
    const pending = require('internal/options').getOptionValue('--pending-deprecation');
    const message = 'repl.inputStream and repl.outputStream are deprecated. Use repl.input and repl.output instead';
    const get = () => this[name], set = value => { this[name] = value; };
    Object.defineProperty(this, alias, {
      configurable: true,
      get: pending ? require('util').deprecate(get, message, 'DEP0141') : get,
      set: pending ? require('util').deprecate(set, message, 'DEP0141') : set,
    });
  }
  this.on('line', line => {
    if (this._closeScheduled) return;
    this._sawSIGINT = false;
    this._queue.push([line ?? '', this.terminal]);
    this._drain();
  });
  this.on('close', () => { this._inputClosed = true; this._maybeExit(); });
  this.on('SIGINT', () => this._interrupt());
  this.on('SIGCONT', () => this.displayPrompt(true));
  const ttyWrite = this._ttyWrite.bind(this);
  this._ttyWrite = (text, key = {}) => {
    if (this._evaluating && !(key.ctrl && key.name === 'c')) { this._keyQueue.push([text, key]); return; }
    if (this._preview) this._preview.beforeKey(key);
    try {
      if (this.editorMode && key.ctrl && key.name === 'd') {
        this.editorMode = false;
        const source = this._bufferedCommand + this.line;
        this.clearBufferedCommand();
        this.line = '';
        this.cursor = 0;
        this.output.write('\n');
        this._queue.push([source, false]);
        this._drain();
        return;
      }
      ttyWrite(text, key);
    } finally {
      if (this._preview) this._preview.afterKey(key);
    }
  };
  this.displayPrompt();
}
Object.setPrototypeOf(REPLServer.prototype, Interface.prototype);
Object.setPrototypeOf(REPLServer, Interface);

REPLServer.prototype.createContext = function createContext() {
  const context = this.useGlobal ? globalThis : vm.createContext();
  this._globalNames = this.useGlobal ? Object.getOwnPropertyNames(globalThis) : vm.runInContext('Object.getOwnPropertyNames(globalThis)', context);
  if (!this.useGlobal) {
    const intrinsics = new Set(this._globalNames);
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (!intrinsics.has(name)) Object.defineProperty(context, name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    context.global = context;
    Object.defineProperty(context, 'console', { configurable: true, writable: true, value: new Console(this.output) });
  }
  const filename = path.join(process.cwd(), 'repl');
  const replModule = new Module('<repl>');
  replModule.filename = filename;
  replModule.paths = Module._nodeModulePaths(process.cwd());
  const contextRequire = Module.createRequire(filename);
  Object.defineProperties(context, {
    module: { configurable: true, writable: true, value: replModule },
    require: { configurable: true, writable: true, value: contextRequire },
  });
  addBuiltinGlobals(context, '<REPL>');
  return context;
};
REPLServer.prototype.resetContext = function resetContext() {
  this.context = this.createContext();
  this.underscoreAssigned = false;
  this.underscoreErrAssigned = false;
  this._bindings = new Set();
  this.lines = [];
  this.lines.level = [];
  for (const [name, value, assigned] of [['_', 'last', 'underscoreAssigned'], ['_error', 'lastError', 'underscoreErrAssigned']]) {
    Object.defineProperty(this.context, name, {
      configurable: true,
      get: () => this[value],
      set: result => {
        this[value] = result;
        if (!this[assigned]) { this[assigned] = true; this.output.write(`Expression assignment to ${name} now disabled.\n`); }
      },
    });
  }
  this.emit('reset', this.context);
};
REPLServer.prototype.clearBufferedCommand = function clearBufferedCommand() {
  this._bufferedCommand = '';
  this._terminalMemoryIndex = undefined;
};
REPLServer.prototype.setPrompt = function setPrompt(prompt) {
  this._initialPrompt = String(prompt);
  Interface.prototype.setPrompt.call(this, prompt);
};
REPLServer.prototype.displayPrompt = function displayPrompt(preserveCursor) {
  if (this.closed) return;
  if (this._preview) this._preview.cancel();
  Interface.prototype.setPrompt.call(this, this.editorMode ? '' : this._bufferedCommand ? kMultilinePrompt.description : this._initialPrompt);
  this.prompt(preserveCursor);
};
REPLServer.prototype.complete = function completeLine(line, callback) { return this.completer(line, callback); };
REPLServer.prototype.defineCommand = function defineCommand(keyword, command) {
  if (typeof keyword !== 'string') throw invalid('keyword', 'string');
  if (typeof command === 'function') command = { action: command };
  if (!command || typeof command.action !== 'function') throw invalid('cmd.action', 'function');
  this.commands[keyword] = command;
};
REPLServer.prototype.setupHistory = function setupHistory(historyConfig = {}, cb) {
  // historyConfig can be a string for backwards compatibility.
  const options = typeof historyConfig === 'string' ? { filePath: historyConfig } : historyConfig;
  if (typeof cb === 'function') options.onHistoryFileLoaded = cb;
  this.setupHistoryManager(options);
};
REPLServer.prototype.close = function close() {
  if (this._closeScheduled || this.closed) return;
  if (this.terminal && this.historyManager.isFlushing && !this._closingOnFlush) {
    this._closingOnFlush = true;
    this.once('flushHistory', () => Interface.prototype.close.call(this));
    return;
  }
  if (this._preview) this._preview.cancel();
  this._closeScheduled = true;
  process.nextTick(() => Interface.prototype.close.call(this));
};
REPLServer.prototype._maybeExit = function maybeExit() {
  if (!this._inputClosed || this._evaluating || this._queue.length || this._exitEmitted) return;
  this._exitEmitted = true;
  this.emit('exit');
};
// Node's debugDomainError: cut the stack below the REPL's own code, then print it as
// "Uncaught <error>", or hand it to the process's listeners in the standalone REPL.
REPLServer.prototype._writeError = function writeError(e) {
  let errStack = '';
  if (typeof e === 'object' && e !== null) {
    const { overrideStackTrace, ErrorPrepareStackTrace } = require('internal/error_stack');
    overrideStackTrace.set(e, (error, stackFrames) => {
      let frames;
      if (typeof stackFrames === 'object') {
        // Everything from the last frame without a function name down is the REPL's machinery.
        const idx = stackFrames.findLastIndex(frame => frame.getFunctionName() === null);
        frames = stackFrames.slice(0, idx);
      } else frames = stackFrames;
      if (typeof Error.prepareStackTrace === 'function') return Error.prepareStackTrace(error, frames);
      return ErrorPrepareStackTrace(error, frames);
    });
    if (e.domainThrown) { delete e.domain; delete e.domainThrown; }
    if (types.isNativeError(e) || e instanceof Error) {
      if (e.stack) {
        if (e.name === 'SyntaxError') {
          e.stack = e.stack.replace(/^REPL\d+:\d+\r?\n/, '').replace(/^\s+at\s.*\n?/gm, '');
        } else if (this.replMode === REPL_MODE_STRICT) {
          e.stack = e.stack.replace(/(\s+at\s+REPL\d+:)(\d+)/, (_, pre, line) => pre + (line - 1));
        }
      }
      errStack = this.writer(e);
      // Remove one line error braces to keep the old style in place.
      if (errStack[0] === '[' && errStack[errStack.length - 1] === ']') errStack = errStack.slice(1, -1);
    }
  }
  if (!this.underscoreErrAssigned) this.lastError = e;
  if (this[kStandaloneREPL] && process.listenerCount('uncaughtException') !== 0) {
    process.nextTick(() => {
      process.emit('uncaughtException', e);
      this.clearBufferedCommand();
      this.lines.level = [];
      if (!this.closed) this.displayPrompt();
    });
    return false;
  }
  if (errStack === '') errStack = this.writer(e);
  const lines = String(errStack).split(/(?<=\n)/);
  let matched = false;
  errStack = '';
  for (const line of lines) {
    if (!matched && /^\[?([A-Z][a-z0-9_]*)*Error/.exec(line) !== null) {
      errStack += writer.options.breakLength >= line.length ? `Uncaught ${line}` : `Uncaught:\n${line}`;
      matched = true;
    } else errStack += line;
  }
  if (!matched) errStack = `Uncaught${lines.length === 1 ? ' ' : ':\n'}${errStack}`;
  errStack += errStack.endsWith('\n') ? '' : '\n';
  this.output.write(errStack);
  return true;
};
REPLServer.prototype._interrupt = function interrupt() {
  if (this._preview) this._preview.cancel();
  if (this._activeFinish) {
    const error = Object.assign(new Error('Script execution was interrupted by `SIGINT`'), { code: 'ERR_SCRIPT_EXECUTION_INTERRUPTED' });
    this._activeFinish(error);
    return;
  }
  const empty = !this.line && !this._bufferedCommand && !this.editorMode;
  this.clearLine();
  this.editorMode = false;
  this.clearBufferedCommand();
  if (empty && this._sawSIGINT) { this.close(); return; }
  this._sawSIGINT = empty;
  if (empty) this.output.write('(To exit, press Ctrl+C again or Ctrl+D or type .exit)\n');
  this.displayPrompt();
};
REPLServer.prototype._drain = function drain() {
  if (this._draining || this._evaluating) return;
  this._draining = true;
  try {
    while (!this._evaluating && this._queue.length) this._processLine(...this._queue.shift());
  } finally { this._draining = false; }
  this._maybeExit();
};
REPLServer.prototype._processLine = function processLine(line, ttyInput) {
  if (this.editorMode) { this._bufferedCommand += line + '\n'; this.displayPrompt(); return; }
  const keyword = /^\.([^\s]+)\s*(.*)$/.exec(line.trim());
  if (keyword && keyword[1][0] !== '.' && Number.isNaN(parseFloat(line.trim()))) {
    const command = this.commands[keyword[1]];
    if (command) {
      try { command.action.call(this, keyword[2]); }
      catch (error) { this._writeError(error); this.displayPrompt(); }
      return;
    }
    if (!this._bufferedCommand) { this.output.write('Invalid REPL keyword\n'); this.displayPrompt(); return; }
  }
  const code = this._bufferedCommand + line + '\n';
  if (this._terminalMemoryIndex === undefined) this.lines.push(line);
  else this.lines[this._terminalMemoryIndex] = line;
  this._evaluating = true;
  let finished = false;
  const finish = (...args) => {
    if (finished) return;
    finished = true;
    this._activeFinish = undefined;
    const [error, value] = args;
    const fromDomain = args[2] === kDomainError;
    const failed = fromDomain || !!error;
    const recoverable = !fromDomain && error instanceof Recoverable;
    const domainWillPrompt = failed && !recoverable && !fromDomain;
    try {
      if (recoverable) {
        if (ttyInput && !this._bufferedCommand && !this.closed) {
          this._terminalMemoryIndex = this.lines.length - 1;
          this[kAddNewLineOnTTY]();
        } else this._bufferedCommand = code;
      }
      else {
        this.clearBufferedCommand();
        this[kLastCommandErrored] = failed;
        if (fromDomain) this._writeError(error);
        else if (failed) this._domain.emit('error', error.err || error);
        else {
          rememberBindings(code, this._bindings);
          if (args.length > 1 && (!this.ignoreUndefined || value !== undefined)) {
            if (!this.underscoreAssigned) this.last = value;
            try { this.output.write(this.writer(value) + '\n'); }
            catch (writerError) { this._writeError(writerError); }
          }
        }
      }
    } finally {
      this._evaluating = false;
      if (!domainWillPrompt && !(recoverable && ttyInput && !this._bufferedCommand)) this.displayPrompt();
      while (!this._evaluating && this._keyQueue.length && !this.closed) {
        const [text, key] = this._keyQueue.shift();
        this._ttyWrite(text, key);
      }
      this._drain();
    }
  };
  this._activeFinish = finish;
  this.eval(code, this.context, 'REPL' + ++resource, finish);
};

function defineCommands(server) {
  server.defineCommand('break', { help: 'Sometimes you get stuck, this gets you out', action() { this.clearBufferedCommand(); this.editorMode = false; this.displayPrompt(); } });
  server.defineCommand('clear', {
    help: server.useGlobal ? 'Alias for .break' : 'Break, and also clear the local context',
    action() {
      this.clearBufferedCommand();
      if (!this.useGlobal) { this.output.write('Clearing context...\n'); this.resetContext(); }
      this.displayPrompt();
    },
  });
  server.defineCommand('exit', { help: 'Exit the REPL', action() { this._queue.length = 0; this.close(); } });
  server.defineCommand('help', {
    help: 'Print this help message',
    action() {
      const names = Object.keys(this.commands).sort();
      const width = Math.max(...names.map(name => name.length));
      for (const name of names) this.output.write('.' + name + (this.commands[name].help ? ' '.repeat(width - name.length + 3) + this.commands[name].help : '') + '\n');
      this.output.write('\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n');
      this.displayPrompt();
    },
  });
  server.defineCommand('save', {
    help: 'Save all evaluated commands in this REPL session to a file',
    action(filename) {
      try {
        if (!filename) { this.output.write('The "file" argument must be specified\n'); return; }
        fs.writeFileSync(filename, this.lines.join('\n'));
        this.output.write(`Session saved to: ${filename}\n`);
      } catch { this.output.write(`Failed to save: ${filename}\n`); }
      finally { this.displayPrompt(); }
    },
  });
  server.defineCommand('load', {
    help: 'Load JS from a file into the REPL session',
    action(filename) {
      try {
        if (!filename) { this.output.write('The "file" argument must be specified\n'); this.displayPrompt(); return; }
        if (!fs.statSync(filename).isFile()) { this.output.write(`Failed to load: ${filename} is not a valid file\n`); this.displayPrompt(); return; }
        this._queue.unshift([fs.readFileSync(filename, 'utf8'), false]);
        this._drain();
      } catch { this.output.write(`Failed to load: ${filename}\n`); this.displayPrompt(); }
    },
  });
  if (server.terminal) server.defineCommand('editor', {
    help: 'Enter editor mode',
    action() {
      this.editorMode = true;
      Interface.prototype.setPrompt.call(this, '');
      this.output.write('// Entering editor mode (Ctrl+D to finish, Ctrl+C to cancel)\n');
    },
  });
}
function start(...args) { return new REPLServer(...args); }
module.exports = { start, writer, REPLServer, REPL_MODE_SLOPPY, REPL_MODE_STRICT, Recoverable, isValidSyntax };
{
  const pendingDeprecation = require('internal/options').getOptionValue('--pending-deprecation');
  for (const [name, code] of [['builtinModules', 'DEP0191'], ['_builtinLibs', 'DEP0142']]) {
    const message = `repl.${name} is deprecated. Check module.builtinModules instead`;
    const get = () => builtinModules;
    const set = value => { builtinModules = value; };
    Object.defineProperty(module.exports, name, {
      configurable: true, enumerable: false,
      get: pendingDeprecation ? require('util').deprecate(get, message, code) : get,
      set: pendingDeprecation ? require('util').deprecate(set, message, code) : set,
    });
  }
}
