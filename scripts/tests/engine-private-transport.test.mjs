import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import http from 'node:http';
import net from 'node:net';

test('managed HTTP binds private socket while foreign TCP listener receives no credentials',
  { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-transport-'));
  const preload = join(dir, 'preload.cjs');
  copyFileSync(new URL('../../app/src/main/assets/engine-private-transport.cjs', import.meta.url), preload);
  let stolen = '';
  const foreign = net.createServer(socket => socket.on('data', data => { stolen += data; }));
  await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen(3080, '127.0.0.1', resolve); });
  const code = `const http=require('node:http');
    const server=http.createServer((req,res)=>res.end(req.headers.cookie+'|'+req.url));
    server.on('upgrade',(req,s)=>{s.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\nMUX');});
    server.listen(3080,'127.0.0.1',()=>console.log(JSON.stringify(server.address())));`;
  const child = spawn(process.execPath, ['--require', preload, '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  try {
    const lines = createInterface({ input: child.stdout });
    const address = await new Promise((resolve, reject) => {
      lines.once('line', line => resolve(JSON.parse(line)));
      child.once('exit', code => reject(new Error(`engine exited ${code}: ${errors}`)));
    });
    assert.deepEqual(address, { address: '127.0.0.1', family: 'IPv4', port: 3080 });
    const socketPath = join(dir, 'engine-private.sock');
    const response = await new Promise((resolve, reject) => {
      const req = http.get({ socketPath, path: '/?token=private-token', headers: { Cookie: 'private-cookie', Host: '127.0.0.1:3080' } }, res => {
        let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve(body));
      });
      req.on('error', reject);
    });
    assert.equal(response, 'private-cookie|/?token=private-token');
    const upgrade = await new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      let data = '';
      socket.on('connect', () => socket.write('GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:3080\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: private-cookie\r\n\r\n'));
      socket.on('data', chunk => { data += chunk; });
      socket.on('end', () => { socket.destroy(); resolve(data); }); socket.on('error', reject);
    });
    assert.match(upgrade, /101 Switching Protocols/);
    assert.match(upgrade, /MUX$/);
    assert.equal(stolen, '', 'foreign TCP process must receive no token, cookie or payload');
    // Controlled negative: without the production preload the same engine fixture cannot bind.
    const unprotected = spawn(process.execPath, ['-e', code]);
    let refusal = '';
    unprotected.stderr.on('data', data => { refusal += data; });
    const exit = await new Promise(resolve => unprotected.once('exit', resolve));
    assert.notEqual(exit, 0);
    assert.match(refusal, /EADDRINUSE/);
  } finally {
    child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await new Promise(resolve => foreign.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preload leaves unrelated HTTP servers on TCP', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['--require', fileURLToPath(new URL('../../app/src/main/assets/engine-private-transport.cjs', import.meta.url)), '-e',
    `const s=require('node:http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>{console.log(JSON.stringify(s.address()));s.close();});`]);
  let output = ''; let errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, errors);
  assert.equal(typeof JSON.parse(output).port, 'number');
});
