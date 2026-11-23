/* Site-wide behaviour: mobile nav toggle, desktop dropdowns, footer year, scroll-reveal.
   Loaded by partial/footer.html on every page. It is an external file (not an inline
   <script>) so the Content-Security-Policy can forbid inline scripts entirely. */
const navToggle = document.getElementById('navToggle');
const siteNav = document.getElementById('siteNav');
navToggle.addEventListener('click', () => {
  const open = siteNav.classList.toggle('is-open');
  navToggle.setAttribute('aria-expanded', String(open));
});
siteNav.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    siteNav.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
});

const navGroups = document.querySelectorAll('.nav-group');
const desktopNav = () => window.matchMedia('(min-width: 1201px) and (hover: hover)').matches;
function setNavGroup(group, open) {
  group.classList.toggle('is-open', open);
  group.querySelector('.nav-group-toggle').setAttribute('aria-expanded', String(open));
}
navGroups.forEach(group => {
  const toggle = group.querySelector('.nav-group-toggle');
  toggle.addEventListener('click', () => {
    if (group.dataset.hover === '1') { group.dataset.hover = ''; return; }
    const open = !group.classList.contains('is-open');
    navGroups.forEach(other => setNavGroup(other, false));
    setNavGroup(group, open);
  });
  group.addEventListener('mouseenter', () => {
    if (!desktopNav()) return;
    navGroups.forEach(other => setNavGroup(other, false));
    group.dataset.hover = '1';
    setNavGroup(group, true);
  });
  group.addEventListener('mouseleave', () => {
    if (!desktopNav()) return;
    group.dataset.hover = '';
    setNavGroup(group, false);
  });
  group.addEventListener('focusout', e => {
    if (!group.contains(e.relatedTarget)) setNavGroup(group, false);
  });
});
document.addEventListener('click', e => {
  if (!e.target.closest('.nav-group')) navGroups.forEach(group => setNavGroup(group, false));
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') navGroups.forEach(group => setNavGroup(group, false));
});

document.getElementById('year').textContent = new Date().getFullYear();

// WeChat links can't add a contact from a browser (they only work when scanned in WeChat),
// so the footer WeChat icon opens a panel with Kevin's QR code and WeChat ID instead.
const wechatBtn = document.querySelector('.footer-wechat');
const wechatPanel = document.getElementById('wechatPanel');
if (wechatBtn && wechatPanel) {
  const copyBtn = wechatPanel.querySelector('.wechat-panel-copy');
  const setWechat = open => {
    wechatPanel.hidden = !open;
    wechatBtn.setAttribute('aria-expanded', String(open));
    if (!open) copyBtn.classList.remove('is-copied');
  };
  wechatBtn.addEventListener('click', () => setWechat(wechatPanel.hidden));
  wechatPanel.querySelector('.wechat-panel-close').addEventListener('click', () => {
    setWechat(false);
    wechatBtn.focus();
  });
  copyBtn.addEventListener('click', () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText('Kevin40338').then(() => copyBtn.classList.add('is-copied')).catch(() => {});
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !wechatPanel.hidden) setWechat(false); });
  document.addEventListener('click', e => {
    if (!wechatPanel.hidden && !wechatPanel.contains(e.target) && !wechatBtn.contains(e.target)) setWechat(false);
  });
}

const revealEls = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && revealEls.length) {
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0, rootMargin: '0px 0px -10% 0px' });
  revealEls.forEach(el => revealObserver.observe(el));
} else {
  revealEls.forEach(el => el.classList.add('is-visible'));
}
