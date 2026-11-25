/* Local annotation overlay. HTTP state belongs to the server; file:// is export-only. */
(function () {
  if (window.__MW_ANNOTATE__) return;
  window.__MW_ANNOTATE__ = true;

  var KEY = 'mw-annotations-v1';
  var http = /^https?:$/.test(location.protocol);
  var mobile = window.matchMedia('(max-width: 640px)');
  var version = null;
  var base = [];
  var writing = false;
  var polling = false;
  var generation = 0;
  var attempts = new Map();
  var state = {
    annotations: [],
    active: false,
    target: null,
    selection: '',
    selectionNode: null,
    selectedId: null,
    mode: 'closed',
    editingId: null
  };
  var els = {};
  var toastTimer = 0;

  function text(value, limit) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit || 220);
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function node(tag, cls, value) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (value != null) el.textContent = value;
    return el;
  }

  function button(label, act, cls) {
    var el = node('button', 'mwann-btn' + (cls ? ' ' + cls : ''), label);
    el.type = 'button';
    el.setAttribute('data-act', act);
    return el;
  }

  function stateLabel(value) {
    if (value === 'sent') return 'Awaiting changes';
    if (value === 'fixed') return 'Fixed';
    return 'Draft';
  }

  function stateClass(value) {
    if (value === 'sent') return 'sent';
    if (value === 'fixed') return 'fixed';
    return 'draft';
  }

  function draftCount() {
    return state.annotations.filter(function (annotation) { return (annotation.status || 'draft') === 'draft'; }).length;
  }

  function toast(message, error) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.add('mwann-show');
    els.toast.style.background = error ? '#a33a2b' : '#2d3142';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('mwann-show'); }, 2600);
  }

  function status(message, error) {
    if (!els.status) return;
    els.status.textContent = message;
    els.status.classList.toggle('mwann-err', Boolean(error));
  }

  function sectionFor(el) {
    var scope = el && el.closest ? el.closest('section, article') : null;
    var heading = scope ? scope.querySelector('h1, h2, h3') : null;
    if (!heading && el && el.closest) heading = el.closest('h1, h2, h3');
    if (!heading) heading = document.querySelector('h1');
    return text(heading ? heading.textContent : document.title, 120);
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';

    var parts = [];
    var current = el;

    while (current) {
      var part = cssEscape(current.localName);
      if (current.id && window.CSS && window.CSS.escape) {
        var id = '#' + cssEscape(current.id);
        var ids = document.querySelectorAll(id);
        if (ids.length === 1 && ids[0] === current) {
          parts.unshift(id);
          break;
        }
      }
      var parent = current.parentElement;
      if (!parent) {
        part = ':root';
      } else if (parent.children.length > 1) {
        part += ':nth-child(' + (Array.prototype.indexOf.call(parent.children, current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }

    return parts.join(' > ');
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  var blocks = 'section, article, .card, table, tr, p, li, h1, h2, h3, h4, figure, .diagram, .callout, .formula, .footer';

  function pageElement(el) {
    return el && document.body.contains(el) && el !== document.body &&
      !els.drawer.contains(el) && !els.fab.contains(el) && !els.toast.contains(el);
  }

  function pickTarget(nodeIn) {
    var el = nodeIn;
    if (!el || el.nodeType === 3) el = el && el.parentElement;
    if (!pageElement(el) || !el.closest) return null;

    var svg = el.closest('svg');
    if (svg) return svg;

    return el.closest(blocks) || el;
  }

  function blockQuote(el) {
    return text(el.getAttribute('aria-label') || el.textContent, 300);
  }

  function quoteFor(el) {
    return state.selection || blockQuote(el);
  }

  function bboxFor(el) {
    var r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height)
    };
  }

  function view(mode) {
    state.mode = mode;
    state.active = mode !== 'closed';
    els.drawer.hidden = mode === 'closed' || mode === 'pick';
    els.fab.hidden = !els.drawer.hidden;
    els.drawer.dataset.mode = mode;
    els.fabLabel.textContent = mode === 'pick' ? 'Back to comments' : 'Comments';
    els.fab.setAttribute('aria-label', mode === 'pick' ? 'Back to comments' : 'Page comments');
    if (mode === 'pick') toast('Click a block or select text. Use Back to comments to return.');
    els.fab.setAttribute('aria-expanded', String(!els.drawer.hidden));
    els.fab.classList.toggle('mwann-on', state.active);
    document.documentElement.classList.toggle('mwann-active', canPick());
    clearHover();
    state.hovered = null;
    if (els.drawer.hidden) els.fab.focus();
    else if (mode === 'list') (els.list.querySelector('.mwann-edit') || els.hide).focus();
  }

  function canPick() {
    return !writing && !state.editingId &&
      (state.mode === 'pick' || (state.mode === 'list' && !mobile.matches));
  }

  function setActive(on) {
    if (!on) {
      view('closed');
    } else if (state.target) {
      view('compose');
      els.comment.focus();
    } else {
      view(mobile.matches && !state.editingId ? 'pick' : 'list');
    }
  }

  function clearHover() {
    var hovered = document.querySelector('.mwann-hover');
    if (hovered) hovered.classList.remove('mwann-hover');
  }

  function flash(el) {
    if (!el) return;
    var previous = document.querySelector('.mwann-flash');
    if (previous) previous.classList.remove('mwann-flash');
    el.classList.add('mwann-flash');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(function () { el.classList.remove('mwann-flash'); }, 1400);
  }

  function findElement(annotation) {
    if (annotation.page !== location.pathname + location.search) return null;
    var quote = annotation.quote;
    var hasQuote = typeof quote === 'string' && Boolean(quote.trim());

    function matches(el, fallback) {
      if (!pageElement(el) || (annotation.tag && annotation.tag !== el.localName)) return false;
      if (!hasQuote) return false;
      var block = blockQuote(el);
      if (annotation.quoteKind !== 'selection' && block === quote) return true;
      if (annotation.quoteKind === 'block' ||
          (annotation.selectionBlock === undefined ? !fallback : annotation.selectionBlock !== block)) return false;
      return el.textContent.replace(/\s+/g, ' ').trim().includes(quote) ||
        (typeof el.innerText === 'string' && el.innerText.replace(/\s+/g, ' ').trim().includes(quote));
    }

    if (annotation.selector) {
      try {
        var found = document.querySelectorAll(annotation.selector);
        if (found.length === 1) {
          var el = found[0];
          if (!hasQuote && pageElement(el) && el.id && annotation.tag === el.localName &&
              annotation.selector === '#' + cssEscape(el.id)) return el;
          // Older snapshots didn't distinguish a block quote from a text selection.
          // A substring alone must not confirm a stale positional selector.
          if (matches(el, false)) return el;
        }
      } catch (_) {}
    }

    if (!hasQuote) return null;
    var candidates = annotation.tag ? document.getElementsByTagName(annotation.tag) :
      document.querySelectorAll(blocks + ', td, th, svg');
    var match = null;
    for (var i = 0; i < candidates.length; i++) {
      if (!matches(candidates[i], true)) continue;
      if (match) return null;
      match = candidates[i];
    }
    return match;
  }

  function openComposer(target) {
    view('compose');
    state.target = target;
    var section = sectionFor(target);
    var quote = quoteFor(target);
    els.target.replaceChildren();
    els.target.appendChild(node('b', '', section || 'Page'));
    els.target.appendChild(document.createTextNode(' · ' + (target.localName || target.tagName || 'block')));
    if (quote) els.target.appendChild(document.createTextNode(' · «' + quote.slice(0, 120) + '»'));
    els.composer.hidden = false;
    els.comment.value = '';
    els.comment.focus();
    toast('Click Save or press Ctrl+Enter (⌘+Enter on Mac).');
  }

  function closeComposer() {
    state.target = null;
    state.selection = '';
    state.selectionNode = null;
    if (els.composer) els.composer.hidden = true;
    if (state.mode === 'compose') view('list');
    if (els.comment) els.comment.value = '';
  }

  function validComment(editor) {
    var value = editor.value;
    var error = !value.trim() ? 'Write a comment before saving.' :
      Array.from(value).length > 4000 ? 'Comments can be up to 4,000 characters.' : '';
    if (!error) return true;
    toast(error, true);
    editor.focus();
    return false;
  }

  function addAnnotation() {
    if (!validComment(els.comment)) return;
    if (!state.target) {
      toast('Select a block first.', true);
      return;
    }

    var annotation = {
      id: uid(),
      page: location.pathname + location.search,
      section: sectionFor(state.target),
      selector: selectorFor(state.target),
      tag: state.target.localName || state.target.tagName.toLowerCase(),
      quote: quoteFor(state.target),
      quoteKind: state.selection ? 'selection' : 'block',
      comment: els.comment.value,
      bbox: bboxFor(state.target),
      createdAt: new Date().toISOString(),
      status: 'draft'
    };
    if (state.selection) annotation.selectionBlock = blockQuote(state.target);

    state.annotations = state.annotations.concat(annotation);
    state.selectedId = annotation.id;
    flash(state.target);
    closeComposer();
    persist();
  }

  function saveEdit(id) {
    var item = state.annotations.find(function (annotation) { return annotation.id === id; });
    if (!item) return;
    var editor = els.list.querySelector('[data-edit="' + cssEscape(id) + '"]');
    if (!editor || !validComment(editor)) return;
    var edited = Object.assign({}, item, {comment: editor.value, updatedAt: new Date().toISOString(), status: 'draft'});
    delete edited.sentAt;
    delete edited.resolvedAt;
    state.annotations = state.annotations.map(function (a) { return a === item ? edited : a; });
    state.editingId = null;
    attempts.delete(id);
    persist();
  }

  function removeAnnotation(id) {
    state.annotations = state.annotations.filter(function (annotation) { return annotation.id !== id; });
    if (state.selectedId === id) state.selectedId = null;
    persist();
  }

  function markSent(items) {
    if (!items.length) {
      toast('No drafts to send.', true);
      return;
    }

    persist(items);
  }

  function sendDrafts() {
    markSent(state.annotations.filter(function (annotation) {
      return (annotation.status || 'draft') === 'draft';
    }));
  }

  function sendAnnotation(id) {
    var item = state.annotations.find(function (annotation) { return annotation.id === id; });
    if (!item) return;
    if (item.status === 'sent' || item.status === 'fixed') {
      toast('This comment was already sent.');
      return;
    }
    markSent([item]);
  }

  function render() {
    if (!els.list) return;
    els.list.replaceChildren();

    els.count.textContent = String(state.annotations.length);
    els.fabCount.textContent = String(state.annotations.length);
    els.fabCount.hidden = state.annotations.length === 0;

    var drafts = draftCount();
    if (els.sendDrafts) {
      els.sendDrafts.textContent = 'Send drafts · ' + drafts;
      els.sendDrafts.disabled = drafts === 0 || writing || !http;
    }
    els.retry.hidden = !dirty() || !http;
    els.retry.disabled = writing;

    if (!state.annotations.length) {
      var empty = node('p', 'mwann-empty',
        'No comments yet. Click a block or select text on the page to start.');
      els.list.appendChild(empty);
      return;
    }

    state.annotations.forEach(function (annotation, index) {
      var item = node('div', 'mwann-item' + (annotation.id === state.selectedId ? ' mwann-selected' : ''));
      var head = node('div', 'mwann-item-head');
      head.appendChild(node('span', 'mwann-no', String(index + 1)));
      head.appendChild(node('span', 'mwann-section', annotation.section || 'Page'));
      head.appendChild(node('span', 'mwann-state ' + stateClass(annotation.status), stateLabel(annotation.status)));
      item.appendChild(head);

      if (annotation.quote) item.appendChild(node('p', 'mwann-quote', '«' + annotation.quote.slice(0, 180) + '»'));

      if (state.editingId === annotation.id) {
        var editor = node('textarea', 'mwann-edit');
        editor.value = annotation.comment || '';
        editor.setAttribute('data-edit', annotation.id);
        item.appendChild(editor);

        var editActions = node('div', 'mwann-item-actions');
        var save = button('Save', 'save-edit', 'primary');
        save.setAttribute('data-id', annotation.id);
        var cancel = button('Cancel', 'cancel-edit');
        editActions.appendChild(save);
        editActions.appendChild(cancel);
        item.appendChild(editActions);
      } else {
        item.appendChild(node('p', 'mwann-comment', annotation.comment));

        var actions = node('div', 'mwann-item-actions');
        var show = button('Show on page', 'show');
        show.setAttribute('data-id', annotation.id);
        actions.appendChild(show);

        if ((annotation.status || 'draft') === 'draft') {
          var send = button('Send', 'send', 'primary');
          send.disabled = writing || !http;
          send.setAttribute('data-id', annotation.id);
          actions.appendChild(send);
        }

        var edit = button('Edit', 'edit');
        edit.setAttribute('data-id', annotation.id);
        var del = button('Delete', 'delete', 'danger');
        del.setAttribute('data-id', annotation.id);
        actions.appendChild(edit);
        actions.appendChild(del);
        item.appendChild(actions);
      }

      els.list.appendChild(item);
    });
  }

  function exportPayload() {
    return {
      page: location.pathname + location.search,
      exportedAt: new Date().toISOString(),
      annotations: state.annotations
    };
  }

  function copyJson() {
    var payload = JSON.stringify(exportPayload(), null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload).then(function () {
        toast('Copied JSON to the clipboard.');
      }, function () {
        legacyCopy(payload);
      });
      return;
    }
    legacyCopy(payload);
  }

  function legacyCopy(value) {
    var area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); toast('Copied JSON to the clipboard.'); }
    catch (_) { toast('Could not copy JSON.', true); }
    document.body.removeChild(area);
  }

  function downloadJson() {
    var payload = JSON.stringify(exportPayload(), null, 2);
    var blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'annotations-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Downloaded JSON.');
  }

  function same(a, b) {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
  }

  function dirty() {
    return !same(base, state.annotations);
  }

  function byId(items) {
    return new Map(items.map(function (a) { return [a.id, a]; }));
  }

  // Reapply only this tab's unsaved changes, never an old cached snapshot.
  // If both sides edited one comment, keep the server's and offer our text as a NEW draft.
  function adopt(data) {
    if (!dirty()) {
      version = data.version;
      state.annotations = base = data.annotations;
      return false;
    }
    var current = byId(data.annotations);
    var local = byId(state.annotations);
    var previous = byId(base);
    var copied = false;
    previous.forEach(function (old, id) {
      if (!local.has(id) && same(current.get(id), old)) current.delete(id);
    });
    local.forEach(function (item, id) {
      var old = previous.get(id);
      var remote = current.get(id);
      if (same(item, old) || same(item, remote)) return;
      var attempt = attempts.get(id);
      if (remote && attempt && remote.sentAt === attempt.sentAt &&
          (remote.status === 'sent' || remote.status === 'fixed')) return;
      if (same(old, remote)) {
        current.set(id, item);
      } else {
        var copy = Object.assign({}, item, {id: uid(), status: 'draft'});
        delete copy.sentAt;
        delete copy.resolvedAt;
        current.set(copy.id, copy);
        copied = true;
      }
    });
    version = data.version;
    base = data.annotations;
    state.annotations = Array.from(current.values());
    return copied;
  }

  async function snapshot(response) {
    var data = await response.json().catch(function () { return null; });
    if (!response.ok && response.status !== 409) throw new Error(data && data.error || 'HTTP ' + response.status);
    if (!data || !Number.isSafeInteger(data.version) || data.version < 0 || !Array.isArray(data.annotations)) {
      throw new Error(data && data.error || 'The server did not return a valid comment list.');
    }
    return data;
  }

  function getState() {
    return fetch('/__annotations', {cache: 'no-store', signal: AbortSignal.timeout(15000)}).then(snapshot);
  }

  async function refresh(silent) {
    if (!http || writing || polling) return;
    if (state.editingId || state.target) {
      if (!silent) toast('Close the editor before refreshing.', true);
      return;
    }
    // Never replace an editor opened, or a save begun, while this GET was in flight.
    var ticket = generation;
    polling = true;
    try {
      var data = await getState();
      if (generation !== ticket || state.editingId || state.target || (silent && data.version === version)) return;
      var copied = adopt(data);
      render();
      status(copied ? 'Someone else changed this comment. Your edit is a separate draft.' :
        dirty() ? 'Review and save your unsaved changes.' : 'Comments up to date.', dirty());
    } catch (error) {
      if (generation === ticket) status('Could not refresh comments: ' + error.message + ' · Try refreshing again.', true);
    } finally {
      polling = false;
    }
  }

  async function persist(items) {
    if (writing) return;
    if (!http) {
      try {
        localStorage.setItem(KEY, JSON.stringify(state.annotations));
        base = state.annotations;
        status('Saved locally. Download JSON to share.', false);
      } catch (_) {
        status('Could not save locally. Download JSON before closing this page.', true);
      }
      render();
      return;
    }

    writing = true;
    generation++;
    render();
    els.drawer.setAttribute('aria-busy', 'true');
    status('Saving…', false);
    try {
      if (version === null) adopt(await getState());
      var requested = byId(items || []);
      var sending = new Map();
      var next = state.annotations.map(function (item) {
        if ((item.status || 'draft') !== 'draft' || !same(requested.get(item.id), item)) return item;
        var attempt = attempts.get(item.id);
        if (!attempt || !same(attempt.draft, item)) {
          attempt = {draft: item, sentAt: new Date().toISOString()};
          attempts.set(item.id, attempt);
        }
        sending.set(item.id, attempt.sentAt);
        return Object.assign({}, item, {status: 'sent', sentAt: attempt.sentAt});
      });
      var response = await fetch('/__annotations', {
        method: 'POST', signal: AbortSignal.timeout(15000), headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({version: version, annotations: next})
      });
      var data = await snapshot(response);
      if (response.status === 409) {
        var copied = adopt(data);
        var remote = byId(data.annotations);
        if (!dirty() && sending.size && Array.from(sending).every(function (entry) {
          var item = remote.get(entry[0]);
          return item && item.sentAt === entry[1] && (item.status === 'sent' || item.status === 'fixed');
        })) {
          sending.forEach(function (_, id) { attempts.delete(id); });
          status('Delivery confirmed · ' + sending.size, false);
          return;
        }
        var conflict = copied ? 'Someone else changed this comment. Review and save your separate draft.' :
          'Loaded the latest comments. Review them and retry if needed.';
        status(data.error ? data.error + ' · ' + conflict : conflict, true);
        return;
      }
      var saved = byId(data.annotations);
      if (saved.size !== next.length || next.some(function (a) { return !saved.has(a.id); })) {
        throw new Error('The server did not confirm the saved list.');
      }
      sending.forEach(function (sentAt, id) {
        var item = saved.get(id);
        if (!item || item.sentAt !== sentAt || (item.status !== 'sent' && item.status !== 'fixed')) {
          throw new Error('The server did not confirm delivery.');
        }
      });
      version = data.version;
      state.annotations = base = data.annotations;
      sending.forEach(function (_, id) { attempts.delete(id); });
      var message = sending.size ? 'Sent: ' + sending.size : 'Saved to server';
      status(message, false);
      toast(message);
    } catch (error) {
      status('Not confirmed: ' + error.message + ' · Try again or download JSON.', true);
    } finally {
      writing = false;
      els.drawer.removeAttribute('aria-busy');
      render();
    }
  }

  function load() {
    if (http) {
      refresh(false);
      return;
    }
    try {
      var local = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (Array.isArray(local)) state.annotations = base = local;
    } catch (_) {}
    status('Saved locally. Download JSON to share.', false);
    render();
  }

  function mount() {
    els.fab = node('button', 'mwann-fab');
    els.fab.type = 'button';
    els.fab.setAttribute('aria-label', 'Page comments');
    els.fabLabel = node('span', '', 'Comments');
    els.fab.appendChild(els.fabLabel);
    els.fabCount = node('span', 'mwann-count', '0');
    els.fabCount.hidden = true;
    els.fab.appendChild(els.fabCount);

    els.drawer = node('aside', 'mwann-drawer');
    els.drawer.hidden = true;
    els.drawer.setAttribute('aria-label', 'Page comments');

    var head = node('div', 'mwann-head');
    head.appendChild(node('p', 'mwann-eyebrow', 'annotation mode'));
    var title = node('div', 'mwann-title');
    var h2 = node('h2', '', 'Comments');
    els.count = node('span', 'mwann-count', '0');
    title.appendChild(h2);
    title.appendChild(els.count);
    head.appendChild(title);
    head.appendChild(node('p', 'mwann-hint',
      'Use Select on page to hide this panel. Click a block or select text, then save your comment. Send drafts when you’re ready for the agent to review them.'));
    els.status = node('p', 'mwann-status', 'Loading…');
    head.appendChild(els.status);
    els.status.setAttribute('role', 'status');

    var actions = node('div', 'mwann-actions');
    els.sendDrafts = button('Send drafts · 0', 'send-drafts', 'primary');
    els.sendDrafts.disabled = true;
    var refreshBtn = button('Refresh', 'refresh');
    var copy = button('Copy JSON', 'copy');
    var download = button('Download JSON', 'download');
    var clear = button('Delete all', 'clear', 'danger');
    var bar = node('div', 'mwann-bar');
    var grip = node('span', 'mwann-grip', 'Drag panel');
    var grabX, grabY, roomX, roomY;
    function position(offset, room) {
      return (room > 0 ? 100 * Math.min(room, Math.max(0, offset)) / room : 0) + '%';
    }
    grip.addEventListener('pointerdown', function (event) {
      if (!event.isPrimary || event.button !== 0) return;
      var rect = els.drawer.getBoundingClientRect();
      grabX = event.clientX - rect.left;
      grabY = event.clientY - rect.top;
      roomX = document.documentElement.clientWidth - rect.width;
      roomY = document.documentElement.clientHeight - rect.height;
      grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener('pointermove', function (event) {
      if (event.buttons === 1 && event.isPrimary && grip.hasPointerCapture(event.pointerId)) {
        els.drawer.style.setProperty('--mwann-x', position(event.clientX - grabX, roomX));
        els.drawer.style.setProperty('--mwann-y', position(event.clientY - grabY, roomY));
      }
    });
    bar.appendChild(grip);
    var dock = button('Dock right', 'dock', 'mwann-dock');
    bar.appendChild(dock);
    els.hide = button('Hide · Esc', 'close');
    bar.appendChild(els.hide);
    actions.appendChild(button('Select on page', 'pick'));
    els.retry = button('Save changes', 'retry');
    actions.appendChild(els.retry);
    actions.appendChild(els.sendDrafts);
    actions.appendChild(refreshBtn);
    actions.appendChild(copy);
    actions.appendChild(download);
    actions.appendChild(clear);
    head.appendChild(actions);

    els.list = node('div', 'mwann-list');
    els.composer = node('div', 'mwann-composer');
    els.composer.hidden = true;
    els.target = node('p', 'mwann-target', '');
    els.comment = node('textarea', 'mwann-textarea');
    els.comment.setAttribute('placeholder', 'What should change? For example: “Change the opening time to 10:30.”');
    var composerActions = node('div', 'mwann-composer-actions');
    var cancel = button('Cancel', 'cancel');
    var save = button('Save', 'save', 'primary');
    composerActions.appendChild(cancel);
    composerActions.appendChild(save);
    els.composer.appendChild(els.target);
    els.composer.appendChild(els.comment);
    els.composer.appendChild(composerActions);

    els.drawer.appendChild(bar);
    els.drawer.appendChild(head);
    els.drawer.appendChild(els.list);
    els.drawer.appendChild(els.composer);

    els.toast = node('div', 'mwann-toast', '');
    document.body.appendChild(els.fab);
    document.body.appendChild(els.drawer);
    document.body.appendChild(els.toast);

    els.fab.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (state.mode === 'pick') view('list');
      else setActive(!state.active);
    });

    els.drawer.addEventListener('click', function (event) {
      var act = event.target.closest('[data-act]');
      if (!act) return;
      event.preventDefault();
      event.stopPropagation();
      var id = act.getAttribute('data-id');
      var kind = act.getAttribute('data-act');
      if (kind === 'dock') {
        var docked = els.drawer.classList.toggle('mwann-docked');
        dock.textContent = docked ? 'Undock' : 'Dock right';
        return;
      }
      if (writing && kind !== 'copy' && kind !== 'download' && kind !== 'close') {
        toast('Wait for the save to finish.');
        return;
      }
      if (state.editingId && !['save-edit', 'cancel-edit', 'copy', 'download', 'close'].includes(kind)) {
        toast('Save or cancel your edit first.', true);
        return;
      }

      if (kind === 'close') setActive(false);
      else if (kind === 'pick') view('pick');
      else if (kind === 'retry') persist();
      else if (kind === 'send-drafts') sendDrafts();
      else if (kind === 'send') sendAnnotation(id);
      else if (kind === 'refresh') refresh(false);
      else if (kind === 'copy') copyJson();
      else if (kind === 'download') downloadJson();
      else if (kind === 'clear') {
        if (!state.annotations.length) return;
        if (window.confirm('Delete all comments on this page?')) {
          state.annotations = [];
          state.selectedId = null;
          persist();
        }
      } else if (kind === 'cancel') closeComposer();
      else if (kind === 'save') addAnnotation();
      else if (kind === 'show') {
        var found = findElement(state.annotations.find(function (a) { return a.id === id; }) || {});
        if (!found) {
          toast('Could not match this comment to a single block on the page.', true);
          return;
        }
        state.selectedId = id;
        render();
        if (mobile.matches) view('pick');
        flash(found);
      } else if (kind === 'edit') {
        state.editingId = id;
        render();
        var editor = els.list.querySelector('[data-edit="' + cssEscape(id) + '"]');
        if (editor) { editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); }
      } else if (kind === 'cancel-edit') {
        state.editingId = null;
        render();
      } else if (kind === 'save-edit') {
        saveEdit(id);
      } else if (kind === 'delete') {
        removeAnnotation(id);
      }
    });

    document.addEventListener('mousedown', function (event) {
      if (!canPick()) return;
      if (event.target.closest('.mwann-drawer, .mwann-fab')) return;
      state.selection = '';
      state.selectionNode = null;
    }, true);

    document.addEventListener('mouseup', function () {
      if (!canPick()) return;
      var selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        state.selection = text(selection.toString(), 400);
        state.selectionNode = selection.getRangeAt(0).commonAncestorContainer;
      }
    }, true);

    document.addEventListener('mouseover', function (event) {
      if (!canPick()) return;
      if (event.target.closest('.mwann-drawer, .mwann-fab')) return;
      var target = pickTarget(event.target);
      if (!target || target === state.hovered) return;
      clearHover();
      state.hovered = target;
      target.classList.add('mwann-hover');
    }, true);

    document.addEventListener('mouseout', function (event) {
      if (!canPick()) return;
      if (event.target.closest('.mwann-drawer, .mwann-fab')) return;
      clearHover();
      state.hovered = null;
    }, true);

    document.addEventListener('click', function (event) {
      if (!canPick()) return;
      if (event.target.closest('.mwann-drawer, .mwann-fab')) return;
      event.preventDefault();
      event.stopPropagation();

      var selection = window.getSelection();
      if (selection && selection.rangeCount && !selection.isCollapsed) {
        state.selection = text(selection.toString(), 400);
        state.selectionNode = selection.getRangeAt(0).commonAncestorContainer;
      }
      var target = pickTarget(state.selectionNode || event.target);
      if (!target) return;
      clearHover();
      state.hovered = null;
      openComposer(target);
    }, true);

    document.addEventListener('keydown', function (event) {
      if (event.altKey && !event.ctrlKey && !event.metaKey &&
          (event.key === 'a' || event.key === 'A' || event.code === 'KeyA')) {
        event.preventDefault();
        event.stopPropagation();
        setActive(!state.active);
        return;
      }

      if (event.key === 'Escape' && state.active) {
        event.preventDefault();
        event.stopPropagation();
        setActive(false);
        return;
      }

      if (!writing && (event.ctrlKey || event.metaKey) && event.key === 'Enter' && state.mode === 'compose') {
        event.preventDefault();
        addAnnotation();
      }
    }, true);

    window.addEventListener('beforeunload', function (event) {
      if (!dirty() && !writing && !state.editingId && !(state.target && els.comment.value)) return;
      event.preventDefault();
      event.returnValue = '';
    });

    render();
    load();
    setInterval(function () {
      if (!state.active || document.hidden) return;
      refresh(true);
    }, 5000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
