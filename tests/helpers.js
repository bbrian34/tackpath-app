const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Loads a live TackPath HTML file and boots it in jsdom with mockable
// fetch/localStorage/Capacitor, so real app code runs against fake data
// instead of the live Supabase backend.
function loadApp(htmlFilename, { url, fetchHandler, initialStorage = {} } = {}) {
  const htmlPath = path.join(__dirname, '..', htmlFilename);
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const storage = { ...initialStorage };
  const calls = { fetch: [] };

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: undefined,
    url: url || 'https://tackpath.com/' + htmlFilename,
    pretendToBeVisual: true,
    beforeParse(window) {
      delete window.speechSynthesis;
      window.Element.prototype.scrollIntoView = () => {};
      window.fetch = async (reqUrl, opts) => {
        calls.fetch.push({ url: reqUrl, opts });
        if (fetchHandler) {
          const result = await fetchHandler(reqUrl, opts, storage);
          if (result !== undefined) return result;
        }
        return { ok: true, json: async () => ([]) };
      };
      window.Capacitor = {
        Plugins: {
          AppLauncher: { openUrl: async () => ({ completed: true }) },
          LocalNotifications: {
            requestPermissions: async () => ({ display: 'granted' }),
            createChannel: async () => {},
            registerActionTypes: async () => {},
            addListener: () => {},
            schedule: async () => {},
            cancel: async () => {},
          },
        },
      };
      Object.defineProperty(window, 'localStorage', {
        value: {
          getItem: (k) => (k in storage ? storage[k] : null),
          setItem: (k, v) => { storage[k] = v; },
          removeItem: (k) => { delete storage[k]; },
        },
      });
    },
  });

  dom.window.onerror = (msg) => {
    throw new Error('Runtime error in ' + htmlFilename + ': ' + msg);
  };

  return { dom, storage, calls, cleanup: () => dom.window.close() };
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { loadApp, wait };
