// MIT License
// Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

'use strict';

// Node 24 internal/tty policy, without Node's private primordials/validator ABI.
// Terminal entries include dircolors data, Copyright (C) 1996-2016 Free Software
// Foundation, Inc. Copying and distribution, with or without modification, are
// permitted provided the copyright notice and this notice are preserved.
const terminals = {
  eterm: 4, cons25: 4, console: 4, cygwin: 4, dtterm: 4, gnome: 4,
  hurd: 4, jfbterm: 4, konsole: 4, kterm: 4, mlterm: 4, mosh: 24,
  putty: 4, st: 4, 'rxvt-unicode-24bit': 24, terminator: 24, 'xterm-kitty': 24
};
const ci = { APPVEYOR: 8, BUILDKITE: 8, CIRCLECI: 24, DRONE: 8, GITEA_ACTIONS: 24, GITHUB_ACTIONS: 24, GITLAB_CI: 8, TRAVIS: 8 };
const hasOwn = (object, name) => Object.prototype.hasOwnProperty.call(object, name);
let warned = false;
let release;
function warn(env) {
  if (warned) return;
  const names = [];
  if (env.NODE_DISABLE_COLORS !== undefined && env.NODE_DISABLE_COLORS !== '') names.push('NODE_DISABLE_COLORS');
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') names.push('NO_COLOR');
  if (names.length) {
    process.emitWarning(`The '${names.join("' and '")}' env is ignored due to the 'FORCE_COLOR' env being set.`, 'Warning');
    warned = true;
  }
}
function getColorDepth(env = process.env) {
  if (env.FORCE_COLOR !== undefined) {
    switch (env.FORCE_COLOR) {
      case '': case '1': case 'true': warn(env); return 4;
      case '2': warn(env); return 8;
      case '3': warn(env); return 24;
      default: return 1;
    }
  }
  if ((env.NODE_DISABLE_COLORS !== undefined && env.NODE_DISABLE_COLORS !== '') ||
      (env.NO_COLOR !== undefined && env.NO_COLOR !== '') || env.TERM === 'dumb') return 1;
  if (process.platform === 'win32') {
    release ||= require('os').release().split('.', 3);
    if (+release[0] >= 10) {
      if (+release[2] >= 14931) return 24;
      if (+release[2] >= 10586) return 8;
    }
    return 4;
  }
  if (env.TMUX) return 24;
  if (hasOwn(env, 'TF_BUILD') && hasOwn(env, 'AGENT_NAME')) return 4;
  if (hasOwn(env, 'CI')) {
    for (const name of Object.keys(ci)) if (hasOwn(env, name)) return ci[name];
    return env.CI_NAME === 'codeship' ? 8 : 1;
  }
  if ('TEAMCITY_VERSION' in env) return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 4 : 1;
  switch (env.TERM_PROGRAM) {
    case 'iTerm.app': return !env.TERM_PROGRAM_VERSION || /^[0-2]\./.test(env.TERM_PROGRAM_VERSION) ? 8 : 24;
    case 'HyperTerm': case 'MacTerm': return 24;
    case 'Apple_Terminal': return 8;
  }
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 24;
  if (env.TERM) {
    if (/truecolor/.test(env.TERM)) return 24;
    if (/^xterm-256/.test(env.TERM)) return 8;
    const term = env.TERM.toLowerCase();
    if (hasOwn(terminals, term)) return terminals[term];
    if (/ansi|color|linux|direct|^con[0-9]*x[0-9]|^rxvt|^screen|^xterm|^vt100|^vt220/.test(term)) return 4;
  }
  return env.COLORTERM ? 4 : 1;
}
function hasColors(count, env) {
  if (env === undefined && (count === undefined || (typeof count === 'object' && count !== null))) {
    env = count;
    count = 16;
  } else {
    if (typeof count !== 'number') throw Object.assign(new TypeError('The "count" argument must be of type number'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (!Number.isInteger(count) || count < 2 || count > Number.MAX_SAFE_INTEGER)
      throw Object.assign(new RangeError('The value of "count" is out of range. It must be an integer >= 2 and <= 9007199254740991'), { code: 'ERR_OUT_OF_RANGE' });
  }
  return count <= 2 ** getColorDepth(env);
}

module.exports = { getColorDepth, hasColors };
