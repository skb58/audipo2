/* Audipo2 PWA Service Worker (v70) — Offline Shell + Share Target Receiver */
const CACHE_NAME = 'audipo2-shell-v70';
const SHARE_DB_NAME = 'audipo2_incoming_share_v1';
const SHARE_DB_STORE = 'inbox';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    } catch (_) {}
    await self.clients.claim();
  })());
});

function openShareInboxDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SHARE_DB_STORE)) {
        db.createObjectStore(SHARE_DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Share IDB open failed'));
  });
}

async function saveSharePayloadToIDB(payload) {
  const db = await openShareInboxDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SHARE_DB_STORE, 'readwrite');
    tx.objectStore(SHARE_DB_STORE).put(payload, 'latest');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Share IDB tx aborted'));
  });
  db.close();
}

async function handleShareTargetPost(request) {
  try {
    const formData = await request.formData();
    const title = String(formData.get('title') || '').trim();
    const text = String(formData.get('text') || '').trim();
    const url = String(formData.get('url') || '').trim();

    const rawFiles = [];
    for (const [, val] of formData.entries()) {
      if (val && typeof val === 'object' && typeof val.arrayBuffer === 'function' && val.size > 0) {
        rawFiles.push(val);
      }
    }

    // Materialize file bytes immediately while Android content:// stream is alive
    const files = [];
    for (let i = 0; i < rawFiles.length; i++) {
      const f = rawFiles[i];
      try {
        const buf = await f.arrayBuffer();
        files.push({
          name: f.name || `shared_${i + 1}`,
          type: f.type || '',
          lastModified: Number(f.lastModified) || Date.now(),
          blob: new Blob([buf], { type: f.type || '' })
        });
      } catch (_) {}
    }

    await saveSharePayloadToIDB({
      receivedAt: Date.now(),
      title,
      text,
      url,
      files
    });
  } catch (err) {
    console.warn('Share target POST handling error:', err);
  }

  return Response.redirect(`./index.html?incoming_share=1&ts=${Date.now()}`, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept cross-origin requests (YouTube, Gemini API, Whisper CDN, etc.)
  if (url.origin !== self.location.origin) {
    return;
  }

  // Handle Web Share Target POST (files, pins, YouTube URLs shared from Android/OS)
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTargetPost(req));
    return;
  }

  if (req.method !== 'GET') {
    return;
  }

  // Network-first for HTML / manifest / navigation so GitHub Pages updates apply promptly
  const isNavOrDoc = req.mode === 'navigate'
    || url.pathname.endsWith('/')
    || url.pathname.endsWith('/index.html')
    || url.pathname.endsWith('/manifest.json');

  if (isNavOrDoc) {
    event.respondWith((async () => {
      try {
        const netRes = await fetch(req);
        if (netRes && netRes.ok && !url.search.includes('_v=')) {
          const cache = await caches.open(CACHE_NAME);
          const cacheKey = req.mode === 'navigate' ? './index.html' : req;
          cache.put(cacheKey, netRes.clone()).catch(() => {});
        }
        return netRes;
      } catch (_) {
        const cached = await caches.match(req) || await caches.match('./index.html');
        if (cached) return cached;
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Cache-first with network fallback for local static assets (icons, etc.)
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const netRes = await fetch(req);
      if (netRes && netRes.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, netRes.clone()).catch(() => {});
      }
      return netRes;
    } catch (_) {
      return new Response('', { status: 504 });
    }
  })());
});
