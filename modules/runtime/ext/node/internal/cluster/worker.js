'use strict';
const { EventEmitter } = require('events');
function Worker(options = {}) {
  if (!(this instanceof Worker)) return new Worker(options);
  EventEmitter.call(this);
  options ||= {};
  this.exitedAfterDisconnect = undefined;
  this.state = options.state || 'none';
  this.id = options.id | 0;
  if (options.process) {
    this.process = options.process;
    this.process.on('error', error => this.emit('error', error));
    this.process.on('message', (message, handle) => this.emit('message', message, handle));
  }
}
Object.setPrototypeOf(Worker.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Worker, EventEmitter);
Worker.prototype.send = function(...args) { return this.process.send(...args); };
Worker.prototype.isConnected = function() { return this.process.connected; };
Worker.prototype.isDead = function() { return this.process.exitCode != null || this.process.signalCode != null; };
Worker.prototype.kill = function(...args) { this.destroy(...args); };
module.exports = Worker;
