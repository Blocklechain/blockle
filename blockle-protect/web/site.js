// Minimal, CSP-safe page chrome (no inline scripts anywhere on the site).
(function () {
  var bar = document.getElementById('bar');
  if (!bar) return;
  var on = function () { bar.classList.toggle('scrolled', window.scrollY > 6); };
  on();
  addEventListener('scroll', on, { passive: true });
})();
