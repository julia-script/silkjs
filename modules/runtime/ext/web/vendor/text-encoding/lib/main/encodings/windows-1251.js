/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const windows1251 = require("internal/web/vendor/text-encoding/data/windows-1251.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("windows-1251", [
    "cp1251",
    "windows-1251",
    "x-cp1251"
], SingleByteDecoder.forCodePoints(windows1251), SingleByteEncoder.forCodePoints(windows1251));
