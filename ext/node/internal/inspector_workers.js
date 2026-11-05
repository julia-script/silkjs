'use strict';

const native = require('internal/host').inspectorNative;
const { protocolError, unsupported } = require('internal/inspector_values');
function create(connectRemote) {
  const enabled = new Set();
  let nextId = 1;
  function updateWait() {
    if (native(10) === 0) native(17, Array.from(enabled).some(session => session.workerWait));
  }
  function attach(session, owner) {
    if (owner === native(10) || session.workerSessions.has(owner)) return;
    const sessionId = String(nextId++);
    const record = { sessionId, connection: undefined, announced: false };
    session.workerSessions.set(owner, record);
    try {
      record.connection = connectRemote(owner, message => {
        const parsed = JSON.parse(message);
        if (parsed.inspectorWorkerInfo) {
          record.announced = true;
          session.emit('NodeWorker.attachedToWorker', { sessionId, workerInfo: { workerId: String(owner), type: 'worker', title: parsed.inspectorWorkerInfo.title, url: parsed.inspectorWorkerInfo.url }, waitingForDebugger: parsed.waitingForDebugger });
        } else if (record.announced) session.emit('NodeWorker.receivedMessageFromWorker', { sessionId, message });
      }, false, '{"inspectorWorker":true}');
    } catch (cause) { session.workerSessions.delete(owner); throw cause; }
  }
  function detach(session, owner, notify = true) {
    const record = session.workerSessions.get(owner);
    if (!record) return;
    session.workerSessions.delete(owner);
    if (record.connection) record.connection.disconnect();
    if (notify && record.announced) session.emit('NodeWorker.detachedFromWorker', { sessionId: record.sessionId });
  }
  function attached(owner) { for (const session of enabled) attach(session, owner); }
  function detached(owner) { for (const session of enabled) detach(session, owner); }
  function close(session) {
    enabled.delete(session);
    if (session.workerSessions) for (const owner of session.workerSessions.keys()) detach(session, owner);
    session.workerWait = false;
    updateWait();
  }
  function dispatch(session, method, params) {
    switch (method) {
      case 'NodeWorker.enable':
        if (typeof params.waitForDebuggerOnStart !== 'boolean') throw protocolError(-32602, 'Invalid parameters: waitForDebuggerOnStart');
        if (params.waitForDebuggerOnStart && native(10) !== 0) throw protocolError(-32000, 'Worker auto-wait can only be configured from the main thread');
        session.workerWait = params.waitForDebuggerOnStart;
        if (!session.workerSessions) session.workerSessions = new Map();
        enabled.add(session);
        updateWait();
        for (const owner of native(16)) attach(session, owner);
        return {};
      case 'NodeWorker.disable': close(session); return {};
      case 'NodeWorker.sendMessageToWorker':
      case 'NodeWorker.detach': {
        if (typeof params.sessionId !== 'string' || (method === 'NodeWorker.sendMessageToWorker' && typeof params.message !== 'string')) throw protocolError(-32602, 'Invalid parameters');
        if (session.workerSessions) for (const [owner, record] of session.workerSessions) if (record.sessionId === params.sessionId) {
          if (method === 'NodeWorker.detach') detach(session, owner);
          else record.connection.dispatch(params.message);
          return {};
        }
        throw protocolError(-32000, 'No session with given id');
      }
      default: unsupported(method);
    }
  }
  return { dispatch, close, attached, detached };
}
module.exports = { create };
