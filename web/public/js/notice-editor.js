(function () {
  const root = document.getElementById('notice-editor');
  if (!root) return;

  const HEADER = `//=============================================================================================================================================\n// Message:\n//\tMax 128 Characters (Spaces include)\n// Type:\n//\t0 -> Global Gold Center\n//\t1 -> Global Green Center\n// Repeat Time:\n//\tIn seconds\n//=============================================================================================================================================\n\n//Message\t\t\t\t\tType\tRepeatTime`;

  const state = {
    notices: [],
    selected: null,
    filter: ''
  };

  function setMessage(text, type) {
    const box = root.querySelector('.editor-message');
    if (!box) return;
    if (!text) {
      box.textContent = '';
      box.classList.add('hidden');
      return;
    }
    box.textContent = text;
    box.classList.remove('hidden');
    box.classList.toggle('success', type === 'success');
    box.classList.toggle('error', type === 'error');
  }

  function parseNotice(content) {
    const lines = String(content || '').split(/\r?\n/);
    const notices = [];
    for (const rawLine of lines) {
      const line = rawLine.split('//')[0].trim();
      if (!line) continue;
      if (line.toLowerCase() === 'end') break;
      const match = line.match(/"([^"]+)"\s+(\d+)\s+(\d+)/);
      if (!match) continue;
      notices.push({
        message: match[1],
        type: Number(match[2]),
        repeat: Number(match[3])
      });
    }
    return notices;
  }

  function buildNotice() {
    const lines = [];
    lines.push(HEADER);
    const notices = state.notices.slice();
    for (const notice of notices) {
      const msg = String(notice.message || '').replace(/"/g, '').trim();
      lines.push(`"${msg}"\t\t\t\t${notice.type}\t${notice.repeat}`);
    }
    lines.push('end');
    return lines.join('\n');
  }

  function buildLayout() {
    root.innerHTML = `
      <div class="editor-message alert hidden"></div>
      <div class="spawn-toolbar">
        <div class="spawn-toolbar-group">
          <label>Buscar</label>
          <input type="text" id="notice-search" placeholder="Buscar mensagem..." />
        </div>
        <div class="spawn-toolbar-group">
          <button type="button" id="add-notice">Adicionar notice</button>
          <button type="button" id="save-notice">Salvar</button>
        </div>
      </div>
      <div class="spawn-editor">
        <div class="spawn-list">
          <h3>Notices</h3>
          <ul id="notice-list" class="simple-list"></ul>
        </div>
        <div class="spawn-form">
          <h3>Detalhe</h3>
          <label>Mensagem</label>
          <input type="text" id="notice-message" maxlength="128" />
          <label>Tipo</label>
          <select id="notice-type">
            <option value="0">0 - Global Gold Center</option>
            <option value="1">1 - Global Green Center</option>
          </select>
          <label>Repeat (seg)</label>
          <input type="number" id="notice-repeat" min="5" />
          <div class="spawn-actions">
            <button type="button" id="update-notice">Atualizar</button>
            <button type="button" id="delete-notice" class="link-button">Excluir</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderList() {
    const list = root.querySelector('#notice-list');
    if (!list) return;
    list.innerHTML = '';
    const filter = state.filter.toLowerCase();
    state.notices.forEach((notice, index) => {
      const label = `${notice.message} (Tipo ${notice.type}, ${notice.repeat}s)`;
      if (filter && !label.toLowerCase().includes(filter)) return;
      const item = document.createElement('li');
      item.textContent = label;
      item.dataset.index = String(index);
      if (state.selected && state.selected.index === index) {
        item.classList.add('selected');
      }
      list.appendChild(item);
    });
  }

  function selectNotice(notice, index) {
    state.selected = notice ? { ...notice, index } : null;
    if (!notice) {
      renderList();
      return;
    }
    root.querySelector('#notice-message').value = notice.message;
    root.querySelector('#notice-type').value = notice.type;
    root.querySelector('#notice-repeat').value = notice.repeat;
    renderList();
  }

  function bindEvents() {
    root.querySelector('#notice-search').addEventListener('input', (event) => {
      state.filter = event.target.value || '';
      renderList();
    });

    root.querySelector('#notice-list').addEventListener('click', (event) => {
      const item = event.target.closest('li');
      if (!item) return;
      const index = Number(item.dataset.index);
      const notice = state.notices[index];
      if (notice) selectNotice(notice, index);
    });

    root.querySelector('#add-notice').addEventListener('click', () => {
      const notice = {
        message: 'Novo notice',
        type: 0,
        repeat: 600
      };
      state.notices.push(notice);
      selectNotice(notice, state.notices.length - 1);
      setMessage('Notice adicionado.', 'success');
    });

    root.querySelector('#update-notice').addEventListener('click', () => {
      if (!state.selected) return;
      const index = state.selected.index;
      state.notices[index] = {
        message: String(root.querySelector('#notice-message').value || '').trim(),
        type: Number(root.querySelector('#notice-type').value),
        repeat: Number(root.querySelector('#notice-repeat').value)
      };
      selectNotice(state.notices[index], index);
      setMessage('Notice atualizado.', 'success');
    });

    root.querySelector('#delete-notice').addEventListener('click', () => {
      if (!state.selected) return;
      state.notices.splice(state.selected.index, 1);
      state.selected = null;
      renderList();
      setMessage('Notice excluído.', 'success');
    });

    root.querySelector('#save-notice').addEventListener('click', async () => {
      try {
        const content = buildNotice();
        const res = await fetch('/admin/server-editor/api/notices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Não foi possível salvar');
        const reload = await fetch('/admin/server-editor/api/reload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'util' })
        });
        if (!reload.ok) {
          setMessage('Salvo, mas não foi possível recarregar no servidor.', 'error');
        } else {
          setMessage('Salvo e recarregado no servidor.', 'success');
        }
      } catch (err) {
        setMessage(err.message, 'error');
      }
    });
  }

  async function loadInitialData() {
    const res = await fetch('/admin/server-editor/api/notices');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Não foi possível carregar');
    state.notices = parseNotice(data.content || '');
  }

  async function init() {
    buildLayout();
    bindEvents();
    try {
      await loadInitialData();
      renderList();
      if (state.notices[0]) selectNotice(state.notices[0], 0);
    } catch (err) {
      setMessage(err.message, 'error');
    }
  }

  init();
})();
