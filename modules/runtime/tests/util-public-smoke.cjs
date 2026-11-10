'use strict';

const assert = require('node:assert/strict');
const util = require('node:util');
const os = require('node:os');
const failCode = (fn, code) => assert.throws(fn, error => error.code === code);
const rejected = (promise, code, cause) => assert.rejects(promise, error => error.code === code && (cause === undefined || error.cause === cause));

async function main() {
  const parsed = util.parseArgs({
    args: ['-vvnfirst', '--name=second', '--no-color', '--', '-file'],
    options: {
      verbose: { type: 'boolean', short: 'v', multiple: true },
      name: { type: 'string', short: 'n', multiple: true, default: ['unused'] },
      color: { type: 'boolean', default: true },
      fallback: { type: 'string', default: 'default' },
    }, allowNegative: true, allowPositionals: true, tokens: true,
  });
  assert.equal(Object.getPrototypeOf(parsed.values), null);
  assert.deepEqual({ ...parsed.values }, { verbose: [true, true], name: ['first', 'second'], color: false, fallback: 'default' });
  assert.deepEqual(parsed.positionals, ['-file']);
  assert.deepEqual(parsed.tokens.map(t => [t.kind, t.index, t.name, t.value, t.inlineValue]), [
    ['option', 0, 'verbose', undefined, undefined],
    ['option', 0, 'verbose', undefined, undefined],
    ['option', 0, 'name', 'first', true],
    ['option', 1, 'name', 'second', true],
    ['option', 2, 'color', undefined, undefined],
    ['option-terminator', 3, undefined, undefined, undefined],
    ['positional', 4, undefined, '-file', undefined],
  ]);
  assert.equal(parsed.tokens[4].rawName, '--no-color');
  const defaults = ['same-array'];
  assert.equal(util.parseArgs({ args: [], options: { x: { type: 'string', multiple: true, default: defaults } } }).values.x, defaults);
  assert.deepEqual({ ...util.parseArgs({ args: ['-x'], options: { first: { type: 'boolean', short: 'x' }, second: { type: 'boolean', short: 'x' } } }).values }, { first: true });
  assert.equal(util.parseArgs({ args: ['--x=a', '--x=b'], options: { x: { type: 'string' } } }).values.x, 'b');
  assert.equal(util.parseArgs({ args: ['--no-x'], allowNegative: true, options: { 'no-x': { type: 'boolean' } } }).values.x, false);
  assert.deepEqual({ ...util.parseArgs({ args: ['--unknown=x', 'p'], strict: false }).values }, { unknown: 'x' });
  assert.deepEqual(util.parseArgs(Object.assign(Object.create({ args: ['--bad'] }), { args: [] })).positionals, []);
  failCode(() => util.parseArgs({ args: ['--unknown'] }), 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
  failCode(() => util.parseArgs({ args: ['position'] }), 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL');
  failCode(() => util.parseArgs({ args: ['--name', '--other'], options: { name: { type: 'string' } } }), 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
  failCode(() => util.parseArgs({ args: ['--name'], options: { name: { type: 'string' } } }), 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
  failCode(() => util.parseArgs({ args: ['--x=false'], options: { x: { type: 'boolean' } } }), 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
  failCode(() => util.parseArgs({ args: [], options: { x: { type: 'boolean', default: 'false' } } }), 'ERR_INVALID_ARG_TYPE');
  failCode(() => util.parseArgs({ args: [], options: { x: { type: 'string', short: 'xx' } } }), 'ERR_INVALID_ARG_VALUE');
  failCode(() => util.parseArgs({ args: [], tokens: 'yes' }), 'ERR_INVALID_ARG_TYPE');
  const poisoned = util.parseArgs({ args: ['--__proto__=x'], strict: false });
  assert.equal(Object.hasOwn(poisoned.values, '__proto__'), false);

  assert.deepEqual(util.parseEnv('Z=first\nexport A="a\\nb" # comment\nB=\' # literal \'\nC=`multi\nline`\nZ=last # comment\r\n'), { A: 'a\nb', B: ' # literal ', C: 'multi\nline', Z: 'last' });
  assert.deepEqual(util.parseEnv('export A=\nB=2'), { B: '2', 'export A': '' });
  assert.deepEqual(util.parseEnv('A= \nB=2'), { A: 'B=2' });
  assert.deepEqual(util.parseEnv('=value\nA=x'), { A: 'x' });
  assert.deepEqual(util.parseEnv('=\nA=x'), { '': '', A: 'x' });
  assert.deepEqual(util.parseEnv('A="unterminated\nB=yes'), { A: '"unterminated', B: 'yes' });
  assert.deepEqual(util.parseEnv('A="a\\"b"\nB=c'), { A: 'a\\', B: 'c' });
  assert.deepEqual(util.parseEnv('#comment\n  #key=value\nA=\ud800'), { '#key': 'value', A: '\ufffd' });
  assert.deepEqual(Object.keys(util.parseEnv('Z=1\nA=2\nZ=3')), ['A', 'Z']);
  assert.equal(Object.hasOwn(util.parseEnv('__proto__=x'), '__proto__'), false);
  failCode(() => util.parseEnv(new String('A=1')), 'ERR_INVALID_ARG_TYPE');

  const mime = new util.MIMEType(' Text/PLAIN ; Charset=UTF-8; charset=ignored; X="a\\"b";empty="";bad');
  assert.equal(mime.essence, 'text/plain');
  assert.equal(mime.params.get('CHARSET'), 'UTF-8');
  assert.deepEqual([...mime.params], [['charset', 'UTF-8'], ['x', 'a"b'], ['empty', '']]);
  const params = mime.params;
  const iterator = params.entries();
  assert.deepEqual(iterator.next().value, ['charset', 'UTF-8']);
  params.delete('X');
  assert.equal(params.set('Y', 'a b'), undefined);
  assert.deepEqual([...iterator], [['empty', ''], ['y', 'a b']]);
  mime.type = 'APPLICATION'; mime.subtype = 'JSON';
  assert.equal(mime.params, params);
  assert.equal(String(mime), 'application/json;charset=UTF-8;empty="";y="a b"');
  assert.equal(mime.toJSON(), String(mime));
  assert.equal(params.get('missing'), null);
  assert.equal(params.has('Y'), true);
  assert.equal(new util.MIMEParams('ignored').toString(), '');
  assert.equal(util.MIMEType.parse('not-a-mime'), null);
  assert.equal(util.MIMEType.parse('IMAGE/PNG').essence, 'image/png');
  failCode(() => params.set('bad name', 'x'), 'ERR_INVALID_MIME_SYNTAX');
  failCode(() => params.set('ok', '\n'), 'ERR_INVALID_MIME_SYNTAX');
  failCode(() => { mime.type = ''; }, 'ERR_INVALID_MIME_SYNTAX');
  failCode(() => new util.MIMEType('text/plain', true), 'ERR_ILLEGAL_CONSTRUCTOR');
  assert.throws(() => util.MIMEType.prototype.toString.call({}), TypeError);
  assert.throws(() => util.MIMEParams.prototype.get.call({}, 'x'), TypeError);
  assert.throws(() => util.MIMEParams.prototype.entries.call({}).next(), TypeError);
  assert.throws(() => new util.MIMEType(Symbol('mime')), TypeError);

  assert.deepEqual(util.diff('abc', 'adc'), [[0, 'a'], [1, 'b'], [-1, 'd'], [0, 'c']]);
  assert.deepEqual(util.diff(['same', 'old'], ['same', 'new']), [[0, 'same'], [1, 'old'], [-1, 'new']]);
  assert.deepEqual(util.diff('', 'ab'), [[-1, 'a'], [-1, 'b']]);
  assert.deepEqual(util.diff('ab', ''), [[1, 'a'], [1, 'b']]);
  assert.deepEqual(util.diff('same', 'same'), []);
  assert.deepEqual(util.diff(1, 1), []);
  failCode(() => util.diff(['ok', 1], []), 'ERR_INVALID_ARG_TYPE');

  assert.equal(util.TextEncoder, globalThis.TextEncoder);
  assert.equal(util.TextDecoder, globalThis.TextDecoder);
  const bytes = new util.TextEncoder().encode('a\ud800\ud83d\ude00');
  assert.equal(new util.TextDecoder().decode(bytes), 'a\ufffd\ud83d\ude00');
  const decoder = new util.TextDecoder();
  assert.equal(decoder.decode(Uint8Array.of(0xe2, 0x82), { stream: true }), '');
  assert.equal(decoder.decode(Uint8Array.of(0xac)), '\u20ac');

  const errors = util.getSystemErrorMap();
  assert.ok(errors.size >= 80);
  for (const [number, pair] of errors) {
    assert.equal(util.getSystemErrorName(number), pair[0]);
    assert.equal(util.getSystemErrorMessage(number), pair[1]);
  }
  const enoent = -os.constants.errno.ENOENT;
  assert.equal(util.getSystemErrorName(enoent), 'ENOENT');
  const originalMessage = util.getSystemErrorMessage(enoent);
  errors.get(enoent)[0] = 'changed'; errors.get(enoent)[1] = 'changed'; errors.clear();
  assert.deepEqual(util.getSystemErrorMap().get(enoent), ['ENOENT', originalMessage]);
  assert.equal(util.getSystemErrorName(-9999), 'Unknown system error -9999');
  assert.equal(util.getSystemErrorMessage(-9999), 'Unknown system error -9999');
  assert.equal(util.getSystemErrorName(-4294967297), 'Unknown system error -4294967297');
  assert.equal(util.getSystemErrorMessage(-4294967297), 'Unknown system error -2147483648');
  for (const value of [0, -0, 1, -0.5, NaN, Infinity, -Infinity, -9007199254740992]) {
    failCode(() => util.getSystemErrorName(value), 'ERR_OUT_OF_RANGE');
    failCode(() => util.getSystemErrorMessage(value), 'ERR_OUT_OF_RANGE');
  }
  failCode(() => util.getSystemErrorName('-2'), 'ERR_INVALID_ARG_TYPE');
  for (const name of Object.keys(os.constants.signals)) assert.equal(util.convertProcessSignalToExitCode(name), 128 + os.constants.signals[name]);
  failCode(() => util.convertProcessSignalToExitCode('sigterm'), 'ERR_INVALID_ARG_VALUE');
  failCode(() => util.convertProcessSignalToExitCode(15), 'ERR_INVALID_ARG_VALUE');

  let receiver, calls = 0;
  const debounced = util.debounce(function named(a, b) { receiver = this; calls++; return a + b; }, 60000);
  assert.equal(debounced.name, 'named'); assert.equal(debounced.length, 2);
  assert.equal(debounced.pending, null);
  const first = debounced(1, 2), second = debounced.call({}, 3, 4);
  assert.equal(debounced.pending, second); assert.equal(debounced.pendingCount, 2);
  assert.equal(debounced.unref().ref(), debounced);
  assert.equal(debounced.flush(), undefined);
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
  assert.equal(receiver, debounced); assert.equal(calls, 1);
  assert.equal(debounced.pending, null); assert.equal(debounced.pendingCount, 0);
  const canceled = debounced(1, 1);
  const canceledCheck = rejected(canceled, 'ABORT_ERR', 'manual');
  debounced.cancel('manual'); await canceledCheck;
  const reusable = debounced(4, 5); debounced.flush(); assert.equal(await reusable, 9);
  const supersede = util.debounce(x => x, 60000, { rejectOnCancel: true });
  const old = supersede(1); const oldCheck = rejected(old, 'ABORT_ERR');
  const current = supersede(2); supersede.flush();
  await oldCheck; assert.equal(await current, 2);
  let leadingCount = 0;
  const leading = util.debounce(x => { leadingCount++; return x; }, 60000, { leading: true });
  assert.equal(await leading(1), 1); assert.equal(leading.pending, null);
  leading.flush(); assert.equal(leadingCount, 1);
  const trailing = leading(2); leading.flush(); assert.equal(await trailing, 2);
  leading.cancel();
  assert.equal(await util.debounce(x => x * 2, 1)(5), 10);
  const controller = new AbortController();
  const abortable = util.debounce(x => x, 60000, { signal: controller.signal });
  const pendingAbort = abortable(1); const abortCheck = rejected(pendingAbort, 'ABORT_ERR', 'stop');
  controller.abort('stop'); await abortCheck;
  await rejected(abortable(2), 'ABORT_ERR', 'stop');
  failCode(() => util.debounce(() => {}, 0, { signal: controller.signal }), 'ABORT_ERR');
  failCode(() => util.debounce(null, 0), 'ERR_INVALID_ARG_TYPE');
  failCode(() => util.debounce(() => {}, -1), 'ERR_OUT_OF_RANGE');
  failCode(() => util.debounce(() => {}, 0, { leading: 1 }), 'ERR_INVALID_ARG_TYPE');
  const thrown = new Error('callback failure');
  const throwing = util.debounce(() => { throw thrown; }, 60000);
  const thrownPromise = throwing(); throwing.flush(); await assert.rejects(thrownPromise, error => error === thrown);

  const releases = [];
  const started = [];
  const throttle = util.throttle(function work(value) {
    assert.equal(this, throttle); started.push(value);
    return new Promise(resolve => releases.push(() => resolve(value)));
  }, 2, 0, { concurrency: 1, maxPending: 1, strict: true });
  assert.equal(throttle.hasImmediateCapacity(), true);
  assert.equal(throttle.unref().ref(), throttle);
  const running = throttle(1), queued = throttle(2);
  assert.equal(throttle.activeCount, 1); assert.equal(throttle.pendingCount, 1);
  assert.equal(throttle.pending, queued); assert.equal(throttle.hasImmediateCapacity(), false);
  await rejected(throttle(3), 'ERR_THROTTLED');
  releases.shift()(); assert.equal(await running, 1);
  await Promise.resolve();
  assert.deepEqual(started, [1, 2]);
  releases.shift()(); assert.equal(await queued, 2);
  await Promise.resolve();
  assert.equal(throttle.activeCount, 0); assert.equal(throttle.pending, null);
  const dropping = util.throttle(x => x, 1, 60000, { overflow: 'drop' });
  assert.equal(await dropping(1), 1); await rejected(dropping(2), 'ERR_THROTTLED');
  dropping.cancel(); assert.equal(await dropping(3), 3); dropping.cancel();
  const limited = util.throttle(x => x, 1, 60000);
  assert.equal(await limited(1), 1);
  const limitedPending = limited(2); const limitedCheck = rejected(limitedPending, 'ABORT_ERR', 'reset');
  limited.cancel('reset'); await limitedCheck;
  assert.equal(limited.pendingCount, 0); assert.equal(limited.hasImmediateCapacity(), true);
  const timed = util.throttle(x => x, 1, 2, { strict: true });
  assert.deepEqual(await Promise.all([timed(1), timed(2), timed(3)]), [1, 2, 3]);
  const abortThrottle = new AbortController();
  const stopped = util.throttle(x => x, 1, 60000, { signal: abortThrottle.signal });
  assert.equal(await stopped(1), 1);
  const stopPending = stopped(2); const stopCheck = rejected(stopPending, 'ABORT_ERR', 'closed');
  abortThrottle.abort('closed'); await stopCheck;
  await rejected(stopped(3), 'ABORT_ERR', 'closed');
  assert.equal(stopped.hasImmediateCapacity(), false);
  failCode(() => util.throttle(() => {}, 0, 1), 'ERR_OUT_OF_RANGE');
  failCode(() => util.throttle(() => {}, 1, 1, { maxPending: -1 }), 'ERR_OUT_OF_RANGE');
  failCode(() => util.throttle(() => {}, 1, 1, { overflow: 'latest' }), 'ERR_INVALID_ARG_VALUE');

  assert.equal(util.markPromiseAsHandled(Promise.resolve(1)), undefined);
  util.markPromiseAsHandled(Promise.reject(new Error('intentionally handled')));
  failCode(() => util.markPromiseAsHandled({ then() {} }), 'ERR_INVALID_ARG_TYPE');
  await new Promise(resolve => setImmediate(resolve));
  console.log('util-public-smoke ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
