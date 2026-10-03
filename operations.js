'use strict';
(() => {
 const panel=document.querySelector('#operations-preview');
 const toggle=panel.querySelector('.preview-toggle');
 const heroVideo=panel.querySelector('video');
 const videos=[...document.querySelectorAll('video')];
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let userPaused=reduced.matches;
 const inView=new Map(videos.map(video=>[video,true]));
 function sync(){
   toggle.textContent=userPaused?'Play animation':'Pause animation';
   toggle.setAttribute('aria-pressed',String(userPaused));
   videos.forEach(video=>{
     if(document.hidden||!inView.get(video)||(video===heroVideo&&userPaused)||reduced.matches)video.pause();
     else video.play().catch(()=>{});
   });
 }
 const observer=new IntersectionObserver(entries=>{
   entries.forEach(entry=>inView.set(entry.target,entry.isIntersecting));
   sync();
 },{threshold:.15});
 videos.forEach(video=>observer.observe(video));
 toggle.addEventListener('click',()=>{
   userPaused=!userPaused;
   if(!userPaused)heroVideo.play().catch(()=>{});
   else heroVideo.pause();
   toggle.textContent=userPaused?'Play animation':'Pause animation';
   toggle.setAttribute('aria-pressed',String(userPaused));
 });
 reduced.addEventListener('change',()=>{userPaused=reduced.matches;sync();});
 document.addEventListener('visibilitychange',sync);
 sync();
})();