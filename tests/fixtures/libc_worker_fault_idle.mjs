import * as os from 'os';
if (!os.Worker.parent) throw Error('missing Worker.parent');
// No event source: the detached child exits naturally, without parent shutdown.
