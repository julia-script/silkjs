'use strict';

// A line queue owns only its listeners, and never resumes an already closed
// Interface when draining the buffered tail after input EOF.
module.exports = function createLineIterator(iface) {
  let lines = [];
  let head = 0;
  let waiters = [];
  let finished = iface.closed === true;
  let failure;
  let paused = false;
  const done = () => ({ value: undefined, done: true });

  function detach() {
    iface.removeListener('line', onLine);
    iface.removeListener('close', onClose);
    iface.removeListener('error', onError);
  }
  function onLine(line) {
    if (waiters.length) {
      waiters.shift().resolve({ value: line, done: false });
    } else {
      lines.push(line);
      if (!paused && lines.length - head > 1024) {
        paused = true;
        iface.pause();
      }
    }
  }
  function onClose() {
    finished = true;
    detach();
    for (const waiter of waiters) waiter.resolve(done());
    waiters = [];
  }
  function onError(error) {
    failure = error;
    finished = true;
    detach();
    if (waiters.length) {
      waiters.shift().reject(error);
      failure = undefined;
      for (const waiter of waiters) waiter.resolve(done());
      waiters = [];
    }
  }
  if (!finished) {
    iface.on('line', onLine);
    iface.on('error', onError);
    iface.on('close', onClose);
  }
  return {
    next() {
      if (head < lines.length) {
        const value = lines[head];
        lines[head++] = undefined;
        if (head === lines.length) {
          lines = [];
          head = 0;
          if (paused && !finished && !iface.closed) {
            paused = false;
            iface.resume();
          }
        } else if (head >= 1024 && head * 2 >= lines.length) {
          lines = lines.slice(head);
          head = 0;
        }
        return Promise.resolve({ value, done: false });
      }
      if (failure !== undefined) {
        const error = failure;
        failure = undefined;
        return Promise.reject(error);
      }
      if (finished) return Promise.resolve(done());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    return() {
      lines = [];
      head = 0;
      failure = undefined;
      onClose();
      iface.close();
      return Promise.resolve(done());
    },
    throw(error) {
      lines = [];
      head = 0;
      onError(error);
      failure = undefined;
      iface.close();
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]() { return this; },
  };
};
