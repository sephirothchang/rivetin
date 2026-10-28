import { mountDemo } from '../src/view.js';
const dispose = mountDemo(document.getElementById('app'), window);
window.addEventListener('pagehide', dispose, { once: true });

