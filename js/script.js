/* ============================================
   AUTOSCAN AI — script.js
   Landing page: mobile nav, smooth scroll, scroll-fade animation
   ============================================ */

(function () {
  'use strict';

  /* ── MOBILE NAV ── */
  const hamburger = document.getElementById('hamburger');
  const mobileNav = document.getElementById('mobileNav');
  const mobileLinks = document.querySelectorAll('.mobile-link');

  function closeMobileNav() {
    mobileNav?.classList.remove('open');
    hamburger?.classList.remove('open');
    hamburger?.setAttribute('aria-expanded', 'false');
  }

  if (hamburger && mobileNav) {
    hamburger.addEventListener('click', () => {
      const isOpen = mobileNav.classList.toggle('open');
      hamburger.classList.toggle('open', isOpen);
      hamburger.setAttribute('aria-expanded', String(isOpen));
    });
    mobileLinks.forEach(link => link.addEventListener('click', closeMobileNav));
    document.addEventListener('click', (e) => {
      if (!mobileNav.contains(e.target) && !hamburger.contains(e.target)) closeMobileNav();
    });
  }

  /* ── SMOOTH SCROLL (in-page anchors only) ── */
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', (e) => {
      const href = anchor.getAttribute('href');
      if (href === '#') return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        closeMobileNav();
      }
    });
  });

  /* ── NAVBAR SCROLL SHADOW ── */
  const navbar = document.querySelector('nav');
  if (navbar) {
    window.addEventListener('scroll', () => {
      navbar.style.boxShadow = window.scrollY > 10
        ? '0 2px 20px rgba(20,24,31,0.06)'
        : 'none';
    }, { passive: true });
  }

  /* ── SCROLL FADE ANIMATION ── */
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });

  document.querySelectorAll('.fade-up').forEach((el, i) => {
    el.style.transitionDelay = (i % 5) * 0.07 + 's';
    observer.observe(el);
  });

})();
