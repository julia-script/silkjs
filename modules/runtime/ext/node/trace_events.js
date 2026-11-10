'use strict';

const backend = require('internal/trace_events');
const { isMainThread } = require('worker_threads');
if (!isMainThread || !backend.available()) {
  throw Object.assign(new Error('Trace events are unavailable'), { code: 'ERR_TRACE_EVENTS_UNAVAILABLE' });
}
const enabledObjects = new Set();
const inspect = Symbol.for('nodejs.util.inspect.custom');
function invalid(name, expected) {
  return Object.assign(new TypeError(`The "${name}" argument must be ${expected}`), { code: 'ERR_INVALID_ARG_TYPE' });
}
class Tracing {
  #categories;
  #set;
  #enabled = false;
  constructor(categories) {
    this.#categories = categories;
    this.#set = new Set(categories);
  }
  enable() {
    if (this.#enabled) return;
    backend.add(this.#set);
    this.#enabled = true;
    enabledObjects.add(this);
    if (enabledObjects.size > 10) process.emitWarning('Possible trace_events memory leak detected. There are more than 10 enabled Tracing objects.');
  }
  disable() {
    if (!this.#enabled) return;
    backend.remove(this.#set);
    this.#enabled = false;
    enabledObjects.delete(this);
  }
  get enabled() { return this.#enabled; }
  get categories() { return this.#categories.join(','); }
  [inspect](depth) {
    if (typeof depth === 'number' && depth < 0) return this;
    return `Tracing ${require('util').inspect({ enabled: this.enabled, categories: this.categories })}`;
  }
}
function createTracing(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw invalid('options', 'an object');
  const categories = options.categories;
  if (!Array.isArray(categories)) throw invalid('options.categories', 'an Array');
  for (let index = 0; index < categories.length; index++) {
    if (typeof categories[index] !== 'string') throw invalid(`options.categories[${index}]`, 'of type string');
  }
  if (!categories.length) throw Object.assign(new Error('At least one category is required'), { code: 'ERR_TRACE_EVENTS_CATEGORY_REQUIRED' });
  return new Tracing(categories);
}
module.exports = { createTracing, getEnabledCategories: backend.getEnabledCategories };
