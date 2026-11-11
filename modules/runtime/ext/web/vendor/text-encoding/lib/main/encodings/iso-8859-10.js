/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const iso885910 = require("internal/web/vendor/text-encoding/data/iso-8859-10.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("iso-8859-10", [
    "csisolatin6",
    "iso-8859-10",
    "iso-ir-157",
    "iso8859-10",
    "iso885910",
    "l6",
    "latin6"
], SingleByteDecoder.forCodePoints(iso885910), SingleByteEncoder.forCodePoints(iso885910));
