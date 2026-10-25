import * as os from 'os';
import * as std from 'std';
if (!os.Worker.parent) throw Error('missing Worker.parent');
os.Worker.parent.postMessage('blocked');
if (std.in.getline() !== 'OK') throw Error('detached Worker lost host input');
