import * as os from 'os';
import value from './data.json';
import extended from './extended.data' with { type: 'json5' };
await Promise.resolve();
os.Worker.parent.postMessage(value.answer + extended.extra);
