// flags: --experimental
// SilkJS regression test: a UTC offset used as a time zone must not carry
// seconds (UTCOffset[~SubMinutePrecision]; test262
// built-ins/Temporal/*/timezone-string-sub-minute-offset.js). SilkJS used to
// accept "-121259" as -12:12 and "-12:12:59.9" as a constructor identifier.
if (typeof print !== 'function') globalThis.print = (...a) => console.log(...a);
let failed = 0;
function rejects(label, fn) {
  try { fn(); } catch (e) { if (e instanceof RangeError) return; failed++; print('FAIL ' + label + ': ' + e); return; }
  failed++; print('FAIL ' + label + ': no error');
}
for (const tz of ['-12:12:59.9', '-12:12:59', '-121259', '+15:59:00', '-170100']) {
  rejects('ctor ' + tz, () => new Temporal.ZonedDateTime(0n, tz));
  rejects('toZonedDateTimeISO ' + tz, () => new Temporal.Instant(0n).toZonedDateTimeISO(tz));
}
rejects('bag -004459', () => Temporal.Duration.compare(new Temporal.Duration(1), new Temporal.Duration(1),
  { relativeTo: { year: 2000, month: 1, day: 1, timeZone: '-004459' } }));
for (const tz of ['+01:00', '-0530', '+05', 'UTC', '2021-08-19T17:30:45-12:12']) {
  const canonical = { '+01:00': '+01:00', '-0530': '-05:30', '+05': '+05:00', 'UTC': 'UTC', '2021-08-19T17:30:45-12:12': '-12:12' }[tz];
  if (!tz.includes('T')) { const id = new Temporal.ZonedDateTime(0n, tz).timeZoneId; if (id !== canonical) { failed++; print('FAIL ctor id ' + tz + ' -> ' + id); } }
  try { const id = new Temporal.Instant(0n).toZonedDateTimeISO(tz).timeZoneId; if (id !== canonical) { failed++; print('FAIL id ' + tz + ' -> ' + id); } } catch (e) { failed++; print('FAIL accept ' + tz + ': ' + e); }
}
print(failed ? failed + ' failed' : 'all passed');
if (failed) throw new Error('temporal sub-minute offset regressions');
