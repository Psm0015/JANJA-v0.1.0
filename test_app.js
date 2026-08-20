const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('static/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:3000/host' });
global.window = dom.window;
global.document = dom.window.document;
global.sessionStorage = { getItem: () => null, setItem: () => {} };
global.crypto = { getRandomValues: () => new Uint32Array(4) };
global.navigator = { mediaDevices: {} };
global.URLSearchParams = window.URLSearchParams;
try {
  const code = fs.readFileSync('static/app.js', 'utf8');
  eval(code);
  console.log('SUCCESS');
} catch (e) {
  console.error('ERROR:', e);
}
