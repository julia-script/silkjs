/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { XUserDefinedDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/XUserDefinedDecoder");
const { XUserDefinedEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/XUserDefinedEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("x-user-defined", [
    "x-user-defined"
], XUserDefinedDecoder, XUserDefinedEncoder);
