/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const ibm866 = require("internal/web/vendor/text-encoding/data/ibm866.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("ibm866", [
    "866",
    "cp866",
    "csibm866",
    "ibm866"
], SingleByteDecoder.forCodePoints(ibm866), SingleByteEncoder.forCodePoints(ibm866));
