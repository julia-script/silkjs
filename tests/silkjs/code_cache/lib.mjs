// Imported by the main thread and by each worker of code_cache_modules.js.
import { twice, libName } from "./dep.mjs";
export * from "./dep.mjs";
export let count = 0;
export function bump() { return ++count; }
export const meta = import.meta.url.split("/").pop();
const ready = await Promise.resolve(21);
export const answer = twice(ready);
export class Box {
  #value;
  constructor(value) { this.#value = value; }
  get value() { return this.#value; }
}
export function where() { try { null.f(); } catch (e) { return e.stack.split("\n")[1].trim(); } }
export const cycle = libName();
export default function named() { return "default"; }
