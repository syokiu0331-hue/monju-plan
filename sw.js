// 文殊 学習計画アプリ — 画面の部品をスマホに保存して、すぐ開けるようにする（データは毎回サーバーから読む）
const CACHE = 'monju-shell-v3';
const SHELL = ['app.css', 'app.js', 'config.js', 'student.html', 'teacher.html', 'manifest-student.webmanifest', 'manifest-teacher.webmanifest',
  'student-192.png', 'student-180.png', 'teacher-192.png', 'teacher-180.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match(req.url.includes('student') ? 'student.html' : 'teacher.html')))
  );
});
