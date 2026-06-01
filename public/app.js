const state = {
  user: null,
  templates: [],
  selectedTemplateId: null,
  activeDeck: null,
  recentDecks: [],
  currentPage: 1,
  totalPages: 1,
  annotate: false,
  isGenerating: false,
  isEditing: false,
  pendingAnnotation: null,
  errors: []
};

const $ = (selector) => document.querySelector(selector);

function clientLog(level, message, meta = {}) {
  fetch('/api/logs', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message, meta })
  }).catch((error) => console.warn('Could not send client log', error));
}

function renderErrors() {
  const panel = $('#errorPanel');
  const list = $('#errorList');
  if (!panel || !list) return;
  panel.classList.toggle('hidden', state.errors.length === 0);
  list.innerHTML = state.errors.map((item) => `
    <div class="error-item">
      <strong>${item.message}</strong>
      <small>${item.context} · ${item.time}</small>
    </div>
  `).join('');
}

function reportIssue(message, context = 'App', meta = {}) {
  const item = {
    message: String(message || 'Something went wrong.'),
    context,
    time: new Date().toLocaleTimeString()
  };
  state.errors.unshift(item);
  state.errors = state.errors.slice(0, 5);
  renderErrors();
  toast(item.message);
  clientLog('error', item.message, { context, ...meta });
}

function toast(message) {
  const node = $('#toast');
  if (!node) {
    console.warn(message);
    return;
  }
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add('hidden'), 3600);
}

async function api(path, options = {}) {
  try {
    const response = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (error) {
      data = { error: text || response.statusText };
    }
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.data = data;
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error instanceof TypeError && /Failed to fetch/i.test(error.message || '')) {
      error.message = 'Local server is not reachable. Start it with npm run dev, then reload this page.';
      error.code = 'LOCAL_SERVER_UNREACHABLE';
    }
    if (path !== '/api/logs') clientLog('error', `API failed: ${path}`, { message: error.message });
    throw error;
  }
}

function show(view) {
  ['authView', 'homeView', 'workspaceView'].forEach((id) => {
    document.getElementById(id).classList.toggle('hidden', id !== view);
  });
}

function setUser(user) {
  state.user = user;
  if (!user) {
    state.recentDecks = [];
    state.activeDeck = null;
    renderDeckList();
    show('authView');
    return;
  }
  $('#accountName').textContent = user.name;
  $('#userButton').textContent = user.name.slice(0, 1).toUpperCase();
  $('#providerInput').value = user.modelConfig?.provider || 'OpenAI';
  $('#baseUrlInput').value = user.modelConfig?.baseUrl || 'https://api.openai.com/v1';
  $('#modelInput').value = user.modelConfig?.model || 'gpt-4.1';
  $('#outputInput').value = user.modelConfig?.output || 'Frontend (HTML)';
  $('#modelHint').textContent = user.modelConfig?.hasApiKey
    ? `API key saved (${user.modelConfig.apiKeyHint}).`
    : 'For Qwen, use DashScope compatible mode base URL and a qwen model name.';
  show('homeView');
  loadDecks();
}

function setRailActive(action) {
  document.querySelectorAll('.rail-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.railAction === action);
  });
}

