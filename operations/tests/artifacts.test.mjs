import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {parse} from 'acorn';
const base=path.resolve(import.meta.dirname,'../..');export const webRoot=fs.existsSync(path.join(base,'dispatcher.html'))?base:path.join(base,'tackpath-app');
// 2026-10: dispatcher.html, driver.html and stow.html never loaded operations-client.js; they
// sign in and work through the tp_org / tp_driver gateway (supabase/security, 10_sessions_and_rpcs.sql)
// instead. They are still parsed here; the shared ops client is required only where it is used.
const OPS_CLIENT_PAGES=['dispatcher-white.html','driver-app.html','smartsort.html'],GATEWAY_PAGES=['dispatcher.html','driver.html','stow.html'];
test('all shipped operational HTML scripts parse and share the authenticated client',()=>{for(const file of [...GATEWAY_PAGES,...OPS_CLIENT_PAGES]){const html=fs.readFileSync(path.join(webRoot,file),'utf8');if(OPS_CLIENT_PAGES.includes(file))assert.ok(html.includes('operations-client.js'),file);else assert.ok(/tp_org|tp_driver/.test(html),file+' uses the tp_org / tp_driver gateway');for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))parse(script[1],{ecmaVersion:'latest'});assert.ok(!html.includes("textContent='</script>"),file)}});
