// A dependency of lib.mjs that imports it back (a cycle).
import * as lib from "./lib.mjs";
export const twice = (v) => v * 2;
export function libName() { return typeof lib.bump; }
