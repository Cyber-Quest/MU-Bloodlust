/*
 * mu-confirm.js - Componente de confirmacao estilizado (substitui o confirm() nativo)
 *
 * Uso em JavaScript:
 *     const ok = await muConfirm('Deseja continuar?');
 *     if (!ok) return;
 *     // ou com opcoes:
 *     await muConfirm('Apagar tudo?', { title: 'Atencao', okText: 'Apagar', danger: true });
 *
 * Uso em formularios (sem JavaScript inline):
 *     <form method="post" action="..." data-confirm="Mensagem?"
 *           data-confirm-title="Titulo" data-confirm-ok="Confirmar"
 *           data-confirm-danger="1">
 *
 * Uso em links:
 *     <a href="/x" data-confirm="Sair mesmo?">Sair</a>
 */
(function () {
  'use strict';

  if (typeof window.muConfirm === 'function') return;

  var STYLE_ID = 'mu-confirm-style';
  var OVERLAY_CLASS = 'mu-confirm-overlay';

  var CSS = [
    '.mu-confirm-overlay{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;',
    'justify-content:center;padding:20px;background:rgba(3,5,9,.72);-webkit-backdrop-filter:blur(3px);',
    'backdrop-filter:blur(3px);opacity:0;visibility:hidden;transition:opacity .18s ease,visibility .18s ease}',
    '.mu-confirm-overlay.is-open{opacity:1;visibility:visible}',
    '.mu-confirm-box{width:100%;max-width:430px;border:1px solid rgba(224,176,97,.45);border-radius:14px;',
    'background:linear-gradient(180deg,#161c27,#0a0e15);box-shadow:0 24px 60px rgba(0,0,0,.72);',
    'padding:22px 22px 18px;transform:translateY(10px) scale(.98);transition:transform .18s ease;',
    'color:#e9e4d8;font-family:inherit;text-align:left}',
    '.mu-confirm-overlay.is-open .mu-confirm-box{transform:translateY(0) scale(1)}',
    '.mu-confirm-title{margin:0 0 8px;font-size:1.05rem;font-weight:700;letter-spacing:.04em;color:#f0c667}',
    '.mu-confirm-message{margin:0 0 18px;font-size:.92rem;line-height:1.6;color:#cfc8ba;',
    'white-space:pre-line;word-break:break-word}',
    '.mu-confirm-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}',
    '.mu-confirm-btn{border:1px solid transparent;border-radius:8px;padding:9px 18px;font-size:.82rem;',
    'font-weight:600;letter-spacing:.04em;cursor:pointer;font-family:inherit;',
    'transition:filter .15s ease,background .15s ease}',
    '.mu-confirm-btn:focus-visible{outline:2px solid #f0c667;outline-offset:2px}',
    '.mu-confirm-btn--cancel{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.16);color:#d8d2c6}',
    '.mu-confirm-btn--cancel:hover{background:rgba(255,255,255,.12)}',
    '.mu-confirm-btn--ok{background:linear-gradient(180deg,#f0c667,#b9852f);',
    'border-color:rgba(255,236,190,.6);color:#1c1206}',
    '.mu-confirm-btn--ok:hover{filter:brightness(1.07)}',
    '.mu-confirm-btn--danger{background:linear-gradient(180deg,#e05a5a,#9c2f2f);',
    'border-color:rgba(255,160,160,.55);color:#fff}',
    '.mu-confirm-btn--danger:hover{filter:brightness(1.07)}',
    'body.mu-confirm-open{overflow:hidden}'
  ].join('');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.type = 'text/css';
    style.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(style);
  }

  var overlay = null;
  var titleEl = null;
  var msgEl = null;
  var okBtn = null;
  var cancelBtn = null;
  var resolver = null;
  var lastFocus = null;

  function ensureDom() {
    if (overlay) return;
    injectStyle();

    overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<div class="mu-confirm-box">' +
        '<h3 class="mu-confirm-title"></h3>' +
        '<p class="mu-confirm-message"></p>' +
        '<div class="mu-confirm-actions">' +
          '<button type="button" class="mu-confirm-btn mu-confirm-btn--cancel"></button>' +
          '<button type="button" class="mu-confirm-btn mu-confirm-btn--ok"></button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    titleEl = overlay.querySelector('.mu-confirm-title');
    msgEl = overlay.querySelector('.mu-confirm-message');
    okBtn = overlay.querySelector('.mu-confirm-btn--ok');
    cancelBtn = overlay.querySelector('.mu-confirm-btn--cancel');

    okBtn.addEventListener('click', function () { close(true); });
    cancelBtn.addEventListener('click', function () { close(false); });

    overlay.addEventListener('mousedown', function (event) {
      if (event.target === overlay) close(false);
    });

    document.addEventListener('keydown', function (event) {
      if (!isOpen()) return;
      if (event.key === 'Escape') { event.preventDefault(); close(false); }
      else if (event.key === 'Enter') { event.preventDefault(); close(true); }
    });
  }

  function isOpen() {
    return !!overlay && overlay.classList.contains('is-open');
  }

  function close(result) {
    if (!resolver) return;
    var resolve = resolver;
    resolver = null;
    if (overlay) overlay.classList.remove('is-open');
    document.body.classList.remove('mu-confirm-open');
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) { /* ignora */ }
    }
    resolve(result);
  }

  window.muConfirm = function (message, options) {
    options = options || {};
    return new Promise(function (resolve) {
      ensureDom();

      if (resolver) { var previous = resolver; resolver = null; previous(false); }

      lastFocus = document.activeElement;
      titleEl.textContent = options.title || 'Confirmação';
      msgEl.textContent = message == null ? '' : String(message);
      cancelBtn.textContent = options.cancelText || 'Cancelar';
      okBtn.textContent = options.okText || 'Confirmar';

      okBtn.classList.remove('mu-confirm-btn--danger');
      if (options.danger) okBtn.classList.add('mu-confirm-btn--danger');

      resolver = resolve;
      document.body.classList.add('mu-confirm-open');
      overlay.classList.add('is-open');
      setTimeout(function () { try { okBtn.focus(); } catch (e) { /* ignora */ } }, 30);
    });
  };

  function optionsFrom(el) {
    return {
      title: el.getAttribute('data-confirm-title') || 'Confirmação',
      okText: el.getAttribute('data-confirm-ok') || 'Confirmar',
      cancelText: el.getAttribute('data-confirm-cancel') || 'Cancelar',
      danger: el.getAttribute('data-confirm-danger') === '1'
    };
  }

  // Formularios: <form data-confirm="...">
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || typeof form.getAttribute !== 'function') return;

    if (form.dataset && form.dataset.muConfirmSkip === '1') {
      delete form.dataset.muConfirmSkip;
      return;
    }

    var message = form.getAttribute('data-confirm');
    if (!message) return;

    event.preventDefault();
    window.muConfirm(message, optionsFrom(form)).then(function (ok) {
      if (!ok) return;
      form.dataset.muConfirmSkip = '1';
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    });
  }, true);

  // Links: <a href="..." data-confirm="...">
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var link = target.closest('a[data-confirm]');
    if (!link) return;

    if (link.dataset && link.dataset.muConfirmSkip === '1') {
      delete link.dataset.muConfirmSkip;
      return;
    }

    var message = link.getAttribute('data-confirm');
    if (!message) return;

    event.preventDefault();
    window.muConfirm(message, optionsFrom(link)).then(function (ok) {
      if (!ok) return;
      link.dataset.muConfirmSkip = '1';
      if (typeof link.click === 'function') link.click();
    });
  }, true);
})();
