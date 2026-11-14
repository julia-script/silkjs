import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const runtime = resolve(process.env.SILKJS_RUNTIME || 'build/silkjsruntime');
const reference = process.env.NODE_REFERENCE || process.execPath;
const filter = new RegExp(process.argv[2] || '');
const directory = mkdtempSync(join(tmpdir(), 'silkjsruntime-compat-'));
function file(name, content) {
  const path = join(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const cases = [];
const add = (name, source, module = false) => cases.push({ name, args: [...(module ? ['--input-type=module'] : []), '-e', source] });
add('buffer-views-boundaries', `const b=Buffer.from('hé💠');const s=b.subarray(1,3);s[0]=42;const n=Buffer.alloc(16);n.writeBigInt64BE(-9223372036854775808n);n.writeDoubleLE(-0,8);console.log(JSON.stringify([[...b],n.toString('hex'),Object.is(n.readDoubleLE(8),-0),Buffer.from('ab-_','base64url').toString('hex')]));`);
add('decoder-partial-input', `const {StringDecoder}=require('string_decoder');const d=new StringDecoder('utf8');console.log(JSON.stringify([d.write(Buffer.from([240,159])),d.write(Buffer.from([146,160])),d.end(Buffer.from([226,130]))]));`);
add('emitter-reentrancy', `const E=require('events');const e=new E(),out=[];function b(){out.push('b')}e.on('x',()=>{out.push('a');e.removeListener('x',b)});e.once('x',()=>out.push('once'));e.on('x',b);e.emit('x');e.emit('x');console.log(JSON.stringify([out,e.listenerCount('x')]));`);
add('ticks-promises-timers', `const out=[];process.nextTick(()=>{out.push('tick');process.nextTick(()=>out.push('nested'))});Promise.resolve().then(()=>{out.push('promise');process.nextTick(()=>out.push('promise-tick'))});queueMicrotask(()=>out.push('microtask'));setTimeout(()=>console.log(JSON.stringify(out)),8);`);
add('timer-unref-exit', `setTimeout(()=>console.log('incorrect-live-timer'),1000).unref();console.log('exit');`);
add('path-posix-win32', String.raw`const p=require('path');console.log(JSON.stringify([p.posix.relative('/a/b','/a/c/d'),p.win32.resolve('C:\\a','..\\b'),p.win32.parse('\\\\server\\share\\dir\\f.txt'),p.posix.normalize('//a/./b/../')]));`);
add('url-encoding-stream', `const u=new URL('../x?name=é','https://example.org/a/b');const d=new TextDecoder('utf-8');console.log(JSON.stringify([u.href,[...u.searchParams],d.decode(new Uint8Array([240,159]),{stream:true}),d.decode(new Uint8Array([146,160])),new TextEncoder().encode('é').length]));`);
add('url-idna-unicode-boundaries', `const{domainToASCII,domainToUnicode}=require('node:url');const hosts=[String.fromCodePoint(0x11db0),String.fromCodePoint(0x1e6c0),String.fromCodePoint(0x11daf),'ＦＯＯ','a\\u200Db','\\u0301a'];console.log(JSON.stringify(hosts.map(host=>{let parsed;try{parsed=new URL('https://'+host+'.example/').hostname}catch(error){parsed=error.code}const ascii=domainToASCII(host);return[parsed,ascii,domainToUnicode(ascii)]})));`);
add('abort-resistant-listeners', `const {addAbortListener}=require('events');const c=new AbortController();const out=[];c.signal.addEventListener('abort',e=>{out.push('ordinary');e.stopImmediatePropagation()});addAbortListener(c.signal,()=>out.push('resistant'));c.abort('reason');console.log(JSON.stringify([out,c.signal.reason,c.signal.aborted]));`);
add('esm-builtins-tla', `import p,{join} from 'node:path';import {Buffer} from 'node:buffer';await Promise.resolve();console.log(JSON.stringify([join('a','b'),p.sep,Buffer.from('é').toString('hex')]));`, true);
add('eval-builtin-global-lifecycle', `const before=Object.getOwnPropertyDescriptor(globalThis,'fs');const loaded=fs===require('node:fs');const after=Object.getOwnPropertyDescriptor(globalThis,'fs');globalThis.fs={marker:42};const assigned=Object.getOwnPropertyDescriptor(globalThis,'fs');Object.defineProperty(globalThis,'path',{configurable:false});console.log(JSON.stringify([typeof before.get,loaded,typeof after.get,before.enumerable,after.enumerable,fs.marker,assigned.enumerable,assigned.writable,path===require('node:path'),crypto===require('node:crypto'),globalThis.crypto===require('node:crypto').webcrypto]));`);
add('esm-eval-builtin-globals', `import expected from 'node:fs';import {webcrypto} from 'node:crypto';console.log(JSON.stringify([fs===expected,crypto===webcrypto,typeof require,typeof Object.getOwnPropertyDescriptor(globalThis,'fs').get]));`, true);
add('node-options-precedence-and-rejection', `const {spawnSync}=require('node:child_process');const source='console.log(JSON.stringify([typeof gc,typeof require,process.execArgv.slice(0,-2)]))';const cases=[['"" "--expose-gc" ""',[]],['--expose-gc',['--no-expose-gc']],['--input-type=module',['--input-type','commonjs']],['--unknown-runtime-option',[]],['--input-type="module',[]],['--eval="console.log(42)"',[]]];console.log(JSON.stringify(cases.map(([options,args])=>{const child=spawnSync(process.execPath,[...args,'-e',source],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:options}});if(child.error)throw child.error;return [child.status,child.stdout]})));`);
add('cli-inline-evaluation-options', `const {spawnSync}=require('node:child_process');console.log(JSON.stringify([['--print=6*7'],['--eval=console.log(42)'],['--input-type','module','--eval=console.log(await Promise.resolve(42))']].map(args=>{const child=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}});if(child.error)throw child.error;return [child.status,child.stdout]})));`);
add('rejection-handled-in-tick', `const p=Promise.reject(new Error('handled'));process.nextTick(()=>p.catch(()=>{}));setTimeout(()=>console.log('survived'),5);`);
add('rejection-events', `const out=[];const p=Promise.reject('late');process.on('unhandledRejection',(reason,promise)=>{out.push(reason);setImmediate(()=>promise.catch(()=>{}))});process.on('rejectionHandled',()=>{out.push('handled');console.log(JSON.stringify(out))});`);
add('unhandled-rejection-exit', `console.log('rejecting');Promise.reject(new Error('must fail'));`);
add('stream-backpressure', `const {Readable,Writable,pipeline}=require('stream');const out=[];pipeline(Readable.from(['a','b','c']),new Writable({highWaterMark:1,write(chunk,encoding,callback){out.push(chunk.toString());setTimeout(callback,1)}}),error=>{if(error)throw error;console.log(JSON.stringify(out))});`);
add('debuglog-lazy-initialization', `const {debuglog}=require('util');let count=0;let debug=debuglog('silk_debug_disabled',fn=>{count++;debug=fn});const initial=debug;initial('first');initial('second');console.log(JSON.stringify([count,debug!==initial,debug.enabled]));`);
add('async-context-await', `const {AsyncLocalStorage}=require('async_hooks');const s=new AsyncLocalStorage();const out=[];Promise.all(['a','b'].map(value=>s.run(value,async()=>{await Promise.resolve();out.push(s.getStore());await new Promise(resolve=>setTimeout(resolve,2));out.push(s.getStore())}))).then(()=>console.log(JSON.stringify([out,s.getStore()])));`);
add('async-context-registration', `const {AsyncLocalStorage,AsyncResource}=require('async_hooks');const s=new AsyncLocalStorage();let resolve;const p=new Promise(r=>resolve=r),out=[];s.run('registered',()=>p.then(()=>out.push(s.getStore())));s.run('resolver',()=>resolve());s.run('resource',()=>{const r=new AsyncResource('test');s.run('caller',()=>r.runInAsyncScope(()=>out.push(s.getStore())));r.emitDestroy()});setImmediate(()=>console.log(JSON.stringify([out,s.getStore()])));`);
add('async-hooks-resource-lifecycle', `const {AsyncResource,createHook,executionAsyncId}=require('async_hooks');const out=[];let tracked;const h=createHook({init(id,type){if(type==='owned'){tracked=id;out.push('init')}},before(id){if(id===tracked)out.push('before')},after(id){if(id===tracked)out.push('after')},destroy(id){if(id===tracked)out.push('destroy')}}).enable();const r=new AsyncResource('owned',{requireManualDestroy:true});try{r.runInAsyncScope(()=>{out.push(executionAsyncId()===r.asyncId());throw new Error('expected')})}catch{}r.emitDestroy();setImmediate(()=>{h.disable();console.log(JSON.stringify(out))});`);
add('timers-promises-abort-interval', `const t=require('timers/promises');(async()=>{const c=new AbortController();const p=t.setTimeout(1000,'bad',{signal:c.signal});c.abort('stop');const out=[];try{await p}catch(e){out.push(e.name,e.code,e.cause)}out.push(await t.setImmediate(9));for await(const value of t.setInterval(1,'tick')){out.push(value);if(out.filter(v=>v==='tick').length===2)break}console.log(JSON.stringify(out))})();`);
add('fs-sync-positional-views', `const fs=require('fs'),p='sync-boundary.bin';let fd;try{fs.writeFileSync(p,'abcdef');fd=fs.openSync(p,'r+');const storage=Buffer.alloc(10,46),view=storage.subarray(2,7);const n=fs.readSync(fd,view,1,3,2);fs.writeSync(fd,Buffer.from('XY'),0,2,1);const stats=fs.fstatSync(fd,{bigint:true});console.log(JSON.stringify([n,storage.toString(),fs.readFileSync(p,'utf8'),typeof stats.mtimeNs,stats.size===6n,stats.isFile()]));fs.closeSync(fd);fd=undefined;try{fs.statSync('missing-boundary')}catch(e){console.log(JSON.stringify([e.code,e.syscall,e.path]))}}finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(p,{force:true})}`);
add('fs-promises-filehandle-close', `const fs=require('fs/promises');(async()=>{const dir='async-boundary';await fs.mkdir(dir,{recursive:true});try{await fs.writeFile(dir+'/a','abc');await fs.appendFile(dir+'/a','def');await fs.copyFile(dir+'/a',dir+'/b');const f=await fs.open(dir+'/b','r+');const b=Buffer.alloc(4,46);const result=await f.read({buffer:b,offset:1,length:2,position:2});await f.write(Buffer.from('!'),0,1,5);await f.close();let code;try{await f.read(Buffer.alloc(1),0,1,0)}catch(e){code=e.code}console.log(JSON.stringify([result.bytesRead,b.toString(),await fs.readFile(dir+'/b','utf8'),(await fs.readdir(dir)).sort(),code]));}finally{await fs.rm(dir,{recursive:true,force:true})}})();`);
add('fs-async-context-order', `const fs=require('fs'),{AsyncLocalStorage}=require('async_hooks');const s=new AsyncLocalStorage(),out=[];fs.writeFileSync('context.txt','value');s.run('submitted',()=>fs.readFile('context.txt','utf8',(e,v)=>{if(e)throw e;out.push(s.getStore(),v);fs.unlinkSync('context.txt');console.log(JSON.stringify(out))}));out.push('returned');process.nextTick(()=>out.push('tick'));`);
add('native-completion-checkpoints', `const fs=require('fs'),crypto=require('crypto');let pending=128,dirtyTick=false,dirtyJob=false,violations=0;function done(error){if(error)throw error;if(dirtyTick||dirtyJob)violations++;dirtyTick=dirtyJob=true;process.nextTick(()=>dirtyTick=false);queueMicrotask(()=>dirtyJob=false);if(--pending===0)process.nextTick(()=>console.log(JSON.stringify([pending,violations])))}for(let i=0;i<64;i++){fs.stat('.',done);crypto.randomBytes(8,done)}`);
add('crypto-callback-uncaught-monitor', `const c=require('crypto'),out=[];process.on('uncaughtExceptionMonitor',e=>out.push('monitor:'+e.message));process.on('uncaughtException',e=>out.push('caught:'+e.message));c.randomBytes(8,()=>{queueMicrotask(()=>console.log(JSON.stringify(out)));throw new Error('crypto-callback')});`);
add('net-half-close-streams', `const net=require('net');let received='';const server=net.createServer({allowHalfOpen:true},socket=>{socket.setEncoding('utf8');socket.on('data',value=>received+=value);socket.on('end',()=>socket.end('reply:'+received))});server.listen(0,'127.0.0.1',()=>{const client=net.connect(server.address().port,'127.0.0.1');let reply='';client.setEncoding('utf8');client.on('connect',()=>client.end('héllo'));client.on('data',value=>reply+=value);client.on('close',()=>server.close(()=>console.log(JSON.stringify([received,reply,client.readableEnded,client.writableFinished]))));client.on('error',error=>{throw error})});server.on('error',error=>{throw error});`);
add('udp-send-view-boundary', `const dgram=require('dgram');const server=dgram.createSocket('udp4'),client=dgram.createSocket('udp4');server.on('message',(message,remote)=>{console.log(JSON.stringify([message.toString(),remote.family,remote.size]));client.close();server.close()});server.bind(0,'127.0.0.1',()=>{const bytes=Buffer.from('!payload?');client.send(bytes.subarray(1,8),server.address().port,'127.0.0.1',error=>{if(error)throw error})});server.on('error',error=>{throw error});client.on('error',error=>{throw error});`);
add('os-process-native-values', `const os=require('os');const user=os.userInfo(),usage=process.memoryUsage(),cpu=process.cpuUsage();console.log(JSON.stringify([os.platform(),os.arch(),os.endianness(),os.type(),os.machine(),os.hostname(),os.homedir(),user.uid===process.getuid(),user.gid===process.getgid(),os.availableParallelism()>0,os.cpus().every(cpu=>typeof cpu.model==='string'&&cpu.times.user>=0),Object.keys(usage).sort(),usage.heapUsed>0&&usage.heapTotal>=usage.heapUsed&&usage.rss>0,cpu.user>=0&&cpu.system>=0,process.getgroups().includes(process.getegid()),typeof process.resourceUsage().maxRSS]));const mask=process.umask();try{process.umask('027');console.log(process.umask()===0o27)}finally{process.umask(mask)}`);
add('http-pipeline-response-order', `const http=require('http'),net=require('net'),seen=[];const server=http.createServer((req,res)=>{seen.push(req.url);if(req.url==='/first')setTimeout(()=>res.end('FIRST_BODY'),10);else res.end('SECOND_BODY')});server.listen(0,'127.0.0.1',()=>{const socket=net.connect(server.address().port,'127.0.0.1');let text='';socket.setEncoding('utf8');socket.on('connect',()=>socket.write('GET /first HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\nGET /second HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n'));socket.on('data',chunk=>text+=chunk);socket.on('end',()=>server.close(()=>console.log(JSON.stringify([seen,(text.match(/HTTP\\/1\\.1 200/g)||[]).length,text.indexOf('FIRST_BODY')>=0&&text.indexOf('SECOND_BODY')>text.indexOf('FIRST_BODY')]))))});`);
add('http-reject-ambiguous-framing', `const http=require('http'),net=require('net');let handled=0;const server=http.createServer((req,res)=>{handled++;res.end('bad')});server.listen(0,'127.0.0.1',()=>{const socket=net.connect(server.address().port,'127.0.0.1');let text='';socket.setEncoding('utf8');socket.on('connect',()=>socket.write('POST / HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Length: 1\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n0\\r\\n\\r\\n'));socket.on('data',chunk=>text+=chunk);socket.on('end',()=>server.close(()=>console.log(JSON.stringify([text.split(' ')[1],handled]))))});`);
add('http-parser-detach-context', String.raw`const {HTTPParser:P}=require('_http_common');const {AsyncLocalStorage,executionAsyncResource,executionAsyncId}=require('async_hooks');const s=new AsyncLocalStorage(),resource={},p=new P(),out=[];s.run('captured',()=>p.initialize(P.REQUEST,resource));const bytes=Buffer.from('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 7\r\n\r\npayload');const storage=new ArrayBuffer(bytes.length),input=Buffer.from(storage);input.set(bytes);p[P.kOnHeadersComplete]=()=>{out.push([s.getStore(),executionAsyncResource()===resource,executionAsyncId()===p.getAsyncId()]);structuredClone(storage,{transfer:[storage]});return 0};p[P.kOnBody]=chunk=>out.push(chunk.toString());p[P.kOnMessageComplete]=()=>out.push('complete');const consumed=s.run('caller',()=>p.execute(input));out.push([consumed===bytes.length,storage.byteLength,p.getAsyncContextFrameForDebuggingOnly().get(s)]);p.free();out.push(p.getAsyncId());s.run('reset',()=>p.asyncReset(resource,500));out.push([p.getAsyncId(),p.getAsyncContextFrameForDebuggingOnly().get(s)]);p.close();console.log(JSON.stringify(out));`);
add('http-agent-keepalive-default', `const h=require('http');let connections=0;const server=h.createServer((req,res)=>{let body='';req.setEncoding('utf8');req.on('data',x=>body+=x);req.on('end',()=>{res.setHeader('x-path',req.url);res.end('echo:'+body)})});server.on('connection',()=>connections++);server.listen(0,'127.0.0.1',async()=>{const agent=new h.Agent({keepAlive:true,maxSockets:1});const request=data=>new Promise((resolve,reject)=>{const req=h.request({host:'127.0.0.1',port:server.address().port,path:'/echo',method:'POST',agent},res=>{let body='';res.setEncoding('utf8');res.on('data',x=>body+=x);res.on('end',()=>resolve([res.statusCode,res.headers['x-path'],body,req.reusedSocket]))});req.on('error',reject);req.write(data.slice(0,2));req.end(data.slice(2))});try{const out=[await request('first'),await request('second')];console.log(JSON.stringify([out,connections]))}finally{agent.destroy();server.close()}});`);
add('unix-socket-empty-input-close', `const net=require('net'),path=require('path').join(process.cwd(),'smoke-'+process.pid+'.sock');const server=net.createServer(s=>s.end('unix'));server.listen(path,()=>{const c=net.connect(path);let data='';c.setEncoding('utf8');c.on('data',x=>data+=x);c.on('close',()=>server.close(()=>console.log(data)));c.on('error',e=>{throw e})});`);
file('h2-client.cjs', `const h2=require('http2');const session=h2.connect(process.argv[2]);session.on('error',e=>{throw e});const input=Buffer.from('0123456789'.repeat(12000)),request=session.request({':method':'POST',':path':'/echo'});let headers,trailers;const chunks=[];request.on('response',h=>headers=h);request.on('trailers',h=>trailers=h);request.on('data',c=>chunks.push(c));request.on('end',()=>{console.log(JSON.stringify([headers[':status'],Buffer.concat(chunks).equals(input),trailers['x-end']]));session.close()});request.end(input);`);
add('http2-large-body-trailers-node-peer', `const h2=require('http2'),{spawn}=require('child_process'),server=h2.createServer();server.on('stream',stream=>{const chunks=[];stream.on('data',c=>chunks.push(c));stream.on('end',()=>{stream.respond({':status':201},{waitForTrailers:true});stream.on('wantTrailers',()=>stream.sendTrailers({'x-end':'done'}));stream.end(Buffer.concat(chunks))})});server.listen(0,'127.0.0.1',()=>{const child=spawn(process.env.NODE_REFERENCE,['./h2-client.cjs','http://127.0.0.1:'+server.address().port],{stdio:['ignore','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.on('close',code=>{process.exitCode=code;server.close()})});`);
add('fetch-abort-body-reason', `const server=require('http').createServer((req,res)=>{res.writeHead(200);res.write('prefix')});server.listen(0,'127.0.0.1',async()=>{const controller=new AbortController(),response=await fetch('http://127.0.0.1:'+server.address().port,{signal:controller.signal}),reason=Object.assign(new Error('cancel'),{code:'TEST_CANCEL'});controller.abort(reason);try{await response.arrayBuffer();console.log('incorrectly-consumed')}catch(error){console.log(JSON.stringify([error===reason,error.name,error.code]))}finally{server.closeAllConnections();server.close()}});`);
add('crypto-state-and-authentication', `const c=require('crypto');const h=c.createHash('sha256').update('ab'),copy=h.copy();const out=[h.update('c').digest('hex'),copy.update('d').digest('hex'),c.createHmac('sha256','key').update('data').digest('hex')];const key=Buffer.alloc(32,7),iv=Buffer.alloc(12,3),a=c.createCipheriv('aes-256-gcm',key,iv);a.setAAD(Buffer.from('meta'));const encrypted=Buffer.concat([a.update('plaintext'),a.final()]),tag=a.getAuthTag();function dec(t){const d=c.createDecipheriv('aes-256-gcm',key,iv);d.setAAD(Buffer.from('meta'));d.setAuthTag(t);return Buffer.concat([d.update(encrypted),d.final()]).toString()}out.push(dec(tag));tag[0]^=1;try{dec(tag);out.push(false)}catch{out.push(true)}console.log(JSON.stringify(out));`);
add('crypto-async-kdf', `const c=require('crypto'),{AsyncLocalStorage}=require('async_hooks');const s=new AsyncLocalStorage();s.run('kdf',()=>c.pbkdf2('password','salt',2,32,'sha256',(e,key)=>{if(e)throw e;console.log(JSON.stringify([key.toString('hex'),s.getStore()]));}));console.log('scheduled');`);
add('crypto-key-brands', `const c=require('crypto'),t=require('util/types');(async()=>{const key=await c.webcrypto.subtle.importKey('raw',new Uint8Array([1,2,3]),{name:'HMAC',hash:'SHA-256'},true,['sign']);const object=c.KeyObject.from(key);console.log(JSON.stringify([t.isCryptoKey(key),t.isCryptoKey(new Proxy(key,{})),t.isKeyObject(object),t.isKeyObject(new Proxy(object,{})),t.isKeyObject(Object.create(c.KeyObject.prototype))]));})();`);
add('crypto-key-signature-roundtrip', `const c=require('crypto');const {privateKey,publicKey}=c.generateKeyPairSync('ed25519');const data=Buffer.from('message'),signature=c.sign(null,data,privateKey);const exported=publicKey.export({format:'der',type:'spki'}),loaded=c.createPublicKey({key:exported,format:'der',type:'spki'});console.log(JSON.stringify([privateKey.type,loaded.asymmetricKeyType,c.verify(null,data,loaded,signature),c.verify(null,Buffer.from('changed'),loaded,signature)]));`);
add('readline-crlf-boundaries', `const {PassThrough}=require('stream'),{createInterface}=require('readline');const input=new PassThrough(),out=[];const lines=createInterface({input,crlfDelay:Infinity});lines.on('line',value=>out.push(value));lines.on('close',()=>console.log(JSON.stringify(out)));input.write('first\\r');input.write('\\nsecond\\n');input.end('last');`);
add('readline-iterator-close', `const {Readable}=require('stream'),{createInterface}=require('readline');(async()=>{const lines=createInterface({input:Readable.from(['a\\nb\\nc\\n']),crlfDelay:Infinity}),out=[];for await(const line of lines){out.push(line);if(out.length===2)break}console.log(JSON.stringify([out,lines.closed]));})();`);
add('readline-promises-cursor-transaction', `const {PassThrough}=require('stream'),{Readline}=require('readline/promises');const output=new PassThrough(),chunks=[];output.on('data',chunk=>chunks.push(chunk));const r=new Readline(output);r.cursorTo(3,2).clearLine(1).rollback();r.cursorTo(1,0).moveCursor(-1,2).clearScreenDown();r.commit().then(()=>console.log(JSON.stringify(Buffer.concat(chunks).toString())));`);
add('microtask-uncaught-monitor', `const out=[];process.on('uncaughtExceptionMonitor',(e,origin)=>out.push('monitor:'+e.message+':'+origin));process.on('uncaughtException',e=>out.push('caught:'+e.message));queueMicrotask(()=>{throw new Error('micro')});queueMicrotask(()=>out.push('next'));setImmediate(()=>console.log(JSON.stringify(out)));`);
add('vm-realms-live-extensions', `const vm=require('vm');const box={n:2};vm.createContext(box);const script=new vm.Script('let local=3;globalThis.answer=n+local;[Array===globalThis.Array,answer]');const result=script.runInContext(box),extension={x:5};const fn=vm.compileFunction('return x+arg',['arg'],{contextExtensions:[extension]});const first=fn(7);extension.x=9;console.log(JSON.stringify([result,box.answer,box.local,first,fn(7),vm.isContext(box),vm.isContext({})]));`);
add('vm-timeout-code-generation', `const vm=require('vm'),out=[];try{vm.runInNewContext('while(true){}',{}, {timeout:10})}catch(e){out.push(e.code)}const box=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});for(const source of ['eval("1")','new Function("return 1")'])try{vm.runInContext(source,box);out.push('incorrectly-allowed')}catch(e){out.push(e.name)}console.log(JSON.stringify(out));`);
add('vm-global-mirror-deletion', `const vm=require('vm'),box={};box.host=()=>{box.x=9};vm.createContext(box);const result=vm.runInContext('var x=1;var empty;function get(){return x}host();[x,get(),this.x,Object.hasOwn(this,"empty"),delete x]',box);console.log(JSON.stringify([result,box.x,typeof box.get,Object.getOwnPropertyDescriptor(box,'x'),vm.runInContext('x',box)]));`);
add('vm-private-microtask-queue', `const vm=require('vm'),out=[];const box=vm.createContext({out},{microtaskMode:'afterEvaluate'});vm.runInContext('Promise.resolve().then(()=>out.push(1))',box);console.log(JSON.stringify(out));`);
file('runner.test.cjs', `const {test}=require('node:test');test('sync',t=>t.diagnostic('sync-event'));test('async',async t=>{await Promise.resolve();t.diagnostic('async-event')});`);
add('test-runner-local-completion', `const stream=require('node:test').run({files:['./runner.test.cjs'],isolation:'none'}),events=[];let summary;stream.on('test:diagnostic',d=>{if(d.message.endsWith('-event'))events.push(d.message)});stream.on('test:summary',d=>summary=d);stream.on('end',()=>console.log(JSON.stringify([events,summary.success,summary.counts.tests,summary.counts.passed])));stream.resume();`);
file('node_modules/test/index.js', 'module.exports = "user-package";');
file('node_modules/sqlite/index.js', 'module.exports = "user-sqlite";');
add('module-prefix-only-builtins', `process.removeAllListeners('warning');const m=require('module');console.log(JSON.stringify([m.isBuiltin('test'),m.isBuiltin('node:test'),m.isBuiltin('node:not-a-builtin'),m.isBuiltin('node:test/reporters'),require('test'),typeof require('node:test').test,m.builtinModules.includes('node:test'),m.builtinModules.includes('test'),m.isBuiltin('sqlite'),m.isBuiltin('node:sqlite'),require('sqlite'),typeof require('node:sqlite').DatabaseSync]));`);
file('worker-transfer.cjs', `const{parentPort,workerData}=require('worker_threads');parentPort.once('message',value=>{Atomics.store(new Int32Array(workerData),0,73);value.self=value;parentPort.postMessage(value,[value.buffer]);parentPort.close()});`);
add('worker-transfer-shared-backing', `const{Worker}=require('worker_threads'),shared=new SharedArrayBuffer(4),worker=new Worker('./worker-transfer.cjs',{workerData:shared}),buffer=new Uint8Array([1,2,255]).buffer;let received;worker.on('message',value=>received=[value.self===value,Buffer.from(value.buffer).toString('hex'),Atomics.load(new Int32Array(shared),0)]);worker.on('error',e=>{throw e});worker.on('exit',code=>console.log(JSON.stringify([buffer.byteLength,received,code])));worker.postMessage({buffer},[buffer]);`);
file('worker-fd.cjs', `const{parentPort,workerData}=require('worker_threads'),fs=require('fs');const done=fd=>{parentPort.postMessage(fd);parentPort.close()};if(workerData==='sync')done(fs.openSync(process.execPath,'r'));else fs.open(process.execPath,'r',(error,fd)=>{if(error)throw error;done(fd)});`);
add('worker-descriptor-exit-ownership', `const{Worker}=require('worker_threads'),fs=require('fs');async function check(mode,track){return new Promise((resolve,reject)=>{const w=new Worker('./worker-fd.cjs',{workerData:mode,trackUnmanagedFds:track});let fd;w.on('message',value=>fd=value);w.on('error',reject);w.on('exit',code=>{let result;try{fs.fstatSync(fd);result='open';fs.closeSync(fd)}catch(e){result=e.code}resolve([code,result])})})}(async()=>{const out=[];for(const track of[true,false])for(const mode of['sync','async'])out.push(await check(mode,track));console.log(JSON.stringify(out))})();`);
add('message-port-event-loop-fairness', `const{MessageChannel}=require('worker_threads'),{port1,port2}=new MessageChannel();let count=0;port2.on('message',()=>{if(++count<10000)port1.postMessage(count);else{port1.close();port2.close()}});port1.postMessage(0);setImmediate(()=>{console.log(count<10000);port1.close();port2.close()});`);
add('message-port-ref-before-start', `const{MessageChannel}=require('node:worker_threads'),{port1,port2}=new MessageChannel();port1.ref();setTimeout(()=>{console.log(JSON.stringify([port1.hasRef(),port2.hasRef()]));port1.close();port2.close()},20).unref();`);
add('sqlite-changeset-callback-detach', `process.removeAllListeners('warning');const{DatabaseSync,constants}=require('node:sqlite'),a=new DatabaseSync(':memory:'),b=new DatabaseSync(':memory:');for(const d of[a,b])d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY,value TEXT)');const session=a.createSession({table:'t'});a.exec("INSERT INTO t VALUES(1,'new'),(2,'second')");b.exec("INSERT INTO t VALUES(1,'old')");const changes=session.changeset(),seen=[];const applied=b.applyChangeset(changes,{filter:table=>{seen.push(table);return true},onConflict:type=>{seen.push(type);structuredClone(changes.buffer,{transfer:[changes.buffer]});return constants.SQLITE_CHANGESET_REPLACE}});const out=[applied,seen,b.prepare('SELECT * FROM t ORDER BY id').all(),changes.byteLength];session.close();a.close();b.close();console.log(JSON.stringify(out));`);
add('decompression-stream-error-boundaries', `const z=require('zlib');(async()=>{const out=[];for(const[format,encode]of[['gzip',z.gzipSync],['brotli',z.brotliCompressSync]]){const bytes=encode(Buffer.from('payload'));const inputs=[['truncated',bytes.subarray(0,-1)],['trailing',Buffer.concat([bytes,Buffer.from([1])])]];if(format==='gzip')inputs.push(['concatenated',Buffer.concat([bytes,bytes])]);for(const[name,input]of inputs)try{await new Response(new Blob([input]).stream().pipeThrough(new DecompressionStream(format))).arrayBuffer();out.push([format,name,'accepted'])}catch(e){out.push([format,name,e.name,e.code,e.cause?.code])}}console.log(JSON.stringify(out))})()`);
add('domain-async-capture-versus-membership', `const D=require('domain'),{executionAsyncResource}=require('async_hooks'),a=D.create(),b=D.create();let timer,observed;const finish=(name,e)=>console.log(JSON.stringify([name,observed,e.message,e.domain===a]));a.on('error',e=>finish('a',e));b.on('error',e=>finish('b',e));a.run(()=>{timer=setTimeout(function(){observed=[process.domain===a,this.domain===b,executionAsyncResource()===this];throw new Error('timer')},1)});b.add(timer);timer.refresh();`);
add('rejection-time-domain-and-async-context', `const{AsyncLocalStorage}=require('async_hooks'),D=require('domain'),s=new AsyncLocalStorage(),a=D.create(),b=D.create(),out=[];a.on('error',e=>out.push(['a',e.message,s.getStore()]));b.on('error',e=>out.push(['b',e.message,s.getStore()]));let reject;a.run(()=>s.run('creation',()=>new Promise((resolve,no)=>reject=no)));b.run(()=>s.run('rejection',()=>reject(new Error('marker'))));setImmediate(()=>console.log(JSON.stringify([out,s.getStore()])));`);
add('domain-cross-realm-promise-rejection', `const d=require('domain').create(),out=[];d.on('error',e=>out.push(['domain',e.message]));process.on('unhandledRejection',e=>out.push(['global',e.message]));d.run(()=>{const p=require('vm').runInNewContext("Promise.reject(new Error('foreign'))");out.push(['ownsDomain',Object.hasOwn(p,'domain')])});setImmediate(()=>console.log(JSON.stringify(out)));`);
add('webcrypto-receiver-brands', `const w=require('crypto').webcrypto;(async()=>{const out=[];for(const Constructor of[Crypto,SubtleCrypto,CryptoKey])try{new Constructor();out.push('constructed')}catch(e){out.push([e.name,e.code])}let reads=0;const algorithm={get name(){reads++;return'SHA-256'}};let pending;try{pending=SubtleCrypto.prototype.digest.call({},algorithm,new Uint8Array());out.push(pending instanceof Promise);await pending;out.push('accepted')}catch(e){out.push([e.name,e.code,reads])}for(const[fn,args]of[[Crypto.prototype.getRandomValues,[new Uint8Array(1)]],[Object.getOwnPropertyDescriptor(Crypto.prototype,'subtle').get,[]],[Object.getOwnPropertyDescriptor(CryptoKey.prototype,'type').get,[]]])try{Reflect.apply(fn,{},args);out.push('accepted')}catch(e){out.push([e.name,e.code])}out.push(Buffer.from(await w.subtle.digest('SHA-256',new Uint8Array())).toString('hex'));console.log(JSON.stringify(out))})()`);
add('tls-legacy-certificate-normalization', `const translate=require('_tls_common').translatePeerCertificate;const root={infoAccess:['OCSP - URI:http://first','OCSP - URI:'+JSON.stringify('http://second/"quoted"'),'__proto__:safe'].join(String.fromCharCode(10))};root.issuerCertificate=root;const leaf={issuerCertificate:root,infoAccess:'CA Issuers - URI:http://issuer'};const result=translate(leaf);console.log(JSON.stringify([result===leaf,result.issuerCertificate===root,root.issuerCertificate===root,Object.getPrototypeOf(root.infoAccess)===null,Object.getPrototypeOf(leaf.infoAccess)===null,root.infoAccess,leaf.infoAccess,[undefined,null,false,0,''].map(translate)]));`);
file('ipc-child.cjs', `process.on('message',value=>{const valid=value.self===value&&value.map.get('n')===123n&&Buffer.isBuffer(value.bytes)&&value.bytes.toString()==='wire'&&value.view instanceof Uint16Array&&value.view[1]===513;process.send({valid,value},error=>{if(error)throw error;process.disconnect()})});`);
add('fork-eval-advanced-wire-interop', `const child=require('child_process').fork('./ipc-child.cjs',[],{execPath:process.env.NODE_REFERENCE,serialization:'advanced',silent:true});let response;child.on('message',value=>response=value);child.on('error',error=>{throw error});child.stderr.on('data',chunk=>process.stderr.write(chunk));child.on('close',(code,signal)=>console.log(JSON.stringify([code,signal,response?.valid,response?.value.self===response?.value,response?.value.map.get('n')===123n,Buffer.isBuffer(response?.value.bytes)])));const value={map:new Map([['n',123n]]),bytes:Buffer.from('wire'),view:new Uint16Array([7,513])};value.self=value;child.send(value);`);
file('package.json', JSON.stringify({ name: 'fixture', imports: { '#local': './mapped.cjs' } }));
file('mapped.cjs', 'module.exports = 17;');
file('node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', exports: { '.': { import: './import.mjs', require: './require.cjs' }, './feature/*': './features/*.cjs' } }));
file('node_modules/pkg/require.cjs', 'module.exports = { mode: "require" };');
file('node_modules/pkg/import.mjs', 'export const mode = "import"; export default mode;');
file('node_modules/pkg/features/a.cjs', 'module.exports = 23;');
file('node_modules/pkg/private.cjs', 'module.exports = "private";');
file('cycle-a.cjs', 'exports.name="a";exports.other=require("./cycle-b.cjs").name;');
file('cycle-b.cjs', 'exports.name="b";exports.other=require("./cycle-a.cjs").name;');
file('throwing.cjs', 'globalThis.attempts=(globalThis.attempts||0)+1;throw new Error("fail");');
file('data.json', '{"answer":42}');
file('module-entry.cjs', `const out=[require('pkg'),require('pkg/feature/a'),require('#local'),require('./cycle-a.cjs'),require('./cycle-b.cjs')];try{require('pkg/private.cjs')}catch(e){out.push(e.code)}for(let i=0;i<2;i++)try{require('./throwing.cjs')}catch{}out.push(globalThis.attempts);console.log(JSON.stringify(out));`);
file('esm-entry.mjs', `import value,{mode} from 'pkg';import data from './data.json' with {type:'json'};const c=await import('./cycle-a.cjs');console.log(JSON.stringify([value,mode,data,c.default.name]));`);
file('sync-esm.mjs', 'export let value=2;export function increment(){value++}');
file('async-esm.mjs', 'globalThis.asyncModuleStarted=true;await Promise.resolve();export const value=1;');
file('requires-esm.cjs', `const m=require('./sync-esm.mjs');m.increment();let code;try{require('./async-esm.mjs')}catch(e){code=e.code}console.log(JSON.stringify([m.value,code,globalThis.asyncModuleStarted]));`);
file('metadata.mjs', `import {fileURLToPath} from 'node:url';import {dirname} from 'node:path';console.log(JSON.stringify([fileURLToPath(import.meta.url)===import.meta.filename,dirname(import.meta.filename)===import.meta.dirname,import.meta.resolve('node:path'),import.meta.resolve('./data.json')===new URL('./data.json',import.meta.url).href,import.meta.main]));`);
file('builtin-sync.mjs', `import fs,{readFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.readFileSync;fs.readFileSync=()=>42;syncBuiltinESMExports();console.log(readFileSync());fs.readFileSync=original;syncBuiltinESMExports();console.log(readFileSync===original);`);
file('repl-globals.cjs', `const repl=require('node:repl'),{PassThrough}=require('node:stream'),vm=require('node:vm');const saved=repl.builtinModules;repl.builtinModules=[];const server=repl.start({prompt:'',terminal:false,input:new PassThrough(),output:new PassThrough()});repl.builtinModules=saved;const context=server.context,before=Object.getOwnPropertyDescriptor(context,'fs');const loaded=context.fs===require('node:fs'),after=Object.getOwnPropertyDescriptor(context,'fs');context.fs={marker:42};const assigned=Object.getOwnPropertyDescriptor(context,'fs');Object.defineProperty(context,'path',{configurable:false});const out=[typeof before.get,loaded,typeof after.get,before.enumerable,after.enumerable,assigned.enumerable,assigned.writable,vm.runInContext('fs.marker',context),context.path===require('node:path')];server.resetContext();out.push(server.context.fs===require('node:fs'));server.close();console.log(JSON.stringify(out));`);
cases.push({ name: 'repl-builtin-global-lifecycle', args: [join(directory, 'repl-globals.cjs')] });
cases.push({ name: 'cjs-package-maps-cycles-eviction', args: [join(directory, 'module-entry.cjs')] });
cases.push({ name: 'esm-package-json-cjs-interop', args: [join(directory, 'esm-entry.mjs')] });
cases.push({ name: 'require-synchronous-esm-async-rejection', args: [join(directory, 'requires-esm.cjs')] });
cases.push({ name: 'esm-import-meta', args: [join(directory, 'metadata.mjs')] });
cases.push({ name: 'esm-builtin-live-update', args: [join(directory, 'builtin-sync.mjs')] });
file('syntax-only.cjs', '#!/usr/bin/env node\nconsole.log("must-not-execute");require("./missing.cjs");return;\n');
file('syntax-only.mjs', 'import "./missing.mjs";console.log("must-not-execute");await Promise.resolve();export const value=42;\n');
file('syntax-invalid.cjs', 'const value = ;\n');
add('cli-syntax-only-boundaries', `const {spawnSync}=require('node:child_process');const cases=[[['--check','syntax-only.cjs']], [['--check','syntax-only.mjs']], [['--check','syntax-invalid.cjs']], [['--check','--input-type=module'],'import "./missing.mjs";console.log("must-not-execute")'],[['--check','--eval=console.log("must-not-execute")']], [['--input-type=module','syntax-only.cjs']]];console.log(JSON.stringify(cases.map(([args,input])=>{const child=spawnSync(process.execPath,args,{input,encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}});if(child.error)throw child.error;return [child.status,child.stdout]})));`);
add('cli-automatic-module-input', `const {spawnSync}=require('node:child_process');const source='await Promise.resolve();console.log(typeof require,42)';console.log(JSON.stringify([[['--eval='+source]], [[],source], [['--input-type=commonjs','--eval='+source]]].map(([args,input])=>{const child=spawnSync(process.execPath,args,{input,encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}});if(child.error)throw child.error;return [child.status,child.stdout]})));`);
// One long function whose call sites are asked for in mixed order, twice in a row
// and going backwards, through the stack string and through call sites.
file('stack-sites.cjs', `'use strict';
function mk(n) { return new Error('e' + n); }
function big(k) {
${Array.from({ length: 400 }, (_, i) => `  if (k === ${i}) { const pad${i} = "${'x'.repeat(i % 50)}"; return mk(pad${i}.length); }`).join('\n')}
  return mk(-1);
}
function small(k) { if (k & 1) return mk(1);
  return mk(2); }
const where = (e, d) => e.stack.split('\\n')[d].replace(/^.*[\\\\/]/, '');
const out = [];
for (const k of [5, 300, 5, 399, 0, 150, 150, 151, 20, 399, 398, 1, 250, 250, 3]) out.push(k + ' ' + where(big(k), 2));
for (let k = 0; k < 6; k++) out.push('s' + k + ' ' + where(small(k), 2));
for (let k = 399; k >= 0; k -= 37) out.push(k + ' ' + where(big(k), 2));
function sites(k) { Error.prepareStackTrace = (e, s) => s.slice(0, 3).map(c => c.getLineNumber() + ':' + c.getColumnNumber() + ':' + c.getFunctionName()).join(','); const r = big(k).stack; Error.prepareStackTrace = undefined; return r; }
for (const k of [7, 380, 7, 200]) out.push('cs' + k + ' ' + sites(k));
out.push('top ' + where(new Error('t'), 1)); out.push('top ' + where(new Error('t'), 1));
console.log(out.join('\\n'));
`);
cases.push({ name: 'error-stack-repeated-sites', args: [join(directory, 'stack-sites.cjs')] });
// Promise.all, allSettled, any and race against Node: settlement order, tick order,
// patched and inherited `then`, subclasses, thenables, iterator closing, rejection
// tracking, async stacks through combinators, and await over every kind of value.
file('promise-combinators.mjs', String.raw`import { AsyncLocalStorage, createHook } from 'node:async_hooks';
const log = [];
const out = (...a) => log.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
const tick = () => new Promise(r => setTimeout(r, 0));

// 1. basic + order
out('all', await Promise.all([1, Promise.resolve(2), new Promise(r => setTimeout(r, 1, 3)), { then(r) { r(4); } }]));
out('allSettled', await Promise.allSettled([1, Promise.reject(new Error('x')).catch(e => { throw e.message; }), Promise.reject(5)]));
out('any', await Promise.any([Promise.reject(1), Promise.resolve(2), 3]));
out('race', await Promise.race([new Promise(r => setTimeout(r, 5, 'slow')), Promise.resolve('fast')]));
try { await Promise.any([Promise.reject(1), Promise.reject(2)]); } catch (e) { out('agg', e.constructor.name, e.errors); }
try { await Promise.all([1, Promise.reject('r'), 3]); } catch (e) { out('all rej', e); }
out('empty', await Promise.all([]), await Promise.allSettled([]));
// out-of-order settlement
{
  const rs = []; const ps = [0, 1, 2, 3, 4].map(i => new Promise(r => rs[i] = r));
  const all = Promise.all(ps); [3, 0, 4, 2, 1].forEach(i => rs[i]('v' + i)); out('ooo', await all);
}
// sparse-ish: large arrays
out('big', (await Promise.all(Array.from({ length: 1000 }, (_, i) => i % 3 ? i : Promise.resolve(i)))).reduce((a, b) => a + b, 0));
// tick ordering
{
  const order = [];
  Promise.all([Promise.resolve(1)]).then(() => order.push('all'));
  Promise.resolve().then(() => order.push('t1')).then(() => order.push('t2')).then(() => order.push('t3')).then(() => order.push('t4'));
  await tick(); out('ticks', order);
}
{
  const order = [];
  Promise.all([1, 2]).then(() => order.push('all'));
  Promise.allSettled([1]).then(() => order.push('settled'));
  Promise.race([1]).then(() => order.push('race'));
  Promise.any([1]).then(() => order.push('any'));
  Promise.resolve().then(() => order.push('t1')).then(() => order.push('t2')).then(() => order.push('t3')).then(() => order.push('t4'));
  await tick(); out('ticks2', order);
}
// overridden then on instance
{
  const p = Promise.resolve(7); let called = 0;
  p.then = function (a, b) { called++; return Promise.prototype.then.call(this, a, b); };
  out('own then', await Promise.all([p]), called);
}
// then getter that throws
{
  const p = Promise.resolve(1); Object.defineProperty(p, 'then', { get() { throw new Error('getter'); } });
  try { await Promise.all([p]); } catch (e) { out('then getter', e.message); }
}
// patched prototype then
{
  const orig = Promise.prototype.then; let n = 0;
  Promise.prototype.then = function (a, b) { n++; return orig.call(this, a, b); };
  const v = await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
  Promise.prototype.then = orig; out('proto then', v, n > 0);
}
// patched Promise.resolve
{
  const orig = Promise.resolve; let n = 0;
  Promise.resolve = function (v) { n++; return orig.call(this, v); };
  const v = await Promise.all([1, 2, 3]); Promise.resolve = orig; out('patched resolve', v, n);
}
// subclass
{
  class P extends Promise { static calls = 0; then(a, b) { P.calls++; return super.then(a, b); } }
  const r = P.all([P.resolve(1), 2]); out('subclass', r instanceof P, await r, P.calls > 0);
  const q = Promise.all([P.resolve(9)]); out('sub in base', q instanceof P, await q);
}
// species / constructor override on element
{
  const p = Promise.resolve(3); let made = 0;
  p.constructor = { [Symbol.species]: function (ex) { made++; return new Promise(ex); } };
  out('ctor override', await Promise.all([p]), made);
}
// non-callable resolve
try { await Promise.all.call(function () {}, []); } catch (e) { out('bad ctor', e.constructor.name); }
// iterator closing on resolve throw
{
  let closed = 0; const it = { [Symbol.iterator]() { return { next() { return { value: 1, done: false }; }, return() { closed++; return {}; } }; } };
  const orig = Promise.resolve; Promise.resolve = () => { throw new Error('boom'); };
  let p; try { p = Promise.all(it); } finally { Promise.resolve = orig; }
  try { await p; } catch (e) { out('iter close', e.message, closed); }
}
// result array identity / mutation after
{
  const a = await Promise.all([1, 2]); a.push(3); out('arr', a, Array.isArray(a), Object.getPrototypeOf(a) === Array.prototype, a.length);
}
// resolve element function called twice / thenable calling twice
{
  const th = { then(r, j) { r('a'); r('b'); j('c'); } };
  out('twice', await Promise.all([th, th]), await Promise.allSettled([th]));
}
// thenable resolving later than others, with holes mid-flight
{
  let late; const th = { then(r) { late = r; } };
  const all = Promise.all([th, 1, 2]); await tick(); late('L'); out('late thenable', await all);
}
// reject then later fulfil does not disturb
{
  let r1; const p1 = new Promise(r => r1 = r);
  const all = Promise.all([p1, Promise.reject('E')]).catch(e => 'caught ' + e); r1(1); out('rej first', await all);
}
// unhandled rejection semantics: elements rejected are handled by all
{
  let unhandled = 0; const h = () => unhandled++; process.on('unhandledRejection', h);
  await Promise.allSettled([Promise.reject(1), Promise.reject(2)]);
  await Promise.all([Promise.reject(1), Promise.reject(2)]).catch(() => {});
  await tick(); await tick(); process.off('unhandledRejection', h); out('unhandled', unhandled);
}
// async stack
{
  async function leaf() { await null; throw new Error('deep'); }
  async function mid() { return Promise.all([1, leaf()]); }
  try { await mid(); } catch (e) { out('stack', e.stack.split('\n').slice(0, 4).map(s => s.replace(/\(.*[\\/]/, '(').replace(/file:.*[\\/]/, '')).join(' | ')); }
}
// AsyncLocalStorage
{
  const als = new AsyncLocalStorage();
  out('als', await als.run('ctx', async () => { const [a] = await Promise.all([Promise.resolve(1).then(() => als.getStore())]); await Promise.all([1, 2]); return [a, als.getStore()]; }));
}
// async hooks
{
  let inits = 0; const hook = createHook({ init(id, type) { if (type === 'PROMISE') inits++; } }).enable();
  await Promise.all([Promise.resolve(1), 2]); hook.disable(); out('hooks', inits);
}
// await in loops of various values
{
  async function f(x) { return x; } async function g() { throw new Error('g'); }
  let s = 0; for (let i = 0; i < 100; i++) { s += await i; s += await f(i); s += await Promise.resolve(i); s += await { then(r) { r(i); } }; }
  try { await g(); } catch (e) { s += e.message; } try { await Promise.reject('z'); } catch (e) { s += e; } try { await { then(_, j) { j('t'); } }; } catch (e) { s += e; }
  out('awaits', s);
}
// new Promise resolve/reject functions
{
  let res, rej; const p = new Promise((a, b) => { res = a; rej = b; });
  out('fn props', res.length, rej.length, res.name, rej.name, typeof res, res !== rej);
  res(1); rej(2); res(3); out('first wins', await p);
  let r2; const p2 = new Promise((a, b) => { r2 = b; a(p); }); r2('no'); out('locked', await p2);
  let keep; new Promise(r => keep = r); const p3 = new Promise((_, j) => j('x')); out('rejfn', await p3.catch(e => e), keep.name);
  try { new Promise(r => { r(1); throw new Error('after'); }); out('throw after resolve ok'); } catch (e) { out('bad'); }
  const self = new Promise(r => setTimeout(() => r(self), 0)); out('self', await self.catch(e => e.constructor.name));
}
console.log(log.join('\n'));
`);
cases.push({ name: 'promise-combinators', args: [join(directory, 'promise-combinators.mjs')] });
// Elements that mix untouched promises with patched ones, late thenables that lock
// a race in, a thenable result array, and combinators nested or abandoned.
file('promise-combinators-mixed.mjs', String.raw`const log = []; const out = (...a) => log.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
const tick = () => new Promise(r => setTimeout(r, 0));
// race: first fulfils with a late thenable, second with plain value: first wins (locked in)
{
  const o = {}; const p1 = Promise.resolve(o); o.then = (r) => setTimeout(r, 5, 'from thenable');
  out('race locked', await Promise.race([p1, Promise.resolve('second')]));
}
// same but the second element goes through a patched then (function pair path)
{
  const o = {}; const p1 = Promise.resolve(o); o.then = (r) => setTimeout(r, 5, 'from thenable');
  const p2 = Promise.resolve('second'); p2.then = function (a, b) { return Promise.prototype.then.call(this, a, b); };
  out('race locked mixed', await Promise.race([p1, p2]));
  const q1 = Promise.resolve('q1'); q1.then = function (a, b) { return Promise.prototype.then.call(this, a, b); };
  const o2 = {}; const q2 = Promise.resolve(o2); o2.then = (r) => setTimeout(r, 5, 'thenable2');
  out('race mixed 2', await Promise.race([q1, q2]));
}
// all with Array.prototype.then making the values array a thenable
{
  let seen = 0; Array.prototype.then = function (r) { seen++; delete Array.prototype.then; r('hijacked'); };
  out('array thenable', await Promise.all([1, Promise.resolve(2)]), seen); delete Array.prototype.then;
}
// all: mixed plain + patched elements, out of order, reject after
{
  const mk = (v, ms, patched, rej) => { const p = new Promise((r, j) => setTimeout(rej ? j : r, ms * 8, v)); if (patched) p.then = function (a, b) { return Promise.prototype.then.call(this, a, b); }; return p; };
  out('mixed all', await Promise.all([mk(1, 6), mk(2, 2, true), 3, mk(4, 4, true), mk(5, 1)]));
  out('mixed settled', await Promise.allSettled([mk(1, 6), mk(2, 2, true, true), 3, mk(4, 4, true), mk(5, 1, false, true)]));
  out('mixed any', await Promise.any([mk(1, 6, false, true), mk(2, 2, true, true), mk(4, 4, true), mk(5, 5)]));
  out('mixed any rej', await Promise.any([mk(1, 6, false, true), mk(2, 2, true, true), mk(5, 1, false, true)]).catch(e => e.errors));
  out('mixed all rej', await Promise.all([mk(1, 6), mk(2, 2, true, true), mk(4, 1, false, true), mk(5, 3, true, true)]).catch(e => 'rej ' + e));
  out('mixed race', await Promise.race([mk(1, 60), mk(2, 5, true), mk(4, 30), mk(5, 50, true)]));
  await new Promise(r => setTimeout(r, 500));
}
// thenable element invoking handlers repeatedly and synchronously
{
  const th = { then(r, j) { r(1); r(2); j(3); } };
  out('thenables', await Promise.all([th, Promise.resolve(5), th]), await Promise.any([{ then(r, j) { j('a'); r('b'); } }, Promise.reject('c')]).catch(e => e.errors));
}
// element then called synchronously re-entrantly during iteration
{
  const p = Promise.resolve(1); let handlers;
  p.then = function (a, b) { handlers = [a, b]; a('sync'); a('again'); };
  out('sync then', await Promise.all([p, 2]), typeof handlers[0], handlers[0].length, handlers[0].name, typeof handlers[1], handlers[1].name);
}
// iterator throws midway after subscriptions
{
  function* gen() { yield Promise.resolve(1); yield new Promise(r => setTimeout(r, 2, 2)); throw new Error('iter'); }
  out('iter throw', await Promise.all(gen()).catch(e => e.message)); await tick();
  out('iter throw settled', await Promise.allSettled(gen()).catch(e => e.message));
}
// many rejections, all handled, events
{
  let unhandled = 0; const h = () => unhandled++; process.on('unhandledRejection', h);
  await Promise.all([Promise.reject(new Error('a')), Promise.reject(new Error('b')), new Promise((_, j) => setTimeout(j, 1, 'c'))]).catch(() => {});
  await Promise.race([Promise.reject('r1'), Promise.reject('r2'), Promise.resolve('r3')]).catch(() => {});
  await Promise.any([Promise.resolve('a1'), Promise.resolve('a2'), Promise.reject('a3')]);
  await new Promise(r => setTimeout(r, 5)); process.off('unhandledRejection', h); out('unhandled', unhandled);
}
// result identity and types
{
  const r = Promise.all([]); out('ident', r instanceof Promise, r.constructor === Promise, Object.getPrototypeOf(r) === Promise.prototype);
  const s = await Promise.allSettled([Promise.reject(1)]); out('settled obj', Object.keys(s[0]), Object.getPrototypeOf(s[0]) === Object.prototype);
}
// nested combinators and async stack through them
{
  async function leaf(n) { await null; if (n === 2) throw new Error('deep' + n); return n; }
  async function mid() { return await Promise.all([leaf(0), Promise.allSettled([leaf(1)]), Promise.any([leaf(2), leaf(3)])]); }
  out('nested', await mid());
  async function f1() { await Promise.allSettled([leaf(1)]); await Promise.all([leaf(0), leaf(2)]); }
  try { await f1(); } catch (e) { out('stack all', e.stack.split('\n').slice(1).map(s => s.trim().replace(/\(.*[\\/]/, '(').replace(/file:.*[\\/]/, '')).join(' | ')); }
  async function thrower() { await null; throw new Error('t'); }
  async function f2() { await Promise.any([thrower()]); }
  try { await f2(); } catch (e) { out('stack any', e.constructor.name, e.errors[0].stack.split('\n').slice(1).map(s => s.trim().replace(/\(.*[\\/]/, '(').replace(/file:.*[\\/]/, '')).join(' | ')); }
  async function f3() { return (await Promise.allSettled([thrower()]))[0].reason; }
  out('stack settled', (await f3()).stack.split('\n').slice(1).map(s => s.trim().replace(/\(.*[\\/]/, '(').replace(/file:.*[\\/]/, '')).join(' | '));
  async function f4() { await Promise.race([thrower()]); }
  try { await f4(); } catch (e) { out('stack race', e.stack.split('\n').slice(1).map(s => s.trim().replace(/\(.*[\\/]/, '(').replace(/file:.*[\\/]/, '')).join(' | ')); }
}
// ordering across many microtasks
{
  const order = []; const mark = (s) => () => order.push(s);
  const a = Promise.resolve('a'), b = Promise.reject('b');
  Promise.all([a, b]).then(mark('all ok'), mark('all rej'));
  Promise.allSettled([a, b]).then(mark('settled'));
  Promise.any([b, a]).then(mark('any'));
  Promise.race([b, a]).then(mark('race ok'), mark('race rej'));
  let p = Promise.resolve(); for (let i = 0; i < 6; i++) p = p.then(mark('t' + i));
  await tick(); out('order', order);
}
// large + GC churn
{
  let total = 0; for (let k = 0; k < 200; k++) { const r = await Promise.all(Array.from({ length: 50 }, (_, i) => i % 2 ? Promise.resolve(i) : new Promise(r => queueMicrotask(() => r(i))))); total += r.length + r[49]; }
  out('churn', total);
  // abandoned combinators (never settle)
  for (let k = 0; k < 2000; k++) { Promise.all([new Promise(() => {}), 1]); Promise.any([new Promise(() => {})]); Promise.race([new Promise(() => {})]); }
  if (globalThis.gc) gc(); out('abandoned ok');
}
await tick(); await tick();
console.log(log.join('\n'));
`);
cases.push({ name: 'promise-combinators-mixed', args: [join(directory, 'promise-combinators-mixed.mjs')] });
let passed = 0, failed = 0;
try {
  if (!cases.some(item => filter.test(item.name))) throw new Error('No compatibility scenarios match ' + filter);
  for (const scenario of cases.filter(item => filter.test(item.name))) {
    const options = { cwd: directory, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_REFERENCE: reference, NO_COLOR: '1', NODE_DEBUG: '' } };
    const expected = spawnSync(reference, scenario.args, options);
    const actual = spawnSync(runtime, scenario.args, options);
    try {
      assert.ifError(expected.error); assert.ifError(actual.error);
      assert.equal(actual.signal, expected.signal);
      assert.equal(actual.status, expected.status, actual.stderr);
      assert.equal(actual.stdout, expected.stdout);
      if (scenario.name !== 'unhandled-rejection-exit') assert.equal(actual.stderr, expected.stderr);
      else assert.match(actual.stderr, /Error: must fail/);
      console.log('PASS ' + scenario.name); passed++;
    } catch (error) {
      console.error('FAIL ' + scenario.name + '\n' + error.message);
      console.error('runtime stderr: ' + actual.stderr); failed++;
    }
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log(`${passed} passed; ${failed} failed`);
process.exitCode = failed ? 1 : 0;
