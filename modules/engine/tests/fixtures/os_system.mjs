import * as os from 'os';

function assert(value, message) { if (!value) throw Error(message); }
function equal(actual, expected, message) { assert(JSON.stringify(actual) === JSON.stringify(expected), message + ': ' + JSON.stringify(actual)); }
function throws(kind, call, message) { let caught; try { call(); } catch (error) { caught = error; } assert(caught instanceof kind, message); }
const original = os.getcwd();
assert(original[1] === 0 && original[0].startsWith('/'), 'getcwd');
assert(os.getpid() > 0 && Number.isInteger(os.getpid()), 'getpid');
assert(['darwin', 'linux'].includes(os.platform), 'platform');
for (const name of ['setReadHandler', 'setWriteHandler', 'signal', 'setTimeout', 'clearTimeout', 'sleepAsync', 'Worker']) assert(typeof os[name] === 'function', name + ' export');
for (const name of ['O_RDONLY','O_WRONLY','O_RDWR','O_APPEND','O_CREAT','O_EXCL','O_TRUNC','S_IFMT','S_IFIFO','S_IFCHR','S_IFDIR','S_IFBLK','S_IFREG','S_IFSOCK','S_IFLNK','S_ISGID','S_ISUID','SIGINT','SIGABRT','SIGFPE','SIGILL','SIGSEGV','SIGTERM','SIGQUIT','SIGPIPE','SIGALRM','SIGUSR1','SIGUSR2','SIGCHLD','SIGCONT','SIGSTOP','SIGTSTP','SIGTTIN','SIGTTOU','WNOHANG']) assert(Number.isInteger(os[name]), name);
assert(os.O_RDONLY === 0 && os.O_WRONLY === 1 && os.O_RDWR === 2 && os.WNOHANG === 1, 'POSIX access constants');
assert(os.S_IFMT === 0xf000 && os.S_IFREG === 0x8000 && os.S_IFLNK === 0xa000, 'mode constants');
assert(os.close(-1) < 0 && os.dup(-1) < 0 && os.dup2(-1, -1) < 0, 'negative errno descriptors');
assert(os.remove('missing') < 0 && os.chdir('missing') < 0 && os.rename('missing', 'also-missing') < 0, 'negative errno paths');
for (const [name, empty] of [['stat', null], ['lstat', null], ['readlink', ''], ['realpath', ''], ['readdir', []]]) {
  const result = os[name]('missing'); equal(result[0], empty, name + ' payload'); assert(result[1] > 0, name + ' positive tuple errno');
}
assert(!os.isatty(-1) && os.ttyGetWinSize(-1) === null, 'invalid terminal');
assert(os.mkdir('directory', 0o750) === 0, 'mkdir');
try {
  assert(os.chdir('directory') === 0, 'chdir');
  assert(os.getcwd()[0] === original[0] + '/directory', 'changed cwd');
  assert(os.chdir(original[0]) === 0, 'restore cwd');
  let fd = os.open('file', os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o640);
  assert(fd >= 0, 'open');
  try {
    assert(os.open('file', os.O_WRONLY | os.O_CREAT | os.O_EXCL) < 0, 'exclusive open');
    assert(os.isatty(fd) === false, 'regular file not tty');
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 65]);
    assert(os.write(fd, bytes.buffer, 0, bytes.length) === 6, 'write');
    assert(os.seek(fd, 2, 0) === 2 && os.seek(fd, 1n, 1) === 3n && os.seek(fd, -1, 2) === 5, 'seek numeric and bigint');
    assert(os.seek(fd, 0n, 0) === 0n, 'rewind bigint');
    const target = new Uint8Array(10); assert(os.read(fd, target.buffer, 2, 6) === 6, 'read offset');
    equal(Array.from(target), [0, 0, 0, 1, 127, 128, 255, 65, 0, 0], 'bytes');
    assert(os.read(fd, target.buffer, 0, 1) === 0, 'EOF');
    throws(RangeError, () => os.read(fd, target.buffer, 10, 1), 'bounds');
    throws(RangeError, () => os.write(fd, target.buffer, -1, 0), 'negative index');
    throws(TypeError, () => os.read(fd, target, 0, 1), 'ArrayBuffer brand');
    const duplicate = os.dup(fd); assert(duplicate >= 0 && duplicate !== fd, 'dup');
    try { assert(os.seek(duplicate, 1, 0) === 1 && os.seek(fd, 0, 1) === 1, 'shared open-file description'); assert(os.dup2(fd, duplicate) === duplicate, 'dup2'); }
    finally { assert(os.close(duplicate) === 0, 'close duplicate'); }
    const stat = os.stat('file'); assert(stat[1] === 0 && stat[0].size === 6 && (stat[0].mode & os.S_IFMT) === os.S_IFREG, 'stat size/mode');
    for (const name of ['dev','ino','mode','nlink','uid','gid','rdev','size','blocks','atime','mtime','ctime']) assert(typeof stat[0][name] === 'number', 'stat ' + name);
    assert(os.utimes('file', 1600000000123, 1600000000456) === 0, 'utimes');
    const times = os.stat('file')[0]; equal([times.atime, times.mtime], [1600000000123,1600000000456], 'millisecond times');
  } finally { assert(os.close(fd) === 0, 'close'); }
  assert(os.symlink('file', 'link') === 0, 'symlink');
  try {
    equal(os.readlink('link'), ['file', 0], 'readlink');
    assert((os.lstat('link')[0].mode & os.S_IFMT) === os.S_IFLNK && (os.stat('link')[0].mode & os.S_IFMT) === os.S_IFREG, 'stat follows lstat does not');
    equal(os.realpath('link'), [original[0] + '/file', 0], 'realpath');
    const entries = os.readdir('.'); assert(entries[1] === 0, 'readdir status'); for (const name of ['.', '..', 'file', 'link', 'directory']) assert(entries[0].includes(name), 'readdir ' + name);
  } finally { assert(os.remove('link') === 0, 'unlink'); }
  assert(os.rename('file', 'renamed') === 0, 'rename');
  assert(os.stat('file')[1] > 0 && os.stat('renamed')[0].size === 6, 'rename observable');
  assert(os.remove('renamed') === 0, 'remove file');
  const identity = os.stat('.')[0];
  assert(os.exec(['/bin/sh', '-c', 'exit 23']) === 23, 'blocking exec');
  assert(os.exec(['/bin/sh', '-c', 'kill -HUP $$']) === -1, 'signal termination including minus one');
  assert(os.exec(['sh', '-c', 'exit 24']) === 24, 'PATH search');
  assert(os.exec(['ignored', '-c', 'exit 25'], {file: '/bin/sh', usePath: false}) === 25, 'file override');
  assert(os.exec(['no-such-command'], {usePath:false}) === 127, 'exec child failure');
  assert(os.exec(['/bin/sh', '-c', 'test "$OS_PORT_VAR" = present && test -z "$HOME"'], {env: {OS_PORT_VAR: 'present'}, uid:identity.uid, gid:identity.gid}) === 0, 'replacement env uid gid');
  assert(os.exec(['/bin/sh', '-c', 'test "$(pwd)" = "$EXPECTED"'], {cwd:'directory', env:{EXPECTED: original[0] + '/directory'}}) === 0, 'cwd option');
  const pid = os.exec(['/bin/sh', '-c', 'exit 17'], {block:false}); assert(pid > 0, 'nonblocking pid');
  equal(os.waitpid(pid, 0), [pid, 17 << 8], 'waitpid raw status'); assert(os.waitpid(pid, 0)[0] < 0, 'wait twice');
  const sleeper = os.exec(['/bin/sleep','30'], {block:false});
  assert(os.kill(sleeper, 0) === 0 && os.kill(sleeper, os.SIGTERM) === 0, 'kill');
  const killed = os.waitpid(sleeper, 0); assert(killed[0] === sleeper && (killed[1] & 127) === os.SIGTERM, 'signal wait status');
  const descriptors = os.pipe(); assert(descriptors !== null && descriptors.length === 2, 'pipe');
  try {
    const source = new Uint8Array([65,66,10]); assert(os.write(descriptors[1], source.buffer, 0, 3) === 3, 'pipe write');
    const capture = os.open('capture',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); assert(capture >= 0, 'capture');
    try { assert(os.exec(['/bin/sh','-c','read x; printf "%s!" "$x"; printf "err" >&2'],{stdin:descriptors[0],stdout:capture,stderr:capture}) === 0, 'all descriptor options'); }
    finally { os.close(capture); }
    const input = os.open('capture',os.O_RDONLY); try { const result = new Uint8Array(16); assert(os.read(input,result.buffer,0,16) === 6, 'redirect size'); equal(Array.from(result.slice(0,6)),[65,66,33,101,114,114],'redirect bytes'); } finally { os.close(input); os.remove('capture'); }
  } finally { os.close(descriptors[0]); os.close(descriptors[1]); }
  const calls = [];
  throws(Error, () => os.open({toString(){calls.push('path');return 'unused';}}, {valueOf(){calls.push('flags');throw Error('stop');}}), 'open coercion');
  equal(calls,['path','flags'],'open coercion order'); calls.length = 0;
  throws(Error, () => os.mkdir({toString(){calls.push('path');return 'unused';}}, {valueOf(){calls.push('mode');throw Error('stop');}}), 'mkdir coercion');
  equal(calls,['mode'],'mkdir mode precedes path');
  const options = new Proxy({}, {get(target,key){ calls.push(key); return undefined; }}); calls.length = 0;
  assert(os.exec(['/bin/sh','-c','exit 0'],options) === 0,'option getter exec');
  equal(calls,['block','usePath','file','cwd','stdin','stdout','stderr','env','uid','gid'],'exec getter order');
  throws(TypeError,()=>os.exec([]),'empty argv'); throws(TypeError,()=>os.exec({length:65536}),'huge argv');
  const before = os.now(); assert(os.sleep(5) === 0 && os.sleep(-1) === 0, 'sleep'); assert(os.now() >= before + 3, 'monotonic now');
} finally {
  os.chdir(original[0]); for (const name of ['link','file','renamed','capture']) os.remove(name); os.remove('directory');
}
print('os synchronous behavior OK');
