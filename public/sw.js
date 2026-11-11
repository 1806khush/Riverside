// Retire existing Mosaic Web service workers at their original URL.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.registration.unregister()))
