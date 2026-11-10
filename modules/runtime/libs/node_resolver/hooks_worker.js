'use strict';

function packError(error) {
  if (!(error instanceof Error)) return error;
  const properties = {};
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key !== 'name' && key !== 'message' && key !== 'stack') properties[key] = error[key];
  }
  return { loaderError: true, name: error.name, message: error.message, stack: error.stack, properties };
}
function start(bridge, threads) {
  const { port, signal } = threads.workerData;
  threads.isInternalThread = true;
  bridge.enterHookWorker();
  let queue = Promise.resolve();
  async function dispatch({ id, method, args }) {
    let response;
    try {
      let value;
      if (method === 'register') {
        const resolved = await bridge.resolveHookAsync(args.specifier, { parentURL: args.parentURL,
          conditions: bridge.importConditions(), importAttributes: {} });
        const namespace = await import(resolved.url);
        await bridge.addAsyncHooks(namespace, args.data);
      } else if (method === 'resolve') value = await bridge.resolveHookAsync(args.input, args.context);
      else if (method === 'load') value = await bridge.loadHookAsync(args.input, args.context);
      else throw new Error('Unknown loader hook request: ' + method);
      response = { id, value };
    } catch (error) { response = { id, failed: true, error: packError(error) }; }
    // process.exit() cancels the isolate; its interruption is not a hook
    // rejection that user code in the requesting thread can catch.
    if (threads._exitRequested) return;
    try { port.postMessage(response); }
    catch (error) { port.postMessage({ id, failed: true, error: packError(error) }); }
    finally { Atomics.add(signal, 0, 1); Atomics.notify(signal, 0); }
  }
  port.on('message', message => { queue = queue.then(() => dispatch(message)); });
}
module.exports = { start };
