(function () {
  const root = document.getElementById('raw-editor');
  if (!root) return;

  const apiGet = root.dataset.apiGet;
  const apiPost = root.dataset.apiPost;
  const reloadTarget = root.dataset.reload || 'all';
  let original = '';

  root.innerHTML = `
    <div class="editor-message alert hidden"></div>
    <textarea id="raw-text" class="raw-text" spellcheck="false" wrap="off"></textarea>
    <div class="row-between" style="margin-top: 12px;">
      <span class="cfg-dirty" id="raw-dirty">Sem alterações</span>
      <div class="spawn-toolbar-group">
        <button type="button" class="button-link" id="raw-reset">Descartar alterações</button>
        <button type="button" id="raw-save">Salvar e recarregar</button>
      </div>
    </div>
  `;

  const textarea = root.querySelector('#raw-text');
  const messageEl = root.querySelector('.editor-message');
  const dirtyEl = root.querySelector('#raw-dirty');

  function setMessage(text, type) {
    if (!text) {
      messageEl.textContent = '';
      messageEl.classList.add('hidden');
      return;
    }
    messageEl.textContent = text;
    messageEl.classList.remove('hidden');
    messageEl.className = `editor-message alert ${type === 'error' ? '' : 'success'}`;
  }

  function updateDirty() {
    const dirty = textarea.value !== original;
    if (dirtyEl) {
      dirtyEl.textContent = dirty ? 'Alterações não salvas' : 'Sem alterações';
      dirtyEl.classList.toggle('dirty', dirty);
    }
  }

  async function load() {
    try {
      const res = await fetch(apiGet);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível carregar o arquivo.');
      original = data.content || '';
      textarea.value = original;
      updateDirty();
    } catch (err) {
      setMessage(err.message, 'error');
    }
  }

  textarea.addEventListener('input', updateDirty);

  root.querySelector('#raw-reset').addEventListener('click', function () {
    if (textarea.value === original) return;
    if (!confirm('Descartar as alterações não salvas?')) return;
    textarea.value = original;
    updateDirty();
    setMessage('Alterações descartadas.', 'success');
  });

  root.querySelector('#raw-save').addEventListener('click', async function () {
    if (textarea.value === original) {
      setMessage('Nada para salvar.', 'success');
      return;
    }
    setMessage('Salvando...', 'success');
    try {
      const res = await fetch(apiPost, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: textarea.value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível salvar.');

      original = textarea.value;
      updateDirty();

      const reload = await fetch('/admin/server-editor/api/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: reloadTarget })
      });
      if (!reload.ok) {
        setMessage('Salvo, mas não foi possível recarregar no servidor (pode exigir reinício).', 'error');
      } else {
        setMessage('Salvo e recarregado no servidor.', 'success');
      }
    } catch (err) {
      setMessage(err.message, 'error');
    }
  });

  load();
})();
