/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { ShiftJISDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/ShiftJISDecoder");
const { ShiftJISEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/ShiftJISEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("shift_jis", [
    "csshiftjis",
    "ms932",
    "ms_kanji",
    "shift-jis",
    "shift_jis",
    "sjis",
    "windows-31j",
    "x-sjis"
], ShiftJISDecoder, ShiftJISEncoder);