function cacheBust(path, updatedAt = '') {
  if (!path || path === 'about:blank') return path || 'about:blank';
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}v=${encodeURIComponent(updatedAt || Date.now())}`;
}

function renderDeckList() {
  const lists = [$('#deckList'), $('#homeDeckList')].filter(Boolean);
  if (!lists.length) return;
  if (!state.recentDecks.length) {
    lists.forEach((list) => {
      list.innerHTML = '<div class="deck-empty">Generated decks will appear here.</div>';
    });
    return;
  }
  const html = state.recentDecks.map((deck) => `
    <button class="deck-list-item ${state.activeDeck?.id === deck.id ? 'active' : ''}" data-deck-id="${deck.id}">
      <strong>${deck.title || 'Untitled deck'}</strong>
      <span>${deck.status || 'draft'} · ${new Date(deck.updatedAt || deck.createdAt).toLocaleString()}</span>
    </button>
  `).join('');
  lists.forEach((list) => {
    list.innerHTML = html;
    list.querySelectorAll('.deck-list-item').forEach((item) => {
      item.addEventListener('click', () => openDeckById(item.dataset.deckId));
    });
  });
}

async function loadDecks() {
  if (!state.user) return;
  try {
    const { decks } = await api('/api/decks');
    state.recentDecks = decks;
    renderDeckList();
  } catch (error) {
    reportIssue(error.message || 'Could not load deck history.', 'Deck history');
  }
}

function renderTemplates(category = 'All templates') {
  const grid = $('#templateGrid');
  const visible = category === 'All templates'
    ? state.templates
    : state.templates.filter((template) => template.category === category);
  if (!visible.length) {
    grid.innerHTML = '<div class="empty-state">No templates in this category yet.</div>';
    return;
  }
  grid.innerHTML = visible.map((template) => `
    <button class="template-card ${state.selectedTemplateId === template.id ? 'selected' : ''}" data-template="${template.id}">
      <div class="template-thumb" style="--template-accent:${template.accent}">
        <div class="template-preview-grid">
          <span class="mini-slide mini-slide-primary">
            <i></i><b></b><em></em>
          </span>
          <span class="mini-slide mini-slide-data">
            <i></i><i></i><i></i><i></i>
          </span>
          <span class="mini-slide mini-slide-text">
            <b></b><em></em><em></em>
          </span>
        </div>
        <span class="use-badge">Use</span>
      </div>
      <div class="template-body">
        <div>
          <div class="template-name">${template.name}</div>
          <div class="template-category">${template.category}</div>
        </div>
        <div class="template-meta"><span class="template-tag">HTML Slides</span><span>${template.uses.toLocaleString()} uses</span></div>
      </div>
    </button>
  `).join('');

  grid.querySelectorAll('.template-card').forEach((card) => {
    card.addEventListener('click', () => selectTemplate(card.dataset.template));
  });
}

function selectTemplate(id) {
  state.selectedTemplateId = id;
  const template = state.templates.find((item) => item.id === id);
  if (!template) {
    toast('Template not found. Try another template.');
    return;
  }
  $('#selectedTemplate').innerHTML = `
    <span class="selected-dot" style="--template-accent:${template.accent}"></span>
    <span>Selected template</span>
    <strong>${template.name}</strong>
  `;
  $('#generateBtn').classList.add('ready');
  renderTemplates($('#templateTabs button.active')?.dataset.category || 'All templates');
  document.querySelector('.composer').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast(`${template.name} selected. Add a prompt, then generate.`);
}

function setGenerateState(active) {
  state.isGenerating = active;
  $('#generateBtn').disabled = active;
  $('#generateBtn').textContent = active ? '...' : '↑';
  $('#generateBtn').title = active ? 'Generating real HTML deck' : 'Generate';
  $('#generateBtn').setAttribute('aria-busy', String(active));
  if (active) {
    $('#retryGenerateBtn').classList.add('hidden');
    $('#generationStatus').classList.remove('hidden');
    $('#generationStatus').classList.remove('failed');
    $('#generationStatusTitle').textContent = 'Generating real HTML slides';
    $('#generationStatusDetail').textContent = 'Reading template rules, calling your API, then saving a preview file.';
  }
}

function setGenerationFailure(message, deck = null) {
  $('#generationStatus').classList.remove('hidden');
  $('#generationStatus').classList.add('failed');
  $('#generationStatusTitle').textContent = 'Generation failed';
  $('#generationStatusDetail').textContent = message || 'Check your API settings and retry.';
  $('#retryGenerateBtn').classList.toggle('hidden', !deck?.id);
  $('#retryGenerateBtn').dataset.deckId = deck?.id || '';
}

function addMessage(role, text) {
  const node = document.createElement('div');
  node.className = `message ${role}`;
  node.textContent = text;
  $('#chatLog').appendChild(node);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}

function renderMessages(deck) {
  $('#chatLog').innerHTML = '';
  const messages = deck.messages?.length
    ? deck.messages
    : [
        { role: 'user', text: deck.prompt },
        { role: 'assistant', text: `Ready to edit ${deck.title || 'this deck'}.` }
      ];
  messages.forEach((message) => addMessage(message.role, message.text));
}

function setChatBusy(active) {
  state.isEditing = active;
  $('#sendChatBtn').disabled = active;
  $('#editCurrentBtn').disabled = active;
  $('#undoBtn').disabled = active;
  $('#regenerateBtn').disabled = active;
  $('#exportBtn').disabled = active;
  $('#exportPdfBtn').disabled = active;
  $('#chatInput').disabled = active;
  $('#sendChatBtn').textContent = active ? 'Editing...' : 'Send';
  $('#editOverlay').classList.toggle('hidden', !active);
  $('#editOverlayTitle').textContent = active ? 'Applying edit and refreshing preview' : '';
}

function renderAnnotations(deck = state.activeDeck) {
  const panel = $('#annotationPanel');
  const list = $('#annotationList');
  if (!panel || !list) return;
  const comments = deck?.comments || [];
  panel.classList.toggle('hidden', !comments.length && !state.annotate);
  if (!comments.length) {
    list.innerHTML = '<div class="annotation-empty">Click the preview while Annotate is on.</div>';
    return;
  }
  list.innerHTML = comments.map((comment, index) => `
    <article class="annotation-item ${comment.status === 'resolved' ? 'resolved' : ''}">
      <div class="annotation-item-head">
        <strong>#${index + 1} · Slide ${comment.page || 1}</strong>
        <span>${comment.status || 'open'}</span>
      </div>
      <p>${comment.note}</p>
      ${comment.elementText ? `<small>${comment.elementTag || 'element'} · ${comment.elementText.slice(0, 90)}</small>` : ''}
      <div class="annotation-actions">
        <button type="button" data-apply-annotation="${comment.id}" ${comment.status === 'resolved' ? 'disabled' : ''}>Apply</button>
      </div>
    </article>
  `).join('');
  list.querySelectorAll('[data-apply-annotation]').forEach((button) => {
    button.addEventListener('click', () => applyAnnotation(button.dataset.applyAnnotation));
  });
}

function updatePageIndicator(page = state.currentPage, total = state.totalPages) {
  state.currentPage = Math.max(1, Number(page) || 1);
  state.totalPages = Math.max(1, Number(total) || 1);
  $('#pageIndicator').textContent = `Slide ${state.currentPage} / ${state.totalPages}`;
  const fullscreenIndicator = $('#fullscreenPageIndicator');
  if (fullscreenIndicator) fullscreenIndicator.textContent = `${state.currentPage} / ${state.totalPages}`;
}

async function generateDeck() {
  if (state.isGenerating) return;
  const userPrompt = $('#promptInput').value.trim();
  if (!userPrompt) {
    $('#promptInput').focus();
    toast('先输入你想做什么 slides，例如：做一个 10 页 AI 创作工具产品发布会。');
    return;
  }
  if (!state.selectedTemplateId && state.templates[0]) {
    selectTemplate(state.templates[0].id);
  }
  setGenerateState(true);
  toast('Generating real HTML slides...');
  try {
    const { deck } = await api('/api/generate', {
      method: 'POST',
      body: { prompt: userPrompt, templateId: state.selectedTemplateId }
    });
    $('#generationStatus').classList.add('hidden');
    openWorkspace(deck);
    await loadDecks();
  } catch (error) {
    const failedDeck = error.data?.deck || null;
    setGenerationFailure(error.message || 'Generate failed. Please try again.', failedDeck);
    reportIssue(error.message || 'Generate failed. Please try again.', 'Generate', { templateId: state.selectedTemplateId, deckId: failedDeck?.id });
  } finally {
    setGenerateState(false);
  }
}

async function retryGeneration(deckId) {
  if (!deckId || state.isGenerating) return;
  setGenerateState(true);
  toast('Retrying generation...');
  try {
    const { deck } = await api(`/api/generate/${deckId}/retry`, { method: 'POST' });
    $('#generationStatus').classList.add('hidden');
    openWorkspace(deck);
    await loadDecks();
  } catch (error) {
    const failedDeck = error.data?.deck || { id: deckId };
    setGenerationFailure(error.message || 'Retry failed.', failedDeck);
    reportIssue(error.message || 'Retry failed.', 'Generate retry', { deckId });
  } finally {
    setGenerateState(false);
  }
}

function openWorkspace(deck) {
  state.activeDeck = deck;
  const template = state.templates.find((item) => item.id === deck.templateId);
  $('#deckTitle').textContent = deck.title;
  $('#deckMeta').textContent = `${template?.name || 'Template'} · ${deck.status || 'complete'} · HTML Slides`;
  $('#slideFrame').src = cacheBust(deck.deckPath, deck.updatedAt);
  renderMessages(deck);
  renderAnnotations(deck);
  renderDeckList();
  updatePageIndicator(deck.currentPage || 1, 1);
  clientLog('info', 'Workspace opened', { deckId: deck.id, templateId: deck.templateId });
  show('workspaceView');
}

async function openDeckById(deckId) {
  try {
    const { deck } = await api(`/api/decks/${deckId}`);
    openWorkspace(deck);
  } catch (error) {
    reportIssue(error.message || 'Could not open deck.', 'Deck history', { deckId });
  }
}

function syncPreviewPage() {
  const frame = $('#slideFrame');
  if (!frame?.contentDocument) return;
  syncFramePage(frame);
}

function syncFramePage(frame) {
  try {
    const slides = [...frame.contentDocument.querySelectorAll('.slide')];
    const activeIndex = slides.findIndex((slide) => slide.classList.contains('active') || slide.classList.contains('visible'));
    updatePageIndicator(activeIndex >= 0 ? activeIndex + 1 : 1, slides.length || 1);
  } catch (error) {
    updatePageIndicator(1, 1);
  }
}

function showFrameSlide(frame, page) {
  if (!frame?.contentDocument) return;
  try {
    const doc = frame.contentDocument;
    const slides = [...doc.querySelectorAll('.slide')];
    if (!slides.length) return;
    const targetIndex = Math.max(0, Math.min(slides.length - 1, (Number(page) || 1) - 1));
    slides.forEach((slide, index) => {
      const active = index === targetIndex;
      slide.classList.toggle('active', active);
      slide.classList.toggle('visible', active);
    });
    const counter = doc.querySelector('#slideCounter, .slide-counter, [data-slide-counter]');
    if (counter) counter.textContent = `${targetIndex + 1} / ${slides.length}`;
    const progress = doc.querySelector('#progressBar, .progress-bar, [data-progress-bar]');
    if (progress) progress.style.width = `${((targetIndex + 1) / slides.length) * 100}%`;
    updatePageIndicator(targetIndex + 1, slides.length);
  } catch (error) {
    reportIssue('Could not control the slide frame.', 'Presentation controls', { message: error.message });
  }
}

function moveFrameSlide(frame, delta) {
  if (!frame?.contentDocument) return;
  const slides = [...frame.contentDocument.querySelectorAll('.slide')];
  const activeIndex = slides.findIndex((slide) => slide.classList.contains('active') || slide.classList.contains('visible'));
  const current = activeIndex >= 0 ? activeIndex + 1 : state.currentPage;
  showFrameSlide(frame, current + delta);
}

function openDownload(url) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function activeElementIsTyping() {
  const element = document.activeElement;
  if (!element) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
}

async function openFullscreenPresentation() {
  if (!state.activeDeck) return;
  const view = $('#fullscreenView');
  const frame = $('#fullscreenFrame');
  frame.src = cacheBust(state.activeDeck.deckPath, state.activeDeck.updatedAt);
  view.classList.remove('hidden');
  $('#fullscreenChatInput').value = '';
  try {
    if (view.requestFullscreen && !document.fullscreenElement) await view.requestFullscreen();
  } catch (error) {
    clientLog('error', 'Browser fullscreen request was blocked', { message: error.message });
  }
  toast('Full screen presentation opened.');
}

async function closeFullscreenPresentation() {
  $('#fullscreenView').classList.add('hidden');
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch (error) {
      clientLog('error', 'Could not exit browser fullscreen', { message: error.message });
    }
  }
}

function selectorForElement(element) {
  if (!element || element.nodeType !== 1) return '';
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts = [];
  let node = element;
  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html' && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    if (node.classList.length) part += `.${[...node.classList].slice(0, 2).map((name) => CSS.escape(name)).join('.')}`;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function getAnnotationTarget(event) {
  const frame = $('#slideFrame');
  try {
    const frameRect = frame.getBoundingClientRect();
    const frameDoc = frame.contentDocument;
    const frameWindow = frame.contentWindow;
    const scaleX = frameWindow.innerWidth / frameRect.width;
    const scaleY = frameWindow.innerHeight / frameRect.height;
    const frameX = (event.clientX - frameRect.left) * scaleX;
    const frameY = (event.clientY - frameRect.top) * scaleY;
    const element = frameDoc.elementFromPoint(frameX, frameY);
    if (!element) return {};
    const rect = element.getBoundingClientRect();
    return {
      selector: selectorForElement(element),
      elementText: (element.innerText || element.textContent || '').trim().slice(0, 300),
      elementTag: element.tagName.toLowerCase(),
      elementRect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  } catch (error) {
    return {};
  }
}

async function submitDeckEdit(text) {
  if (!state.activeDeck || state.isEditing) return;
  const instruction = text.trim();
  if (!instruction) return;
  $('#chatInput').value = '';
  addMessage('user', instruction);
  addMessage('assistant', 'Working on it. I am editing the HTML and will refresh the preview when it is done.');
  setChatBusy(true);
  try {
    const { deck } = await api(`/api/decks/${state.activeDeck.id}/messages`, {
      method: 'POST',
      body: { text: instruction, currentPage: state.currentPage }
    });
    state.activeDeck = deck;
    $('#deckMeta').textContent = `${state.templates.find((item) => item.id === deck.templateId)?.name || 'Template'} · ${deck.status || 'complete'} · HTML Slides`;
    renderMessages(deck);
    $('#slideFrame').src = cacheBust(deck.deckPath, deck.updatedAt);
    await loadDecks();
    toast('Preview refreshed with the latest edit.');
  } catch (error) {
    const deck = error.data?.deck;
    if (deck) {
      state.activeDeck = deck;
      renderMessages(deck);
      renderAnnotations(deck);
    } else {
      addMessage('assistant', `Edit failed: ${error.message}`);
    }
    reportIssue(error.message || 'Could not edit this deck.', 'Chat edit', { deckId: state.activeDeck?.id });
  } finally {
    setChatBusy(false);
  }
}

function toggleAnnotate() {
  state.annotate = !state.annotate;
  $('#annotationLayer').classList.toggle('hidden', !state.annotate);
  $('#annotateBtn').classList.toggle('active', state.annotate);
}

async function addAnnotation(event) {
  if (!state.activeDeck) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = Math.round(event.clientX - rect.left);
  const y = Math.round(event.clientY - rect.top);
  const target = getAnnotationTarget(event);
  const note = prompt('Annotate this spot');
  if (!note) return;

  const pin = document.createElement('div');
  pin.className = 'annotation-pin';
  pin.style.left = `${x}px`;
  pin.style.top = `${y}px`;
  pin.textContent = '1';
  $('#annotationLayer').appendChild(pin);

  try {
    const { deck } = await api('/api/comment', {
      method: 'POST',
      body: { deckId: state.activeDeck.id, page: state.currentPage, note, x, y, ...target }
    });
    state.activeDeck = deck;
    renderMessages(deck);
    renderAnnotations(deck);
    toast('Annotation saved. Applying it now...');
    const created = (deck.comments || []).find((comment) => comment.x === x && comment.y === y && comment.note === note && comment.status !== 'resolved');
    if (created) applyAnnotation(created.id);
  } catch (error) {
    reportIssue(error.message || 'Could not save annotation.', 'Annotate', { deckId: state.activeDeck.id });
  }
}

async function applyAnnotation(commentId) {
  if (!state.activeDeck || state.isEditing) return;
  const comment = (state.activeDeck.comments || []).find((item) => item.id === commentId);
  if (!comment) return;
  setChatBusy(true);
  addMessage('user', `Apply annotation on slide ${comment.page}: ${comment.note}`);
  addMessage('assistant', 'Working on the annotated area. I will refresh the preview when it is done.');
  try {
    const { deck } = await api(`/api/decks/${state.activeDeck.id}/comments/${commentId}/apply`, {
      method: 'POST',
      body: { text: comment.note }
    });
    state.activeDeck = deck;
    renderMessages(deck);
    renderAnnotations(deck);
    $('#slideFrame').src = cacheBust(deck.deckPath, deck.updatedAt);
    await loadDecks();
    toast('Annotation applied and marked resolved.');
  } catch (error) {
    const deck = error.data?.deck;
    if (deck) {
      state.activeDeck = deck;
      renderMessages(deck);
      renderAnnotations(deck);
    }
    reportIssue(error.message || 'Could not apply annotation.', 'Annotation apply', { deckId: state.activeDeck?.id, commentId });
  } finally {
    setChatBusy(false);
  }
}

async function undoDeck() {
  if (!state.activeDeck || state.isEditing) return;
  setChatBusy(true);
  try {
    const { deck } = await api(`/api/decks/${state.activeDeck.id}/undo`, { method: 'POST' });
    state.activeDeck = deck;
    renderMessages(deck);
    renderAnnotations(deck);
    $('#slideFrame').src = cacheBust(deck.deckPath, deck.updatedAt);
    await loadDecks();
    toast('Undone. Preview restored to the previous version.');
  } catch (error) {
    reportIssue(error.message || 'No previous version available.', 'Undo', { deckId: state.activeDeck?.id });
  } finally {
    setChatBusy(false);
  }
}

async function init() {
  $('#clearErrorsBtn').addEventListener('click', () => {
    state.errors = [];
    renderErrors();
  });

  $('#authForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#authError').textContent = '';
    try {
      const { user } = await api('/api/login', {
        method: 'POST',
        body: { email: $('#emailInput').value, password: $('#passwordInput').value }
      });
      setUser(user);
    } catch (error) {
      $('#authError').textContent = error.message;
      reportIssue(error.message, 'Login');
    }
  });

  $('#signupBtn').addEventListener('click', async () => {
    $('#authError').textContent = '';
    try {
      const { user } = await api('/api/signup', {
        method: 'POST',
        body: { name: $('#nameInput').value, email: $('#emailInput').value, password: $('#passwordInput').value }
      });
      setUser(user);
    } catch (error) {
      $('#authError').textContent = error.message;
      reportIssue(error.message, 'Signup');
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
      setUser(null);
      toast('Logged out.');
    } catch (error) {
      reportIssue(error.message || 'Logout failed.', 'Logout');
    }
  });

  $('#modelBtn').addEventListener('click', () => $('#modelDialog').showModal());
  $('#userButton').addEventListener('click', () => {
    if (state.user) {
      $('#modelDialog').showModal();
    } else {
      show('authView');
    }
  });
  $('#closeModelBtn').addEventListener('click', () => $('#modelDialog').close());
  $('#modelForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const { user } = await api('/api/model-config', {
        method: 'POST',
        body: {
          provider: $('#providerInput').value,
          baseUrl: $('#baseUrlInput').value,
          model: $('#modelInput').value,
          apiKey: $('#apiKeyInput').value,
          output: $('#outputInput').value
        }
      });
      setUser(user);
      $('#modelDialog').close();
      toast('Model settings saved.');
    } catch (error) {
      reportIssue(error.message || 'Could not save model settings.', 'Model settings');
    }
  });

  document.querySelectorAll('.rail-button').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.railAction;
      setRailActive(action);
      if (action === 'home') {
        show(state.user ? 'homeView' : 'authView');
        return;
      }
      if (action === 'templates') {
        show(state.user ? 'homeView' : 'authView');
        document.querySelector('.templates-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('Template library is visible below.');
        return;
      }
      if (action === 'settings') {
        if (state.user) $('#modelDialog').showModal();
        else toast('Log in to edit model settings.');
        return;
      }
      if (action === 'history') {
        if (state.recentDecks[0]) openDeckById(state.recentDecks[0].id);
        else toast('No generated decks yet.');
        return;
      }
      toast('This section is queued for the next milestone.');
    });
  });

  $('#templateTabs').addEventListener('click', (event) => {
    if (!event.target.matches('button')) return;
    $('#templateTabs button.active').classList.remove('active');
    event.target.classList.add('active');
    renderTemplates(event.target.dataset.category);
  });

  document.querySelectorAll('.quick-card').forEach((card) => {
    card.addEventListener('click', () => {
      $('#promptInput').value = card.dataset.fill;
      $('#generateBtn').classList.add('ready');
      $('#promptInput').focus();
      toast('Prompt added. Choose a template or click generate.');
    });
  });

  $('#blankDeckBtn').addEventListener('click', () => {
    $('#promptInput').value = 'Create a clean blank HTML slide deck for a product strategy presentation.';
    $('#generateBtn').classList.add('ready');
    toast('Blank deck prompt added.');
    $('#promptInput').focus();
  });

  $('#retryGenerateBtn').addEventListener('click', () => {
    retryGeneration($('#retryGenerateBtn').dataset.deckId);
  });

  document.querySelectorAll('.mode-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.mode-chip').forEach((item) => item.classList.remove('active'));
      chip.classList.add('active');
      toast(`${chip.textContent.trim()} mode selected.`);
    });
  });

  document.querySelectorAll('.composer-tools .icon-btn').forEach((button) => {
    button.addEventListener('click', () => {
      toast(`${button.title || 'Tool'} is queued for the next milestone.`);
    });
  });

  $('#generateBtn').addEventListener('click', generateDeck);
  $('#promptInput').addEventListener('input', () => {
    $('#generateBtn').classList.toggle('ready', Boolean($('#promptInput').value.trim()));
  });
  $('#backHomeBtn').addEventListener('click', () => {
    setRailActive('home');
    show('homeView');
    loadDecks();
  });
  $('#annotateBtn').addEventListener('click', () => {
    toggleAnnotate();
    renderAnnotations();
    toast(state.annotate ? 'Annotate mode on. Click the preview to add a note.' : 'Annotate mode off.');
  });
  $('#annotationLayer').addEventListener('click', addAnnotation);
  $('#slideFrame').addEventListener('load', () => {
    syncPreviewPage();
    clearInterval(syncPreviewPage.timer);
    syncPreviewPage.timer = setInterval(syncPreviewPage, 800);
  });
  $('#fullscreenFrame').addEventListener('load', () => {
    showFrameSlide($('#fullscreenFrame'), state.currentPage);
    clearInterval(syncFramePage.fullscreenTimer);
    syncFramePage.fullscreenTimer = setInterval(() => {
      if (!$('#fullscreenView').classList.contains('hidden')) syncFramePage($('#fullscreenFrame'));
    }, 500);
  });
  $('#refreshDecksBtn').addEventListener('click', loadDecks);
  $('#refreshHomeDecksBtn').addEventListener('click', loadDecks);
  $('#regenerateBtn').addEventListener('click', () => {
    if (!state.activeDeck) return;
    retryGeneration(state.activeDeck.id);
  });
  $('#undoBtn').addEventListener('click', undoDeck);
  $('#closeAnnotationPanelBtn').addEventListener('click', () => {
    state.annotate = false;
    $('#annotationLayer').classList.add('hidden');
    $('#annotateBtn').classList.remove('active');
    $('#annotationPanel').classList.add('hidden');
  });
  $('#editCurrentBtn').addEventListener('click', () => {
    $('#chatInput').value = `On slide ${state.currentPage}, `;
    $('#chatInput').focus();
  });
  $('#expandBtn').addEventListener('click', openFullscreenPresentation);
  $('#closeFullscreenBtn').addEventListener('click', closeFullscreenPresentation);
  $('#fullscreenPrevBtn').addEventListener('click', () => moveFrameSlide($('#fullscreenFrame'), -1));
  $('#fullscreenNextBtn').addEventListener('click', () => moveFrameSlide($('#fullscreenFrame'), 1));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) $('#fullscreenView').classList.add('hidden');
  });
  document.addEventListener('keydown', (event) => {
    if ($('#fullscreenView').classList.contains('hidden') || activeElementIsTyping()) return;
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
      event.preventDefault();
      moveFrameSlide($('#fullscreenFrame'), 1);
    }
    if (['ArrowLeft', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      moveFrameSlide($('#fullscreenFrame'), -1);
    }
    if (event.key === 'Home') {
      event.preventDefault();
      showFrameSlide($('#fullscreenFrame'), 1);
    }
    if (event.key === 'End') {
      event.preventDefault();
      showFrameSlide($('#fullscreenFrame'), state.totalPages);
    }
    if (event.key === 'Escape') closeFullscreenPresentation();
  });

  $('#exportBtn').addEventListener('click', () => {
    if (!state.activeDeck) {
      toast('Generate a deck before exporting.');
      return;
    }
    openDownload(`/api/decks/${state.activeDeck.id}/download/html`);
    toast('Downloading HTML deck.');
  });

  $('#exportPdfBtn').addEventListener('click', () => {
    if (!state.activeDeck) {
      toast('Generate a deck before exporting.');
      return;
    }
    openDownload(`/api/decks/${state.activeDeck.id}/export/pdf`);
    toast('Preparing PDF export.');
  });

  $('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    submitDeckEdit(text);
    clientLog('info', 'Workspace chat submitted', { deckId: state.activeDeck?.id });
  });

  $('#fullscreenChatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('#fullscreenChatInput').value.trim();
    if (!text) return;
    $('#fullscreenChatInput').value = '';
    closeFullscreenPresentation();
    show('workspaceView');
    submitDeckEdit(text);
    clientLog('info', 'Fullscreen chat submitted', { deckId: state.activeDeck?.id });
  });

  const [{ user }, templateData] = await Promise.all([
    api('/api/me'),
    api('/api/templates')
  ]);
  state.templates = templateData.templates;
  renderTemplates();
  setUser(user);
}

init().catch((error) => {
  console.error(error);
  reportIssue(`App failed to initialize: ${error.message}`, 'Initialization');
  setUser(null);
});

window.addEventListener('error', (event) => {
  reportIssue(`Page error: ${event.message}`, 'Window error', { filename: event.filename, lineno: event.lineno });
});

window.addEventListener('unhandledrejection', (event) => {
  reportIssue(`Action failed: ${event.reason?.message || event.reason || 'Unknown error'}`, 'Promise rejection');
});
