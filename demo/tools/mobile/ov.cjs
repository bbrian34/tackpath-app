const { launch } = require('/home/user/tackpath-app/tests/browser.js');
const fs=require('fs'); const D='/tmp/claude-0/-home-user/d2a398bd-98fd-5de5-966c-612af79a3bf3/scratchpad/mob/';
(async()=>{const spec=JSON.parse(fs.readFileSync(D+'spec.json'));fs.mkdirSync(D+'ov',{recursive:true});
const b=await launch();const p=await (await b.newContext({viewport:{width:1080,height:1920},deviceScaleFactor:1})).newPage();
await p.goto('file://'+D+'overlay.html');await p.waitForTimeout(600);
for(const s of spec){await p.evaluate(o=>window.render(o),s.overlay);await p.waitForTimeout(120);
 await p.screenshot({path:D+'ov/'+String(s.i).padStart(2,'0')+'.png',omitBackground:s.kind==='shot'});}
await b.close();console.log('overlays',spec.length);})();
