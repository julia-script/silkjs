'use strict';

const host = require('internal/host');
const { validateNumber, validateOneOf, codes: { ERR_OUT_OF_RANGE } } = require('internal/util_public/support');
let errorEntries;
let errors;
function entries() { return errorEntries ??= host.utilErrorMap(); }
function getSystemErrorMap() {
  const result = new Map();
  const values = entries();
  for (let i = 0; i < values.length; i += 3) result.set(values[i], [values[i + 1], values[i + 2]]);
  return result;
}
function validateError(err) {
  validateNumber(err, 'err');
  if (err >= 0 || !Number.isSafeInteger(err)) throw new ERR_OUT_OF_RANGE('err', 'a negative integer', err);
}
function getSystemErrorName(err) {
  validateError(err);
  errors ??= getSystemErrorMap();
  const entry = errors.get(err);
  return entry ? entry[0] : `Unknown system error ${err}`;
}
function getSystemErrorMessage(err) {
  validateError(err);
  return host.utilErrorMessage(err);
}
function convertProcessSignalToExitCode(signalCode) {
  const signals = require('os').constants.signals;
  validateOneOf(signalCode, 'signalCode', Object.keys(signals));
  return 128 + signals[signalCode];
}
module.exports = { getSystemErrorMap, getSystemErrorName, getSystemErrorMessage, convertProcessSignalToExitCode };
