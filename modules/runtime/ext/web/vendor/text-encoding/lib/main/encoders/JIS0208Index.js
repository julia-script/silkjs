/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const jis0208 = require("internal/web/vendor/text-encoding/data/jis0208.cp");
const { CodePointIndex } = require("internal/web/vendor/text-encoding/lib/main/encoders/CodePointIndex");
const SHIFT_JIS_EXCLUDED_POINTERS = [8272, 8835];
let jis0208Index = null;
let shiftJISIndex = null;
/**
 * Returns the JIS0208 pointer for the given code point.
 *
 * @param codePoint - Code point to look up.
 * @returns The pointer or null if the code point is not indexed.
 */
function getJIS0208Pointer(codePoint) {
    jis0208Index ??= new CodePointIndex(jis0208);
    return jis0208Index.get(codePoint);
}
/**
 * Returns the Shift_JIS pointer for the given code point.
 *
 * @param codePoint - Code point to look up.
 * @returns The pointer or null if the code point is not indexed.
 */
function getShiftJISPointer(codePoint) {
    shiftJISIndex ??= new CodePointIndex(jis0208, 0, SHIFT_JIS_EXCLUDED_POINTERS);
    return shiftJISIndex.get(codePoint);
}

Object.assign(exports, { getJIS0208Pointer, getShiftJISPointer });
