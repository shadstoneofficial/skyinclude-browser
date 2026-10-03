const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = path.resolve(process.env.ACCEPTANCE_OUTPUT || 'acceptance-evidence');
fs.mkdirSync(output, {recursive: true});
const requests = [];
const fixture = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    requests.push({method: req.method, url: req.url, body, host: req.headers.host});
    res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
    res.end('<!doctype html><title>Disposable acceptance fixture</title><h1 id="fixture">Packaged navigation passed</h1><a href="/next">Next local page</a><form method="post" action="/submit"><input name="message" value="inert-acceptance"><button id="submit">Submit inert fixture</button></form>');
  });
});

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', reject, {once: true});
  });
  let sequence = 0;
  const waiting = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
        waiting.set(id, {resolve: value => {clearTimeout(timer); resolve(value);}, reject: error => {clearTimeout(timer); reject(error);}});
        socket.send(JSON.stringify({id, method, params}));
      });
    },
    close() { socket.close(); },
  };
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function until(callback, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await callback(); if (result) return result; } catch (_) {}
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function main() {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
  const port = Number(process.env.ACCEPTANCE_CDP_PORT || 9335);
  const child = spawn(process.env.ACCEPTANCE_EXECUTABLE, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(output, 'profile')}`,
    '--disable-gpu', ...(process.env.ACCEPTANCE_EXTRA_ARGS || '').split(' ').filter(Boolean),
  ], {stdio: ['ignore', fs.openSync(path.join(output, 'stdout.log'), 'w'), fs.openSync(path.join(output, 'stderr.log'), 'w')]});
  let shell;
  let content;
  const report = {sourceCommit: '00bfaa8bbb11098d91f2ab9eebe84930feb22cb7', expectedVersion: '0.1.25', platform: process.platform, arch: process.arch, artifact: process.env.ACCEPTANCE_ARTIFACT, sha256: process.env.ACCEPTANCE_SHA256, extraArgs: process.env.ACCEPTANCE_EXTRA_ARGS || '', checks: {}};
  try {
    const shellTarget = await until(async () => (await targets(port)).find(t => t.url.endsWith('/index.html')), 'packaged shell');
    shell = await connect(shellTarget.webSocketDebuggerUrl);
    report.checks.version = await evaluate(shell, 'window.electronAPI.getAppInfo().then(info => info.version)');
    assert.equal(report.checks.version, '0.1.25');
    await evaluate(shell, `(() => {const input=document.querySelector('#address-bar'); if(!input) throw new Error('Address input missing'); input.value=${JSON.stringify(fixtureUrl)}; input.dispatchEvent(new KeyboardEvent('keypress',{key:'Enter',bubbles:true}));})()`);
    const localTarget = await until(async () => (await targets(port)).find(t => t.url.startsWith(fixtureUrl)), 'actual BrowserView navigation');
    content = await connect(localTarget.webSocketDebuggerUrl);
    assert.match(await evaluate(content, 'document.body.innerText'), /Packaged navigation passed/);
    report.checks.localNavigation = 'PASS';
    const capture = await content.call('Page.captureScreenshot');
    fs.writeFileSync(path.join(output, 'packaged-navigation.png'), Buffer.from(capture.data, 'base64'));
    await evaluate(content, 'document.querySelector("a").click()');
    await until(async () => (await targets(port)).some(t => t.url === `${fixtureUrl}next`), 'local link first click');
    report.checks.firstClickLink = 'PASS';
    report.requests = requests;
    report.success = true;
  } catch (error) {
    report.success = false;
    report.error = error.stack;
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (content) content.close();
    if (shell) shell.close();
    child.kill('SIGTERM');
    await delay(1500);
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise(resolve => fixture.close(resolve));
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
