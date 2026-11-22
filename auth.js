// Sisipkan di <head> setiap halaman yang butuh login.
// Kalau API balas 401 (belum login / sesi habis), otomatis pindah ke login.html.
(function () {
  const orig = window.fetch;
  window.fetch = async function (...args) {
    const res = await orig.apply(this, args);
    if (res.status === 401 && !location.pathname.endsWith('login.html')) {
      location.href = 'login.html';
    }
    return res;
  };
})();
