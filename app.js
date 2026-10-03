'use strict';
const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
function closeMenu() { menuButton.setAttribute('aria-expanded', 'false'); menuButton.setAttribute('aria-label', 'Open navigation'); navigation.classList.remove('open'); }
menuButton.addEventListener('click', () => { const open = menuButton.getAttribute('aria-expanded') !== 'true'; menuButton.setAttribute('aria-expanded', String(open)); menuButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation'); navigation.classList.toggle('open', open); });
navigation.querySelectorAll('a, button').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
const solutions = {
  "sling": {
    "label": "PATHIQ / WAREHOUSE WORKSPACE",
    "title": "A clear destination.<br>For every scan.",
    "description": "Give the warehouse floor a focused scanning workflow. PathIQ reads package identifiers from the route manifest, shows the assigned bin, and checks the bin scan before counting placement.",
    "points": [
      "Barcode-to-bin guidance",
      "Package and bin scan sequence",
      "Wrong-bin and duplicate-scan feedback"
    ],
    "cta": "Explore PathIQ",
    "name": "PathIQ",
    "journey": "FROM PACKAGE IDENTIFIER TO ROUTE BIN",
    "start": "Package scan",
    "end": "Route bin",
    "cardTitle": "Clear instructions at the point of work.",
    "cardText": "Scan package · Find bin · Confirm placement"
  },
  "surge": {
    "label": "DRIVER / DELIVERY WORKSPACE",
    "title": "Pick up the work.<br>Take the next stop.",
    "description": "Give drivers a focused workflow from pickup to delivery. Work through bin and package scans, confirm pickup, launch Google Maps, and report stop completion as the route progresses.",
    "points": [
      "Bin and package loading checks",
      "Stop-by-stop navigation handoff",
      "Delivery updates and dispatch messaging"
    ],
    "cta": "Explore Driver",
    "name": "Driver",
    "journey": "FROM PICKUP TO THE NEXT DELIVERY",
    "start": "Pickup",
    "end": "Next stop",
    "cardTitle": "The route, one step at a time.",
    "cardText": "Check load · Confirm pickup · Navigate · Report delivery"
  },
  "symphony": {
    "label": "DISPATCHER / OPERATIONS WORKSPACE",
    "title": "The route in context.<br>The next move in view.",
    "description": "Coordinate jobs and drivers from one dispatch workspace. Follow location updates and reported deliveries, review exceptions, and keep the team informed through job-linked driver messages.",
    "points": [
      "Assignments and route progress",
      "Driver location and arrival estimates",
      "Late, unassigned, and quiet-driver signals"
    ],
    "cta": "Explore Dispatcher",
    "name": "Dispatcher",
    "journey": "FROM FIELD UPDATES TO DISPATCH DECISIONS",
    "start": "Field updates",
    "end": "Dispatch view",
    "cardTitle": "Context for the people coordinating the day.",
    "cardText": "Jobs · Drivers · Stop progress · Exceptions"
  }
};
const tabs = [...document.querySelectorAll('[data-solution]')];
function setSolution(tab) {
  const data = solutions[tab.dataset.solution];
  tabs.forEach(item => { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; });
  document.querySelector('#solution-panel').setAttribute('aria-labelledby', tab.id);
  document.querySelector('#solution-label').textContent = data.label;
  document.querySelector('#solution-title').innerHTML = data.title;
  document.querySelector('#solution-description').textContent = data.description;
  document.querySelector('#solution-points').replaceChildren(...data.points.map(point => { const li = document.createElement('li'); li.textContent = point; return li; }));
  document.querySelector('#solution-cta').innerHTML = data.cta + ' <span>↗</span>';
  document.querySelector('#journey-label').textContent = data.journey;
  document.querySelector('.journey-heading .pill').textContent = data.name;
  document.querySelector('#journey-start').textContent = data.start;
  document.querySelector('#journey-end').textContent = data.end;
  document.querySelector('#journey-card-title').textContent = data.cardTitle;
  document.querySelector('#journey-card-text').textContent = data.cardText;
}
tabs.forEach((tab, index) => { tab.addEventListener('click', () => setSolution(tab)); tab.addEventListener('keydown', event => { let next; if (event.key === 'ArrowRight') next = (index + 1) % tabs.length; if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length; if (event.key === 'Home') next = 0; if (event.key === 'End') next = tabs.length - 1; if (next !== undefined) { event.preventDefault(); setSolution(tabs[next]); tabs[next].focus(); } }); });
const dialog = document.querySelector('#demo-dialog');
const form = document.querySelector('#demo-form');
let opener;
document.querySelectorAll('[data-demo]').forEach(button => button.addEventListener('click', () => {
  opener = button; closeMenu(); form.hidden = false; document.querySelector('#email-ready').hidden = true;
  let interest = 'Platform walkthrough';
  if (button.closest('#managed')) interest = 'Dispatcher - operations visibility';
  if (button.id === 'solution-cta') { const selected = tabs.find(tab => tab.getAttribute('aria-selected') === 'true').dataset.solution; interest = { sling: 'PathIQ - warehouse scanning', surge: 'Driver - delivery workflow', symphony: 'Dispatcher - operations visibility' }[selected]; }
  form.elements.interest.value = interest; dialog.showModal(); document.body.style.overflow = 'hidden';
}));
function closeDialog() { dialog.close(); }
document.querySelector('.dialog-close').addEventListener('click', closeDialog);
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } });
dialog.addEventListener('close', () => { document.body.style.overflow = ''; opener?.focus(); });
form.addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(form);
  const subject = `TackPath demo request: ${data.get('company')}`;
  const body = `Hello TackPath,\n\nI'd like to learn more about ${data.get('interest')}.\n\nName: ${data.get('name')}\nWork email: ${data.get('email')}\nCompany: ${data.get('company')}\n\nAbout our operation:\n${data.get('message') || 'Let’s discuss our operation in a walkthrough.'}\n\nThank you,\n${data.get('name')}`;
  document.querySelector('#send-email').href = `mailto:hello@tackpath.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  document.querySelector('#email-text').value = `To: hello@tackpath.com\nSubject: ${subject}\n\n${body}`;
  form.hidden = true; document.querySelector('#email-ready').hidden = false; document.querySelector('#copy-status').textContent = ''; document.querySelector('#send-email').focus();
});
document.querySelector('#copy-email').addEventListener('click', async () => {
  const text = document.querySelector('#email-text');
  try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(text.value); document.querySelector('#copy-status').textContent = 'Request copied. Paste it into your email app.'; }
  catch { text.focus(); text.select(); document.querySelector('#copy-status').textContent = 'Request selected. Press Ctrl+C (or Command+C) to copy.'; }
});

// Respect reduced motion for the silent overview film.
const overviewVideo=document.querySelector(".overview-film video");
const filmMotionPreference=matchMedia("(prefers-reduced-motion: reduce)");
function applyFilmMotionPreference(){if(filmMotionPreference.matches){overviewVideo.autoplay=false;overviewVideo.pause();}else{overviewVideo.autoplay=true;overviewVideo.play().catch(()=>{});}}
filmMotionPreference.addEventListener("change",applyFilmMotionPreference);
applyFilmMotionPreference();
