'use strict';
const host = require('internal/host');
const native = operation => host.osNative(operation, []);
let hooks;
const sharedSettings = new Map([['directory', 0], ['filename', 1], ['compact', 2], ['reportOnFatalError', 3]]);
const booleanFlags = new Map([
  ['--report-compact', 'compact'], ['--report-exclude-env', 'excludeEnv'],
  ['--report-exclude-network', 'excludeNetwork'], ['--report-on-fatalerror', 'reportOnFatalError'],
  ['--report-on-signal', 'reportOnSignal'], ['--report-uncaught-exception', 'reportOnUncaughtException'],
]);
const stringFlags = new Map([
  ['--report-directory', 'directory'], ['--report-dir', 'directory'],
  ['--report-filename', 'filename'], ['--report-signal', 'signal'],
]);
const optionEntries = [['--experimental-report', false]];
for (const name of booleanFlags.keys()) optionEntries.push([name, false], ['--no-' + name.slice(2), false]);
for (const name of stringFlags.keys()) optionEntries.push([name, true]);
function processWideOption(name) {
  if (name.startsWith('--no-')) name = '--' + name.slice(5);
  return sharedSettings.has(booleanFlags.get(name) || stringFlags.get(name));
}
function invalid(name, type) {
  return Object.assign(new TypeError(`The "${name}" argument must be of type ${type}.`), { code: 'ERR_INVALID_ARG_TYPE' });
}
function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(name, 'object');
}
function javascriptStack(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return { message: String(error), errorProperties: {} };
  }
  let stack;
  try { stack = error.stack; } catch {}
  const lines = typeof stack === 'string' ? stack.split('\n') : [];
  const properties = {};
  for (const key of Object.keys(error)) {
    if (key === 'stack' || key === 'message') continue;
    try { Object.defineProperty(properties, key, { value: String(error[key]), enumerable: true, configurable: true, writable: true }); } catch {}
  }
  return {
    message: lines.length ? lines[0] : 'No stack.',
    stack: lines.length ? lines.slice(1).filter(line => /^\s*at /.test(line)).map(line => line.trim()) : ['Unavailable.'],
    errorProperties: properties,
  };
}
function synthetic() {
  const error = new Error('JavaScript Callstack');
  Object.defineProperty(error, 'name', { value: 'Error [ERR_SYNTHETIC]', configurable: true, writable: true });
  error.code = 'ERR_SYNTHETIC';
  return error;
}
function createReport(process) {
  const settings = {
    directory: '', filename: '', compact: false, excludeNetwork: false, signal: 'SIGUSR2',
    reportOnFatalError: false, reportOnSignal: false, reportOnUncaughtException: false, excludeEnv: false,
  };
  for (const [key, field] of sharedSettings) {
    Object.defineProperty(settings, key, {
      enumerable: true, configurable: true,
      get() { return host.workerNative('reportGet', [field]); },
      set(value) { host.workerNative('reportSet', [field, value]); },
    });
  }
  let sequence = 0;
  let writing = false;
  function snapshot(error, event, trigger, filename) {
    const os = require('os');
    const now = new Date();
    const uname = native('uname');
    const memory = process.memoryUsage();
    const usage = process.resourceUsage();
    const thread = native('threadResourceUsage');
    const elapsed = Math.max(process.uptime(), 1);
    const networkInterfaces = [];
    if (!settings.excludeNetwork) {
      const interfaces = os.networkInterfaces();
      for (const name of Object.keys(interfaces)) {
        for (const item of interfaces[name]) {
          const entry = { name, internal: item.internal, mac: item.mac, address: item.address, netmask: item.netmask, family: item.family };
          if (item.scopeid !== undefined) entry.scopeid = item.scopeid;
          networkInterfaces.push(entry);
        }
      }
    }
    const header = {
      reportVersion: 5, event, trigger, filename, dumpEventTime: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      dumpEventTimeStamp: String(now.getTime()), processId: process.pid,
      threadId: require('worker_threads').threadId, cwd: process.cwd(),
      commandLine: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
      nodejsVersion: process.version, wordSize: 64, arch: process.arch, platform: process.platform,
      componentVersions: { ...process.versions }, release: { ...process.release },
      osName: uname[0], osRelease: uname[1], osVersion: uname[2], osMachine: uname[3],
      cpus: os.cpus().map(cpu => ({ model: cpu.model, speed: cpu.speed, ...cpu.times })), host: os.hostname(),
    };
    if (!settings.excludeNetwork) header.networkInterfaces = networkInterfaces;
    const limitNames = ['core_file_size_blocks', 'data_seg_size_bytes', 'file_size_blocks', 'max_locked_memory_bytes',
      'max_memory_size_bytes', 'open_files', 'stack_size_bytes', 'cpu_time_seconds', 'max_user_processes', 'virtual_memory_bytes'];
    const limits = native('userLimits');
    const userLimits = {};
    limitNames.forEach((name, index) => { userLimits[name] = { soft: limits[index * 2] ?? 'unlimited', hard: limits[index * 2 + 1] ?? 'unlimited' }; });
    const sharedObjects = native('sharedObjects').map(name => name || process.execPath);
    const nativeStack = native('nativeStack').map(symbol => {
      const pc = symbol.match(/0x[0-9a-fA-F]+/);
      return pc ? { pc: pc[0], symbol } : { symbol };
    });
    const report = {
      header, javascriptStack: javascriptStack(error),
      javascriptHeap: { totalMemory: memory.heapTotal, usedMemory: memory.heapUsed, externalMemory: memory.external, arrayBuffers: memory.arrayBuffers },
      nativeStack,
      resourceUsage: {
        free_memory: os.freemem(), total_memory: os.totalmem(), rss: memory.rss, available_memory: process.availableMemory(),
        userCpuSeconds: usage.userCPUTime / 1e6, kernelCpuSeconds: usage.systemCPUTime / 1e6,
        cpuConsumptionPercent: (usage.userCPUTime + usage.systemCPUTime) / 1e4 / elapsed,
        userCpuConsumptionPercent: usage.userCPUTime / 1e4 / elapsed, kernelCpuConsumptionPercent: usage.systemCPUTime / 1e4 / elapsed,
        maxRss: usage.maxRSS * 1024,
        pageFaults: { IORequired: usage.majorPageFault, IONotRequired: usage.minorPageFault }, fsActivity: { reads: usage.fsRead, writes: usage.fsWrite },
      },
      uvthreadResourceUsage: {
        userCpuSeconds: thread[0] / 1e6, kernelCpuSeconds: thread[1] / 1e6,
        cpuConsumptionPercent: (thread[0] + thread[1]) / 1e4 / elapsed,
        userCpuConsumptionPercent: thread[0] / 1e4 / elapsed, kernelCpuConsumptionPercent: thread[1] / 1e4 / elapsed,
        fsActivity: { reads: thread[9], writes: thread[10] },
      },
      libuv: host.nativeResourceReport(), userLimits, sharedObjects,
      silkjs: {
        engine: 'SilkJS',
        unsupported: {
          javascriptHeap: ['executableMemory', 'totalCommittedMemory', 'availableMemory', 'totalGlobalHandlesMemory', 'usedGlobalHandlesMemory',
            'memoryLimit', 'mallocedMemory', 'peakMallocedMemory', 'nativeContextCount', 'detachedContextCount', 'doesZapGarbage', 'heapSpaces'],
        },
      },
    };
    report.workers = JSON.parse(host.workerNative('reportWorkers', []));
    if (!settings.excludeEnv) report.environmentVariables = { ...process.env };
    return report;
  }
  function filename() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `report.${date}.${time}.${process.pid}.${require('worker_threads').threadId}.${String(++sequence).padStart(3, '0')}.json`;
  }
  function write(file, error, event, trigger) {
    if (writing) return '';
    writing = true;
    try {
      const selected = file || settings.filename || filename();
      const stdio = selected === 'stdout' || selected === 'stderr';
      const path = settings.directory ? require('path').join(settings.directory, selected) : selected;
      const fs = require('fs');
      let fd;
      if (stdio) fd = selected === 'stdout' ? 1 : 2;
      else {
        try { fd = fs.openSync(path, 'w', 0o666); }
        catch (error) {
          process.stderr.write(`\nFailed to open Node.js report file: ${selected}${settings.directory ? ` directory: ${settings.directory}` : ''} (errno: ${Math.abs(error.errno || 0)})\n`);
          return '';
        }
        process.stderr.write(`\nWriting Node.js report to file: ${selected}\n`);
      }
      try {
        const text = JSON.stringify(snapshot(error, event, trigger, selected), null, settings.compact ? undefined : 2) + '\n';
        host.osNative('reportWrite', [fd, text]);
      } finally { if (!stdio) fs.closeSync(fd); }
      if (!stdio) process.stderr.write('Node.js report completed\n');
      return selected;
    } finally { writing = false; }
  }
  function signalHandler() { automatic({}, 'Signal', settings.signal); }
  function configureSignal(signal, enabled) {
    process.removeListener(settings.signal, signalHandler);
    if (enabled) process.on(signal, signalHandler);
    settings.signal = signal;
    settings.reportOnSignal = enabled;
  }
  const report = {
    writeReport(file, error) {
      if (file !== null && typeof file === 'object') { error = file; file = undefined; }
      else if (file !== undefined) {
        if (typeof file !== 'string') throw invalid('file', 'string');
        if (file.includes('\0')) throw Object.assign(new TypeError('The argument \'file\' must be a string without null bytes.'), { code: 'ERR_INVALID_ARG_VALUE' });
      }
      if (error === undefined) error = synthetic(); else object(error, 'err');
      return write(file, error, 'JavaScript API', 'API');
    },
    getReport(error) {
      if (error === undefined) error = synthetic(); else object(error, 'err');
      return snapshot(error, 'JavaScript API', 'GetReport', null);
    },
  };
  for (const key of Object.keys(settings)) {
    Object.defineProperty(report, key, {
      enumerable: true, configurable: true,
      get() { return settings[key]; },
      set(value) {
        const expected = typeof settings[key];
        if (typeof value !== expected) throw invalid(key.startsWith('reportOn') ? 'trigger' : key, expected);
        if (key === 'signal' && !Object.hasOwn(require('os').constants.signals, value)) {
          throw Object.assign(new TypeError(`Unknown signal: ${value}`), { code: 'ERR_UNKNOWN_SIGNAL' });
        }
        if (key === 'signal' || key === 'reportOnSignal') {
          configureSignal(key === 'signal' ? value : settings.signal,
            key === 'reportOnSignal' ? value : settings.reportOnSignal);
          return;
        }
        settings[key] = value;
      },
    });
  }
  function automatic(error, trigger, event = trigger) {
    try { write(undefined, error, event, trigger); }
    catch (failure) {
      // Reporting must never replace the original fatal/uncaught exception.
      try { process.stderr.write(`Failed to write diagnostic report: ${String(failure)}\n`); } catch {}
    }
  }
  hooks = {
    onUncaughtException(error) { if (settings.reportOnUncaughtException) automatic(error, 'Exception'); },
    onFatalError(error) { if (settings.reportOnFatalError) automatic(error, 'FatalError'); },
    inherit(options) {
      configureSignal(options.signal, options.reportOnSignal);
      settings.reportOnUncaughtException = options.reportOnUncaughtException;
    },
    applyOption(arg) {
      if (arg === '--experimental-report') return true; // Reports are always available.
      const negative = arg.startsWith('--no-');
      const name = negative ? '--' + arg.slice(5) : arg;
      const boolean = booleanFlags.get(name);
      if (boolean !== undefined) {
        if (!sharedSettings.has(boolean) || require('worker_threads').isMainThread) report[boolean] = !negative;
        return true;
      }
      const separator = arg.indexOf('=');
      if (separator < 0) return false;
      const property = stringFlags.get(arg.slice(0, separator));
      if (property === undefined) return false;
      const value = arg.slice(separator + 1);
      // CLI signal names are raw options; the public property setter validates.
      if (property === 'signal') configureSignal(value, true);
      else if (require('worker_threads').isMainThread) report[property] = value;
      return true;
    },
  };
  return report;
}
module.exports = {
  createReport,
  optionEntries, processWideOption,
  isValueOption(name) { return stringFlags.has(name); },
  applyOption(arg) { return hooks.applyOption(arg); },
  inherit(options) { hooks.inherit(options); },
  onUncaughtException(error) { hooks?.onUncaughtException(error); },
  onFatalError(error) { hooks?.onFatalError(error); },
};
