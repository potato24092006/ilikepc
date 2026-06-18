/* global wpToHtmlData, jQuery */
let isMonitoring = false;
let monitorTimer = null;

// Monotonic token used to ignore stale /poll responses (slow networks / overlapping requests).
// Any time we start/stop/pause/resume a run, we bump the token so in-flight responses
// from the previous UI epoch can't overwrite the current UI state.
let ehPollToken = 0;
function ehBumpPollToken() { ehPollToken += 1; return ehPollToken; }
function ehGetPollToken() { return ehPollToken; }

// Preview modal auto-refresh timer
let ehPreviewRefreshTimer = null;
let ehPreviewPollTimer = null;
let ehLastExportsFetchAt = 0;

// Tracks whether the latest export has previewable outputs.
let ehHasExports = false;

// Track last-known backend state to drive UI messages.
let ehLastBackendState = '';

// Last values from fetchStatus — used by fetchLog to render live progress from log lines.
let ehLastStatusCounts = { totalUrls: 0, doneUrls: 0, failedUrls: 0, totalAssets: 0, doneAssets: 0, failedAssets: 0, state: '' };

// Adaptive polling: large sites can overload if /poll drives background work too frequently.
// Start at a safer baseline and back off automatically when responses get slow.
let ehPollDelayMs = 5000;
let ehLastStatusRttMs = 0;

function ehClamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

function ehTunePollDelay() {
    const minMs = 2000;
    const maxMs = 15000;
    if (ehLastStatusRttMs >= 2500) {
        ehPollDelayMs = ehClamp(Math.round(ehPollDelayMs * 1.35), minMs, maxMs);
    } else if (ehLastStatusRttMs >= 1200) {
        ehPollDelayMs = ehClamp(Math.round(ehPollDelayMs * 1.15), minMs, maxMs);
    } else if (ehLastStatusRttMs > 0 && ehLastStatusRttMs <= 400) {
        ehPollDelayMs = ehClamp(Math.round(ehPollDelayMs * 0.90), minMs, maxMs);
    }
    return ehPollDelayMs;
}

// Backend can report transitional states that are still part of an active run.
// Treat them as "running" for UI controls so Start/Export buttons don't flip
// to a completed/idle posture mid-run.
function ehNormalizeUiState(state) {
    const s = String(state || '').toLowerCase();
    if (s === 'building_queue') return 'running';
    return s;
}

let ehFtpSettingsCache = null;

let ehState = {
    scope: 'custom', // custom | all_posts | all_pages | full_site
    type: 'post',
    page: 1,
    perPage: 30,
    search: '',
    statuses: ['publish'],
    hasMore: true,
    loading: false,
    selected: new Map(), // key => { id, type, title, url }
};

function setRunControlsVisibility(state) {
    const s = ehNormalizeUiState(state);

    const $pause = jQuery('#wp-to-html-pause');
    const $resume = jQuery('#wp-to-html-resume');
    const $stop = jQuery('#wp-to-html-stop');
    const $preview = jQuery('#eh-preview');

    const isRunning = (s === 'running');
    const isPaused = (s === 'paused');

    // Pause/Resume/Stop are only relevant while active.
    if (isRunning) {
        $pause.show();
        $resume.hide();
        $stop.show();
    } else if (isPaused) {
        $pause.hide();
        $resume.show();
        $stop.show();
    } else {
        $pause.hide();
        $resume.hide();
        $stop.hide();
    }

    // Preview should be hidden when truly idle.
    // Show it when outputs exist (completed export), otherwise keep hidden.
    if (ehHasExports) {
        $preview.show();
    } else {
        // During active run, show Preview (disabled) so UI appears consistently.
        if (isRunning || isPaused) {
            $preview.show();
        } else {
            $preview.hide();
        }
    }
}


function withNoCache(url) {
    try {
        const u = new URL(url, window.location.origin);
        u.searchParams.set('_', String(Date.now()));
        return u.toString();
    } catch (e) {
        // Fallback: append cachebuster
        const sep = url.indexOf('?') >= 0 ? '&' : '?';
        return url + sep + '_=' + Date.now();
    }
}

function setBusy(isBusy) {
    const $contentSelection = jQuery('#eh-acc-content-selection');
    const $spinner = jQuery('#eh-content-spinner');
    ehState.loading = !!isBusy;

    $contentSelection.toggleClass('eh-busy', !!isBusy);
    $spinner.toggleClass('is-active', !!isBusy);

    // disable selection controls while loading
    jQuery('#eh-tab-posts, #eh-tab-pages, #eh-tab-types, #eh-select-all, #eh-clear, #eh-search, #eh-export-custom, #eh-export-all-posts, #eh-export-all-pages, #eh-export-full, .eh-status, #eh-post-type-select')
        .prop('disabled', !!isBusy);
}

function setStartBusy(isBusy) {
    jQuery('#eh-start-spinner').toggleClass('is-active', !!isBusy);
    jQuery('#wp-to-html-start').prop('disabled', !!isBusy);
}

// Keep Start button + loader consistent with backend state.
// Requirement: loader visible and Start disabled for the full export duration (state: running).
// Additionally, Start stays disabled while paused (prevents starting a second run).
function syncStartUiToBackendState(state) {
    const s = ehNormalizeUiState(state);
    const isRunning = (s === 'running');
    const isPaused = (s === 'paused');

    // Loader only for active processing.
    jQuery('#eh-start-spinner').toggleClass('is-active', isRunning);

    // Block starting a new run while one is active/paused.
    jQuery('#wp-to-html-start').prop('disabled', (isRunning || isPaused));
}

function setFtpBusy(isBusy) {
    jQuery('#wp-to-html-ftp-spinner').toggleClass('is-active', !!isBusy);
    jQuery('#wp-to-html-ftp-save, #wp-to-html-ftp-test').prop('disabled', !!isBusy);
}

// -------------------------------------------------------------
// AWS S3 (Pro)

function setS3Busy(isBusy) {
    jQuery('#wp-to-html-s3-spinner').toggleClass('is-active', !!isBusy);
    jQuery('#wp-to-html-s3-save, #wp-to-html-s3-test').prop('disabled', !!isBusy);
}

function s3Msg(html, isError = false) {
    const $m = jQuery('#wp-to-html-s3-msg');
    if (!$m.length) return;
    if (!html) {
        $m.html('');
        return;
    }
    $m.html(isError ? `<span class="eh-error">${html}<\/span>` : html);
}

function readS3SettingsFromForm() {
    return {
        bucket: String(jQuery('#wp-to-html-s3-bucket').val() || '').trim(),
        region: String(jQuery('#wp-to-html-s3-region').val() || '').trim(),
        access_key: String(jQuery('#wp-to-html-s3-access').val() || '').trim(),
        secret_key: String(jQuery('#wp-to-html-s3-secret').val() || ''),
        prefix: String(jQuery('#wp-to-html-s3-prefix-default').val() || '').trim(),
    };
}

function fillS3SettingsForm(s) {
    s = s || {};
    jQuery('#wp-to-html-s3-bucket').val(s.bucket || '');
    jQuery('#wp-to-html-s3-region').val(s.region || '');
    jQuery('#wp-to-html-s3-access').val(s.access_key || '');
    // Secret is never returned; keep blank.
    jQuery('#wp-to-html-s3-secret').val('');
    jQuery('#wp-to-html-s3-prefix-default').val(s.prefix || '');
}

async function fetchS3Settings() {
    if (!wpToHtmlData?.s3_settings_url) return;
    if (!Number(wpToHtmlData?.pro_active || 0)) return;
    try {
        setS3Busy(true);
        const res = await fetch(withNoCache(wpToHtmlData.s3_settings_url), {
            headers: { 'X-WP-Nonce': wpToHtmlData.nonce }
        });
        const data = await safeJson(res);
        if (data && data.ok) {
            fillS3SettingsForm(data.settings || {});
        }
    } catch (e) {
        // Silent; tab may exist but pro not active.
    } finally {
        setS3Busy(false);
    }
}

function ftpMsg(html, isError = false) {
    const $m = jQuery('#wp-to-html-ftp-msg');
    $m.toggleClass('eh-error', !!isError);
    $m.html(html || '');
}

function readFtpForm() {
    return {
        host: String(jQuery('#wp-to-html-ftp-host').val() || '').trim(),
        port: Number(jQuery('#wp-to-html-ftp-port').val() || 21),
        user: String(jQuery('#wp-to-html-ftp-user').val() || '').trim(),
        pass: String(jQuery('#wp-to-html-ftp-pass').val() || ''),
        ssl: jQuery('#wp-to-html-ftp-ssl').is(':checked') ? 1 : 0,
        passive: jQuery('#wp-to-html-ftp-passive').is(':checked') ? 1 : 0,
        timeout: Number(jQuery('#wp-to-html-ftp-timeout').val() || 20),
        base_path: String(jQuery('#wp-to-html-ftp-base').val() || '').trim(),
        default_path: String(jQuery('#wp-to-html-ftp-default-path').val() || '').trim(),
    };
}

function fillFtpForm(s) {
    s = s || {};
    jQuery('#wp-to-html-ftp-host').val(s.host || '');
    jQuery('#wp-to-html-ftp-port').val(String(s.port || 21));
    jQuery('#wp-to-html-ftp-user').val(s.user || '');
    // password is intentionally not echoed back from server
    jQuery('#wp-to-html-ftp-pass').val('');
    jQuery('#wp-to-html-ftp-ssl').prop('checked', !!Number(s.ssl || 0));
    jQuery('#wp-to-html-ftp-passive').prop('checked', s.passive === undefined ? true : !!Number(s.passive));
    jQuery('#wp-to-html-ftp-timeout').val(String(s.timeout || 20));
    jQuery('#wp-to-html-ftp-base').val(s.base_path || '');
}


let ehFtpBrowserTarget = null;
let ehFtpBrowserMode = 'saved'; // 'saved' | 'form'
let ehFtpBrowserSelected = '';

function normalizeRemotePath(p) {
    p = String(p || '').trim().replace(/\\/g, '/');
    if (!p) return '/';
    if (!p.startsWith('/')) p = '/' + p;
    // remove trailing slash except root
    if (p.length > 1) p = p.replace(/\/+$/g, '');
    return p || '/';
}

function parentRemotePath(p) {
    p = normalizeRemotePath(p);
    if (p === '/' ) return '/';
    const parts = p.split('/').filter(Boolean);
    parts.pop();
    return '/' + parts.join('/');
}

function showFtpBrowser(show) {
    const $m = jQuery('#wp-to-html-ftp-browser-modal');
    if (!$m.length) return;
    $m.toggle(!!show);
    if (!show) {
        ehFtpBrowserTarget = null;
        ehFtpBrowserSelected = '';
        jQuery('#wp-to-html-ftp-browser-list').html('');
        jQuery('#wp-to-html-ftp-browser-msg').html('');
    }
}

async function ftpListDirs(path) {
    if (!wpToHtmlData?.ftp_list_url) return { ok: false, message: 'Missing ftp_list_url' };
    const payload = { path: normalizeRemotePath(path) };
    if (ehFtpBrowserMode === 'form') {
        payload.settings = readFtpForm();
        payload.use_saved = 0;
    } else {
        payload.use_saved = 1;
    }

    try {
        const res = await fetch(wpToHtmlData.ftp_list_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': wpToHtmlData.nonce },
            body: JSON.stringify(payload)
        });
        return await safeJson(res);
    } catch (e) {
        return { ok: false, message: String(e?.message || e) };
    }
}

async function renderFtpBrowser(path) {
    path = normalizeRemotePath(path);
    jQuery('#wp-to-html-ftp-browser-path').val(path);
    jQuery('#wp-to-html-ftp-browser-msg').html('Loading…');
    const data = await ftpListDirs(path);
    if (!data?.ok) {
        jQuery('#wp-to-html-ftp-browser-msg').html(`<span class="eh-error">${escapeHtml(data?.message || 'Could not list folders.')}<\/span>`);
        jQuery('#wp-to-html-ftp-browser-list').html('');
        return;
    }
    const dirs = Array.isArray(data.dirs) ? data.dirs : [];
    jQuery('#wp-to-html-ftp-browser-msg').html(`Found <b>${dirs.length}<\/b> folders in <code>${escapeHtml(data.path)}<\/code>`);
    ehFtpBrowserSelected = '';
    const html = dirs.map(d => {
        const safe = escapeHtml(d);
        return `<div class="eh-browser-item" data-folder="${safe}"><span class="eh-browser-folder">📁 ${safe}<\/span><span class="eh-muted">/${safe}<\/span><\/div>`;
    }).join('');
    jQuery('#wp-to-html-ftp-browser-list').html(html || '<div class="eh-muted" style="padding:10px;">No folders found.<\/div>');
}

function openFtpBrowser(targetSelector, initialPath, mode) {
    ehFtpBrowserTarget = targetSelector;
    ehFtpBrowserMode = mode || 'saved';
    showFtpBrowser(true);
    renderFtpBrowser(initialPath || '/');
}

function wireFtpBrowserEvents() {
    // close/cancel
    jQuery('#wp-to-html-ftp-browser-close, #wp-to-html-ftp-browser-cancel').on('click', () => showFtpBrowser(false));

    jQuery('#wp-to-html-ftp-browser-refresh').on('click', () => {
        const p = jQuery('#wp-to-html-ftp-browser-path').val();
        renderFtpBrowser(p);
    });

    jQuery('#wp-to-html-ftp-browser-up').on('click', () => {
        const p = jQuery('#wp-to-html-ftp-browser-path').val();
        renderFtpBrowser(parentRemotePath(p));
    });

    jQuery('#wp-to-html-ftp-browser-path').on('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            renderFtpBrowser(jQuery('#wp-to-html-ftp-browser-path').val());
        }
    });

    jQuery(document).on('click', '#wp-to-html-ftp-browser-list .eh-browser-item', function () {
        jQuery('#wp-to-html-ftp-browser-list .eh-browser-item').removeClass('is-active');
        jQuery(this).addClass('is-active');
        ehFtpBrowserSelected = jQuery(this).data('folder') || '';
    });

    jQuery(document).on('dblclick', '#wp-to-html-ftp-browser-list .eh-browser-item', function () {
        const folder = jQuery(this).data('folder') || '';
        const cur = normalizeRemotePath(jQuery('#wp-to-html-ftp-browser-path').val());
        renderFtpBrowser(cur === '/' ? '/' + folder : cur + '/' + folder);
    });

    jQuery('#wp-to-html-ftp-browser-select').on('click', () => {
        const cur = normalizeRemotePath(jQuery('#wp-to-html-ftp-browser-path').val());
        // if user highlighted a folder, select inside it; else select current path
        let chosen = cur;
        if (ehFtpBrowserSelected) chosen = (cur === '/' ? '/' + ehFtpBrowserSelected : cur + '/' + ehFtpBrowserSelected);
        if (ehFtpBrowserTarget) {
            jQuery(ehFtpBrowserTarget).val(normalizeRemotePath(chosen));
        }
        showFtpBrowser(false);
    });
}

async function loadFtpSettings() {
    if (!wpToHtmlData?.ftp_settings_url) return;
    try {
        const res = await fetch(withNoCache(wpToHtmlData.ftp_settings_url), { headers: { 'X-WP-Nonce': wpToHtmlData.nonce } });
        const data = await safeJson(res);
        ehFtpSettingsCache = (data?.settings || {});
        fillFtpForm(ehFtpSettingsCache);
        // If export remote path is empty, prefill from default_path.
        const defp = String(ehFtpSettingsCache?.default_path || '').trim();
        const $rp = jQuery('#wp-to-html-ftp-remote-path');
        if ($rp.length && !$rp.val() && defp) $rp.val(defp);
    } catch (e) {
        if (wpToHtmlData.debug) { console.warn('[WP_TO_HTML_DEBUG] loadFtpSettings error:', e); }
    }
}

var EH_FREE_SCOPE_LIMIT = 5;

function ehIsPro() {
    return !!(window.wpToHtmlData && Number(window.wpToHtmlData.pro_active) === 1);
}

function updateSelectedCount(){
    jQuery('#eh-selected-count').text(String(ehState.selected.size));
    var $notice = jQuery('#eh-free-limit-notice');
    if (!ehIsPro() && ehState.selected.size >= EH_FREE_SCOPE_LIMIT) {
        if (!$notice.length) {
            jQuery('#eh-content-list').before(
                '<div id="eh-free-limit-notice" style="background:#fff3cd;border:1px solid #ffc107;color:#856404;padding:7px 10px;margin-bottom:6px;border-radius:4px;font-size:12px;">' +
                '&#x26A0; Free plan: max ' + EH_FREE_SCOPE_LIMIT + ' items in Custom scope. ' +
                '<a href="https://myrecorp.com/export-wp-page-to-static-html-pro" target="_blank" rel="noopener noreferrer">Upgrade to Pro</a> for unlimited.</div>'
            );
        }
    } else {
        $notice.remove();
    }
}

function renderList(items, append = false) {
    const $list = jQuery('#eh-content-list');

    if (!items || !items.length) {
        if (!append) $list.html('<div class="eh-muted" style="padding:10px;">No results.</div>');
        return;
    }

    const html = items.map(it => {
        const key = `${it.type}:${it.id}`;
        const checked = ehState.selected.has(key) ? 'checked' : '';
        const atLimit = !ehIsPro() && !checked && ehState.selected.size >= EH_FREE_SCOPE_LIMIT;
        const disabledAttr = atLimit ? 'disabled title="Free plan: max 5 items selected"' : '';
        const title = it.title || '(no title)';
        const meta = `${it.date || ''}${it.slug ? ' • ' + it.slug : ''}${it.status ? ' • ' + it.status : ''}`;
        return `
            <div class="eh-item">
                <input type="checkbox" class="wp-to-html-select-item" data-id="${it.id}" data-type="${it.type}" ${checked} ${disabledAttr}/>
                <label>
                    <div class="eh-title">${escapeHtml(title)}</div>
                    <div class="eh-meta">${escapeHtml(meta)}</div>
                </label>
            </div>
        `;
    }).join('');

    if (append) {
        $list.append(html);
    } else {
        $list.html(html);
    }
}

function escapeHtml(str) {
    return String(str || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

// Converts bytes to a human-readable size string: B, KB, MB, or GB
function formatFileSize(bytes) {
    bytes = parseInt(bytes, 10) || 0;
    if (bytes < 1024)                        return bytes + ' B';
    if (bytes < 1024 * 1024)                 return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024)         return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function cssEscape(str) {
    // Minimal CSS attribute selector escaping
    return String(str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeJson(res) {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
        return res.text().then(t => {
            throw new Error('Non-JSON response: ' + t.slice(0, 120));
        });
    }
    return res.json();
}

function fetchContent() {
    if (ehState.loading) return;

    // Content list is only relevant for custom scope
    if (ehState.scope !== 'custom') return;

    setBusy(true);

    const url = new URL(wpToHtmlData.content_url, window.location.origin);
    url.searchParams.set('type', ehState.type);
    url.searchParams.set('page', String(ehState.page));
    url.searchParams.set('per_page', String(ehState.perPage));
    if (ehState.search) url.searchParams.set('search', ehState.search);
    if (ehState.statuses && ehState.statuses.length) {
        url.searchParams.set('status', ehState.statuses.join(','));
    }

    return fetch(url.toString(), {
        headers: { 'X-WP-Nonce': wpToHtmlData.nonce }
    })
        .then(safeJson)
        .then(data => {
            const append = ehState.page > 1;
            renderList(data.items || [], append);
            ehState.hasMore = !!data.has_more;
            setBusy(false);
            jQuery(document).trigger('wp_to_html_content_loaded');
        })
        .catch(err => {
            if (wpToHtmlData.debug) { console.error('[WP_TO_HTML_DEBUG] fetchContent error:', err); }
            jQuery('#eh-content-list').html('<div class="eh-muted" style="padding:10px;">Failed to load content list.</div>');
            setBusy(false);
        });
}

function setType(type) {
    ehState.type = type;

    const isPost = type === 'post';
    const isPage = type === 'page';
    const isTypes = !isPost && !isPage;

    jQuery('#eh-tab-posts').attr('aria-pressed', isPost ? 'true' : 'false');
    jQuery('#eh-tab-pages').attr('aria-pressed', isPage ? 'true' : 'false');
    jQuery('#eh-tab-types').attr('aria-pressed', isTypes ? 'true' : 'false');

    // Show the CPT selector row only when "Post types" is active.
    jQuery('#eh-post-type-row').toggle(isTypes);
    if (isTypes) {
        const $sel = jQuery('#eh-post-type-select');
        if ($sel.length) {
            const cur = String($sel.val() || '');
            if (cur !== String(type)) {
                $sel.val(String(type));
            }
        }
    }

    ehState.page = 1;
    ehState.hasMore = true;
    fetchContent();

    // If an export already completed before refresh, load preview + download
    fetchStatus()
        .then(st => {
            const state = String(st?.state || '').toLowerCase();
            if (state === 'completed') {
                return fetchExports().then(renderExportsPanel);
            }
        })
        .catch(()=>{});
}

function setScope(scope) {
    ehState.scope = scope;

    const m = {
        custom: '#eh-export-custom',
        all_posts: '#eh-export-all-posts',
        all_pages: '#eh-export-all-pages',
        full_site: '#eh-export-full'
    };

    Object.values(m).forEach(sel => jQuery(sel).attr('aria-pressed', 'false'));
    if (m[scope]) jQuery(m[scope]).attr('aria-pressed', 'true');

    // Only show selector UI for custom
    jQuery('#eh-selector').toggle(scope === 'custom');
    jQuery('#eh-acc-content-selection').toggle(scope === 'custom');

    // All posts: show post type selector
    jQuery('#eh-all-posts-types').toggle(scope === 'all_posts');

    // Reset list paging when switching back to custom
    if (scope === 'custom') {
        ehState.page = 1;
        ehState.hasMore = true;
        fetchContent();
    }

    // Hide Post Status section for full_site scope
    jQuery('#eh-acc-post-status').toggle(scope !== 'full_site');

    if (scope === 'full_site') {
        document.getElementById('wp-to-html-include-home').checked = true;
    }

    updateScopeUI();
}

function readAllPostsTypesFromUi() {
    const $wrap = jQuery('#eh-all-posts-types-list');
    if (!$wrap.length) return [];
    return $wrap.find('input.eh-all-posts-pt:checked').map(function () {
        return String(jQuery(this).val() || '').trim();
    }).get().filter(Boolean);
}

function readStatusesFromUi() {
    const statuses = jQuery('.eh-status:checked').map(function () {
        return String(jQuery(this).val());
    }).get();
    ehState.statuses = statuses.length ? statuses : ['publish'];
}

// If private/draft are selected, we may force "editor".
// But ONLY when the user has explicitly chosen a role.
function enforceExportRoleFromStatuses() {
    const statuses = (ehState && Array.isArray(ehState.statuses)) ? ehState.statuses : [];
    const needsEditor = statuses.includes('private') || statuses.includes('draft');

    const $sel = jQuery('#wp-to-html-export-as');
    if (!$sel.length) return;

    // Track last manual selection so we can restore it when private/draft are unchecked.
    const current = String($sel.val() || '');
    const manual = String($sel.data('ehManualRole') || '');

    // IMPORTANT:
    // - If the dropdown is empty, DO NOT auto-select a role.
    //   (Backend will not create a temp user; export runs publicly/as current user.)
    // - If a role is selected and draft/private are requested, force editor.
    if (needsEditor) {
        if (current && current !== 'editor') {
            $sel.data('ehManualRole', current);
            $sel.val('editor');
        }
    } else {
        // Restore manual role if we previously forced editor.
        if (manual && current === 'editor') {
            $sel.val(manual);
        }
    }
}

function getScopePayload() {
  const fullSite = jQuery('#eh-full-site').is(':checked');

  // IMPORTANT: ensure your include-home checkbox id matches this
  const includeHome = jQuery('#eh-include-home').is(':checked');

  const saveGrouped = jQuery('#save_assets_grouped').is(':checked');

  const assetCollectionMode = String(jQuery('#wp-to-html-asset-collection-mode').val() || 'strict');

  // Only send a role if the user explicitly selected one.
  // If draft/private are selected AND a role was selected, force editor.
  const needsEditor = Array.isArray(ehState?.statuses) && (ehState.statuses.includes('private') || ehState.statuses.includes('draft'));
  const selectedRole = String(jQuery('#wp-to-html-export-as').val() || '');
  const exportAsRole = selectedRole ? (needsEditor ? 'editor' : selectedRole) : '';

  // ✅ Source of truth: DOM checked boxes
  const selectedFromDom = jQuery('#eh-content-list .eh-item-check:checked').map(function () {
    return {
      id: Number(jQuery(this).data('id')),
      type: String(jQuery(this).data('type')),
    };
  }).get();

  // Optional: merge with in-memory selections (if you support selections across searches/pages)
  const selectedFromMap = (typeof ehState !== 'undefined' && ehState.selected)
    ? Array.from(ehState.selected.values()).map(x => ({ id: Number(x.id), type: String(x.type) }))
    : [];

  // Merge + unique
  const seen = new Set();
  const selected = [...selectedFromMap, ...selectedFromDom].filter(x => {
    const k = `${x.type}:${x.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    full_site: fullSite,
    include_home: includeHome,
    selected,
    save_assets_grouped: saveGrouped ? 1 : 0,
    asset_collection_mode: assetCollectionMode,
    export_as_role: exportAsRole
  };
}

function updateScopeUI() {
    const s = ehState.scope;
    if (s === 'full_site') {
        jQuery('#eh-export-hint').text('Exporting: Full site');
    } else if (s === 'all_posts') {
        jQuery('#eh-export-hint').text('Exporting: All posts');
    } else if (s === 'all_pages') {
        jQuery('#eh-export-hint').text('Exporting: All pages');
    } else {
        jQuery('#eh-export-hint').text(`Selected: ${ehState.selected.size} items`);
    }
}

function stopMonitoring(finalMsg) {
    isMonitoring = false;
    ehBumpPollToken();

    if (monitorTimer) {
        clearTimeout(monitorTimer);
        monitorTimer = null;
    }

    setStartBusy(false);

    // When idle, hide run controls (Preview may remain visible if outputs exist).
    setRunControlsVisibility('idle');

    if (finalMsg) {
        jQuery('#wp-to-html-result-extra').html('<strong>' + escapeHtml(finalMsg) + '</strong>');
    }
    jQuery('#eh-zip-notice').hide();
}

// Stop ONLY the polling (status/log) loop.
// Used for Pause: backend work should pause, and the UI should stop hitting /status and /log.
// Unlike stopMonitoring(), this does not reset controls to idle.
function stopPolling() {
    isMonitoring = false;
    ehBumpPollToken();
    if (monitorTimer) {
        clearTimeout(monitorTimer);
        monitorTimer = null;
    }
}

function startMonitoring() {
    if (isMonitoring) return;
    isMonitoring = true;

    const token = ehBumpPollToken();

    if (monitorTimer) {
        clearTimeout(monitorTimer);
        monitorTimer = null;
    }

    monitorLoop(token);
}

function shouldStopFromStatus(status) {
    if (!status) return false;

    const state = String(status.state || '').toLowerCase();
    const isRunning = Number(status.is_running || 0);
    const totalUrls = Number(status.total_urls || 0);
    const doneUrls = Number(status.processed_urls || 0);
    const failedUrls = Number(status.failed_urls || 0);
    const totalAssets = Number(status.total_assets || 0);
    const doneAssets = Number(status.processed_assets || 0);
    const failedAssets = Number(status.failed_assets || 0);

    const urlsComplete = totalUrls > 0 ? ((doneUrls + failedUrls) >= totalUrls) : true;
    // total_assets=0 while is_running=1 means assets haven't been queued yet — not complete.
    const assetsComplete = totalAssets > 0 ? ((doneAssets + failedAssets) >= totalAssets) : (isRunning === 0);
    const doneByCount = urlsComplete && assetsComplete;
    const doneByState = ['completed', 'stopped', 'error'].includes(state);
    const notRunning = state === 'stopped';

    return doneByCount || doneByState || notRunning;
}

function monitorLoop(token) {
    if (!isMonitoring || token !== ehGetPollToken()) return;

    // IMPORTANT:
    // /status (or /poll) may *advance the export* (and write new log lines) as part of the request.
    // Therefore we must fetch logs *after* the status call completes, otherwise we can miss the
    // final "wrapup / ZIP created" lines (race condition).
    fetchStatus(token)
        .then((status) => {
            return fetchLog(token).then(() => status);
        })
        .then((status) => {

            const state = String(status?.state || '').toLowerCase();
            const totalUrls = Number(status?.total_urls || 0);
            const doneUrls = Number(status?.processed_urls || 0);
            const failedUrls = Number(status?.failed_urls || 0);
            const totalAssets = Number(status?.total_assets || 0);
            const doneAssets = Number(status?.processed_assets || 0);
            const failedAssets = Number(status?.failed_assets || 0);
            const isRunning = Number(status?.is_running || 0);

            // ✅ HARD STOP conditions (don't rely only on helper)
            const doneByState = ['completed', 'stopped', 'error'].includes(state);
            const urlsComplete = totalUrls > 0 ? ((doneUrls + failedUrls) >= totalUrls) : true;
            // total_assets=0 while is_running=1 means assets aren't queued yet — not complete.
            const assetsComplete = totalAssets > 0 ? ((doneAssets + failedAssets) >= totalAssets) : (isRunning === 0);
            const doneByCount = urlsComplete && assetsComplete;
            const doneByNotRunning = isRunning === 0 && doneByCount;

            if (doneByState || doneByCount || doneByNotRunning) {

                // One last log drain *after* we observe completion, to pick up wrapup/ZIP lines
                // that may have been written at the end of the status request.
                const finalize = () => {
                    if (state === 'completed' || doneByCount || doneByNotRunning) {
                        fetchExports()
                            .then((exportsData) => {
                                try { renderExportsPanel(exportsData); } catch (e) {}
                                // Always append a final summary so the log isn't left at an intermediate
                                // "Assets progress" line when the export completes.
                                ehAppendCompletionSummary(status, exportsData);
                                return exportsData;
                            })
                            .catch(() => {})
                            // Keep exact string for external hooks
                            .finally(() => stopMonitoring('Export Finished'));
                    } else if (state === 'stopped') {
                        stopMonitoring('Export Stopped');
                    } else if (state === 'error') {
                        stopMonitoring('Export Error');
                    } else {
                        stopMonitoring('Export Finished');
                    }
                };

                // Ensure any remaining log chunks are pulled before we stop polling.
                fetchLog(token).then(finalize).catch(finalize);
                return;
            }

            if (!isMonitoring || token !== ehGetPollToken()) return;
            const delay = ehTunePollDelay();
            monitorTimer = setTimeout(() => monitorLoop(token), delay);
        })
        .catch((err) => {
            if (wpToHtmlData.debug) { console.error('[WP_TO_HTML_DEBUG] monitorLoop error:', err); }
            if (!isMonitoring || token !== ehGetPollToken()) return;
            const delay = ehClamp(Math.round(ehTunePollDelay() * 1.2), 3000, 20000);
            monitorTimer = setTimeout(() => monitorLoop(token), delay);
        });
}

function fetchStatus(token) {
    const t = (token === undefined || token === null) ? ehGetPollToken() : token;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    return fetch(withNoCache((wpToHtmlData.poll_url || wpToHtmlData.status_url)), {
        headers: { 'X-WP-Nonce': wpToHtmlData.nonce }
    })
        .then(safeJson)
        .then(data => {

            const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            ehLastStatusRttMs = Math.max(0, Math.round(t1 - t0));

            if (!data) data = {};

            // Ignore stale responses (e.g., a slow /poll that returns after a new run starts).
            if (t !== ehGetPollToken()) return data;

            let percent = 0;
            const totalUrls = Number(data.total_urls || 0);
            const doneUrls = Number(data.processed_urls || 0);
            const failedUrls = Number(data.failed_urls || 0);
            const totalAssets = Number(data.total_assets || 0);
            const doneAssets = Number(data.processed_assets || 0);
            const failedAssets = Number(data.failed_assets || 0);

            // Progress reflects BOTH URL exports and asset downloads.
            // This prevents the UI from saying "Export Finished" while assets are still pending.
            const totalWork = totalUrls + totalAssets;
            const doneWork = (doneUrls + failedUrls) + (doneAssets + failedAssets);
            if (totalWork > 0) {
                percent = Math.round((doneWork / totalWork) * 100);
            }

            // Store counts so fetchLog can derive live progress from log lines.
            ehLastStatusCounts = { totalUrls, doneUrls, failedUrls, totalAssets, doneAssets, failedAssets, state: ehNormalizeUiState(data.state || '') };

            // Display-friendly state (map transitional states to "running").
            const displayState = data.state ? ehNormalizeUiState(data.state) : '';
            jQuery('#wp-to-html-result').html(
                'Progress: ' + percent + '% (URLs ' + (doneUrls + failedUrls) + '/' + totalUrls + ', Assets ' + (doneAssets + failedAssets) + '/' + totalAssets + ')' +
                (displayState ? ' — State: ' + displayState : '')
            );

            // Show ZIP-creating notice during wrapup stage (all exported, ZIP being built).
            if (String(data.pipeline_stage || '') === 'wrapup' && ehNormalizeUiState(data.state || '') === 'running') {
                jQuery('#eh-zip-notice').show();
            } else {
                jQuery('#eh-zip-notice').hide();
            }

            // Toggle run controls based on current state.
            // Fix: avoid UI flicker where Pause/Stop briefly disappear if the backend
            // momentarily returns an empty/idle state during polling.
            // While monitoring AND the backend reports it is running, keep the last-known
            // non-idle state (running/paused) instead of switching to idle.
            const rawState = ehNormalizeUiState(data.state || '');
            const backendRunning = Number(data.is_running || 0) === 1;
            const lastUiState = String(ehLastBackendState || '').toLowerCase();
            let uiState = rawState || 'idle';

            if (isMonitoring && backendRunning) {
                if (!rawState || rawState === 'idle') {
                    // Prefer last known active state, default to running.
                    if (lastUiState === 'paused' || lastUiState === 'running') {
                        uiState = lastUiState;
                    } else {
                        uiState = 'running';
                    }
                }
            }

            setRunControlsVisibility(uiState);
            if (wpToHtmlData.debug) { console.log('[WP_TO_HTML_DEBUG] uiState:', uiState); }

            // ✅ Keep Start button disabled + loader visible for the entire run.
            // Use uiState (flicker-free) so Start doesn't re-enable briefly.
            syncStartUiToBackendState(uiState);

            // Outputs availability comes from lightweight /poll (preferred) or fallback to doneUrls>0.
            const hasOutputs = Number(data.has_outputs || 0) === 1 || doneUrls > 0;
            ehHasExports = hasOutputs;
            const $previewBtn = jQuery('#eh-preview');
            if (hasOutputs) {
                $previewBtn.prop('disabled', false);
            } else {
                // keep disabled until any outputs exist
                $previewBtn.prop('disabled', true);
            }
            // Keep #wp-to-html-result-extra in sync with pause/resume transitions.
            // (Users expect an immediate visible state hint beyond the progress line.)
            const newState = ehNormalizeUiState(uiState || '');
            const prevState = String(ehLastBackendState || '').toLowerCase();
            if (newState && newState !== prevState) {
                if (newState === 'paused') {
                    jQuery('#wp-to-html-result-extra').html('<strong>Export Paused</strong>');
                } else if (newState === 'running') {
                    // Only show "Resumed" if we were previously paused.
                    if (prevState === 'paused') {
                        jQuery('#wp-to-html-result-extra').html('<strong>Export Resumed</strong>');
                    } else {
                        // Keep it minimal on first start; progress line already updates.
                        jQuery('#wp-to-html-result-extra').html('');
                    }
                } else if (newState === 'stopped') {
                    jQuery('#wp-to-html-result-extra').html('<strong>Export Stopped</strong>');
                } else if (newState === 'error') {
                    jQuery('#wp-to-html-result-extra').html('<strong>Export Error</strong>');
                    // Report export failure silently.
                    (function() {
                        var p = {
                            site_url: (window.wpToHtmlData && wpToHtmlData.site_url) ? wpToHtmlData.site_url : window.location.origin,
                            status: 'error',
                            plugin_version: (typeof eh_plugin_version !== 'undefined') ? eh_plugin_version : '',
                            wp_version: (typeof eh_wp_version !== 'undefined') ? eh_wp_version : ''
                        };
                        jQuery.ajax({ url: 'https://api.myrecorp.com/wpptsh-report.php?type=error_log', method: 'POST', contentType: 'application/json', data: JSON.stringify(p), timeout: 5000 });
                    })();
                } else if (newState === 'completed') {
                    jQuery('#wp-to-html-result-extra').html('<strong>Export Finished</strong>');
                }
            }
            ehLastBackendState = newState;

            return data;
        });
}

// Returns the full plain-text content of the log element, including text inside spans.
// Used instead of el.textContent so we can do regex on it without destroying DOM nodes.
function ehLogText(el) {
    let text = '';
    el.childNodes.forEach(function(node) {
        text += node.textContent || '';
    });
    return text;
}

// Removes only TEXT_NODE children from el, preserving <span> elements (ZIP link spans etc.)
function ehStripTextNodes(el) {
    Array.from(el.childNodes).forEach(function(node) {
        if (node.nodeType === Node.TEXT_NODE) el.removeChild(node);
    });
}

// Replaces text content inside TEXT_NODE children only, leaving span nodes intact.
function ehReplaceInTextNodes(el, regex, replacement) {
    Array.from(el.childNodes).forEach(function(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            node.textContent = node.textContent.replace(regex, replacement);
        }
    });
}

// Returns true if a ZIP link for this filename already exists in the log.
function ehZipLinkExists(el, fileName) {
    return Array.from(el.querySelectorAll('a[download]'))
        .some(function(a) { return a.getAttribute('download') === fileName; });
}

function fetchLog(token) {
    const t = (token === undefined || token === null) ? ehGetPollToken() : token;
    return fetch(withNoCache(wpToHtmlData.log_url), {
        headers: { 'X-WP-Nonce': wpToHtmlData.nonce }
    })
        .then(safeJson)
        .then(data => {
            if (!data || !('log' in data)) return;

            // Ignore stale responses from a previous UI epoch.
            if (t !== ehGetPollToken()) return;

            const $logBox = jQuery('#wp-to-html-log');
            const el = $logBox.get(0);
            if (!el) return;

            // Append without injecting extra <br> or newlines.
            // The backend already returns newline-separated lines.
            const chunk = (data.log || '');
            if (chunk) {
                // Prevent chunk-boundary gaps if any leading blank lines slip through.
                const cleaned = chunk.replace(/^\s*\r?\n+/, '');
                
                // Replace the most recent "Assets progress:" line instead of appending duplicates.
                // Backend sends newline-separated incremental chunks; we normalize by lines.
                const lines = cleaned.split(/\r?\n/);
                const nonProgress = [];
                const progress = [];
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (!line) continue;
                    if (line.indexOf('Assets progress:') !== -1) {
                        progress.push(line);
                    } else {
                        nonProgress.push(line);
                    }
                }
                
                if (progress.length) {
                    const latest = progress[progress.length - 1];

                    // Live progress: parse "Assets progress: X/Y" and update #wp-to-html-result
                    // when the log is ahead of the last DB value from fetchStatus.
                    if (isMonitoring) {
                        const pm = latest.match(/Assets progress:\s*(\d+)\/(\d+)/);
                        if (pm) {
                            const logDone = parseInt(pm[1], 10);
                            const logTotal = parseInt(pm[2], 10);
                            const statusDone = ehLastStatusCounts.doneAssets + ehLastStatusCounts.failedAssets;
                            if (logDone > statusDone && logTotal > 0) {
                                const { doneUrls, failedUrls, totalUrls } = ehLastStatusCounts;
                                const totalWork = totalUrls + logTotal;
                                const doneWork = (doneUrls + failedUrls) + logDone;
                                const pct = totalWork > 0 ? Math.round((doneWork / totalWork) * 100) : 0;
                                const st = ehLastStatusCounts.state || 'running';
                                jQuery('#wp-to-html-result').html(
                                    'Progress: ' + pct + '% (URLs ' + (doneUrls + failedUrls) + '/' + totalUrls + ', Assets ' + logDone + '/' + logTotal + ')' +
                                    ' \u2014 State: ' + st
                                );
                            }
                        }
                    }

                    // If we've already printed finalization lines, ignore any late "Assets progress" ticks.
                    const currentText = el.textContent || '';
                    const chunkHasFinalize = nonProgress.some(l => /Assets finished\.|ZIP created:|URLs exported:|Assets downloaded:/i.test(l));
                    const alreadyFinalized = /Assets finished\.|ZIP created:|URLs exported:|Assets downloaded:/i.test(currentText);

                    if (alreadyFinalized || chunkHasFinalize) {
                        // Drop progress lines entirely; append only the non-progress lines (if any).
                        if (nonProgress.length) {
                            const zipLineRe3 = /^(\[\d\d:\d\d:\d\d\] (?:ZIP part \d+\/\d+|ZIP created)): (.+\.zip)(?: \((.+)\))?$/;
                            let plainBuf = '';
                            nonProgress.forEach(function(npLine) {
                                const zm = npLine.match(zipLineRe3);
                                if (zm && !ehZipLinkExists(el, zm[2])) {
                                    if (plainBuf) { el.appendChild(document.createTextNode(plainBuf)); plainBuf = ''; }
                                    const span = document.createElement('span');
                                    const dlUrl = wpToHtmlData.download_url + '?_wpnonce=' + encodeURIComponent(wpToHtmlData.nonce);
                                    span.innerHTML = zm[1] + ': <a href="' + dlUrl + '" download="' + escapeHtml(zm[2]) + '" style="font-weight:600;text-decoration:underline;">' + escapeHtml(zm[2]) + '</a>' + (zm[3] ? ' (' + escapeHtml(zm[3]) + ')' : '') + '\n';
                                    el.appendChild(span);
                                } else if (!zm) {
                                    plainBuf += npLine + '\n';
                                }
                            });
                            if (plainBuf) el.appendChild(document.createTextNode(plainBuf));
                        }
                    } else {
                        // Remove any existing asset progress lines from the log (keep everything else).
                        // Use DOM-safe helpers so ZIP link <span> nodes are preserved.
                        ehReplaceInTextNodes(el, /^\[\d\d:\d\d:\d\d\].*Assets progress:.*\r?\n?/gm, '');

                        let add = '';
                        if (nonProgress.length) {
                            // ZIP lines in nonProgress must be rendered as links, not plain text.
                            const zipLineRe2 = /^(\[\d\d:\d\d:\d\d\] (?:ZIP part \d+\/\d+|ZIP created)): (.+\.zip)(?: \((.+)\))?$/;
                            nonProgress.forEach(function(npLine) {
                                const zm = npLine.match(zipLineRe2);
                                if (zm && !ehZipLinkExists(el, zm[2])) {
                                    const span = document.createElement('span');
                                    const dlUrl = wpToHtmlData.download_url + '?_wpnonce=' + encodeURIComponent(wpToHtmlData.nonce);
                                    span.innerHTML = zm[1] + ': <a href="' + dlUrl + '" download="' + escapeHtml(zm[2]) + '" style="font-weight:600;text-decoration:underline;">' + escapeHtml(zm[2]) + '</a>' + (zm[3] ? ' (' + escapeHtml(zm[3]) + ')' : '') + '\n';
                                    el.appendChild(span);
                                } else if (!zm) {
                                    add += npLine + '\n';
                                }
                            });
                        }
                        add += latest + '\n';
                        el.appendChild(document.createTextNode(add));
                    }
                } else {
                    // No progress lines in this chunk: append as usual.
                    // But intercept ZIP lines to render as clickable download links.
                    const zipLineRe = /^(\[\d\d:\d\d:\d\d\] (?:ZIP part \d+\/\d+|ZIP created)): (.+\.zip)(?: \((.+)\))?$/;
                    const cleanedLines = cleaned.split(/\r?\n/);
                    let buffer = '';
                    cleanedLines.forEach(function(line) {
                        const m = line.match(zipLineRe);
                        if (m) {
                            if (buffer) { el.appendChild(document.createTextNode(buffer)); buffer = ''; }
                            // Skip if already rendered as a link — guards against second fetchLog call
                            // re-delivering the same ZIP line from the log file cursor.
                            if (ehZipLinkExists(el, m[2])) return;
                            const prefix   = m[1];
                            const fileName = m[2];
                            const meta     = m[3] || '';
                            const dlUrl    = wpToHtmlData.download_url + '?_wpnonce=' + encodeURIComponent(wpToHtmlData.nonce);
                            const span = document.createElement('span');
                            span.innerHTML = prefix + ': <a href="' + dlUrl +
                                '" download="' + escapeHtml(fileName) +
                                '" style="font-weight:600;text-decoration:underline;">' +
                                escapeHtml(fileName) + '</a>' +
                                (meta ? ' (' + escapeHtml(meta) + ')' : '') + '\n';
                            el.appendChild(span);
                        } else {
                            buffer += line + '\n';
                        }
                    });
                    if (buffer) { el.appendChild(document.createTextNode(buffer)); }
                }
                
                el.scrollTop = el.scrollHeight;
            }

            // If backend indicates more lines are available (chunked response), drain immediately.
            if (data.has_more) {
                //return fetchLog(token);
            }
        })
        .catch(err => {
            if (wpToHtmlData.debug) { console.warn('[WP_TO_HTML_DEBUG] fetchLog error:', err); }
        });
}

// Client-side (optimistic) log lines: immediate UI feedback while the REST
// start-export request is still in-flight.
function appendClientLog(msg, isHtml) {
    const $logBox = jQuery('#wp-to-html-log');
    const el = $logBox.get(0);
    if (!el) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    if (isHtml) {
        // Use a span so HTML links render; add line break after
        const span = document.createElement('span');
        span.innerHTML = `[${hh}:${mm}:${ss}] ` + msg + '\n';
        el.appendChild(span);
    } else {
        const line = `[${hh}:${mm}:${ss}] ${msg}\n`;
        el.appendChild(document.createTextNode(line));
    }
    el.scrollTop = el.scrollHeight;
}

// Ensure the log shows a clear end-of-run summary even if the final backend
// lines were written right at completion and the UI stops polling quickly.
function ehAppendCompletionSummary(status, exportsData) {
    try {
        const st = status || {};
        const totalUrls = Number(st.total_urls || 0);
        const doneUrls = Number(st.processed_urls || 0);
        const failedUrls = Number(st.failed_urls || 0);
        const totalAssets = Number(st.total_assets || 0);
        const doneAssets = Number(st.processed_assets || 0);
        const failedAssets = Number(st.failed_assets || 0);

        // Avoid duplicating if the backend already printed these lines.
        const txt = (jQuery('#wp-to-html-log').text() || '').toLowerCase();
        const hasSuccess = txt.indexOf('export has been completed successfully') !== -1;

        // We rely on the backend to emit terminal URL/asset counts to avoid race-condition duplicates here.

        // const zipFile = exportsData && exportsData.zip && exportsData.zip.file ? String(exportsData.zip.file) : '';
        // const zipParts = (exportsData && Array.isArray(exportsData.zip_parts)) ? exportsData.zip_parts : [];

        // // Always inject rich HTML zip links. First, strip any plain-text ZIP lines
        // // the backend may have already streamed into the log, so we don't get duplicates.
        // const $logBox = jQuery('#wp-to-html-log');
        // const logEl = $logBox.get(0);
        // if (logEl) {
        //     // Walk child nodes and remove plain-text nodes that contain backend ZIP lines.
        //     // These are raw TextNode children written by the streaming log handler.
        //     const toRemove = [];
        //     logEl.childNodes.forEach(function(node) {
        //         if (node.nodeType === Node.TEXT_NODE && /zip created:|zip part \d/i.test(node.textContent)) {
        //             toRemove.push(node);
        //         }
        //         // Also remove <span> nodes already injected by a previous appendClientLog ZIP call
        //         if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'SPAN' && /zip created:|zip part \d/i.test(node.textContent)) {
        //             toRemove.push(node);
        //         }
        //     });
        //     toRemove.forEach(function(n) { logEl.removeChild(n); });
        // }

        // // Check again after cleanup whether a rich link was already injected (page reload case)
        // const hasZipLink = !!($logBox.find('a[download]').length);

        // if (!hasZipLink) {
        //     if (zipParts.length >= 1) {
        //         if (zipParts.length > 1) {
        //             appendClientLog('ZIP created: ' + zipParts.length + ' part(s) ready for download.');
        //         }
        //         zipParts.forEach(function(zi) {
        //             const dlUrl = wpToHtmlData.download_url + '?part=' + zi.part + '&_wpnonce=' + encodeURIComponent(wpToHtmlData.nonce);
        //             const fileName = zi.file || ('export-part' + zi.part + '.zip');
        //             const fileSize = zi.size ? formatFileSize(zi.size) : '';
        //             const fileCount = zi.file_count ? zi.file_count + ' files' : '';
        //             const meta = [fileCount, fileSize].filter(Boolean).join(', ');
        //             const label = zipParts.length > 1 ? ('ZIP part ' + zi.part + '/' + zi.total_parts) : 'ZIP created';
        //             appendClientLog(
        //                 label + ': <a href="' + dlUrl + '" download="' + escapeHtml(fileName) + '" style="font-weight:600;text-decoration:underline;">' + escapeHtml(fileName) + '</a>' + (meta ? ' (' + meta + ')' : ''),
        //                 true
        //             );
        //         });
        //         if (zipParts.length > 1) {
        //             appendClientLog(
        //                 '&#9432; Extract all ZIP parts into the <strong>same folder</strong> to get a complete, working site.',
        //                 true
        //             );
        //         }
        //     } else if (zipFile) {
        //         const singleZip = exportsData && exportsData.zip ? exportsData.zip : null;
        //         const singleDlUrl = wpToHtmlData.download_url + '?_wpnonce=' + encodeURIComponent(wpToHtmlData.nonce);
        //         const singleSize = singleZip && singleZip.size ? formatFileSize(singleZip.size) : '';
        //         appendClientLog(
        //             'ZIP created: <a href="' + singleDlUrl + '" download="' + escapeHtml(zipFile) + '" style="font-weight:600;text-decoration:underline;">' + escapeHtml(zipFile) + '</a>' + (singleSize ? ' (' + singleSize + ')' : ''),
        //             true
        //         );
        //     } else {
        //         appendClientLog('ZIP status: not found in /exports. This usually means no URLs were exported — check the export scope and selected items, or see server logs for details.');
        //     }
        // }

        if (!hasSuccess) {
            appendClientLog('Export has been completed successfully.');
        }
        // Remove any lingering heartbeat lines so the log ends cleanly on summaries.
        const $box = jQuery('#wp-to-html-log');
        const el = $box.get(0);
        if (el) {
            // Strip progress lines from text nodes only — never reassign el.textContent
            // as that destroys child <span> elements (ZIP download links).
            ehReplaceInTextNodes(el, /^\[\d\d:\d\d:\d\d\].*Assets progress:.*\r?\n?/gm, '');
            ehReplaceInTextNodes(el, /^\[\d\d:\d\d:\d\d\].*URLs progress:.*\r?\n?/gm, '');
        }
    } catch (e) {
        // Never break UI due to summary logging.
    }
}

async function ehResetServerLog() {
  try {
    await fetch(EH.rest + '/log-reset', {
      method: 'POST',
      headers: {
        'X-WP-Nonce': EH.nonce
      }
    });
  } catch (e) {
    // ignore; UI will still show client logs
  }
}



function fetchExports() {
    return fetch(wpToHtmlData.exports_url, {
        headers: { 'X-WP-Nonce': wpToHtmlData.nonce }
    })
        .then(safeJson);
}

function renderExportsPanel(data) {
    // Enable preview + download when available
    const $previewBtn = jQuery('#eh-preview');
    const $download = jQuery('#eh-download-zip');

    const zip = data && data.zip ? data.zip : null;
    const zipParts = (data && Array.isArray(data.zip_parts) && data.zip_parts.length) ? data.zip_parts : (zip ? [zip] : []);

    // Build download section: #eh-download-zip handles all cases
    if (zipParts.length === 1) {
        const dlUrl = wpToHtmlData.download_url + '?_wpnonce=' + encodeURIComponent(wpToHtmlData.nonce);
        $download
            .attr('href', dlUrl)
            .off('click.ehMultiZip')
            .show()
            .text('Download ZIP File');
        jQuery('#eh-multizip-container').remove();
    } else if (zipParts.length > 1) {
        // Main button downloads ALL parts sequentially
        $download
            .attr('href', '#')
            .show()
            .text('\u2b07 Download All ZIPs (' + zipParts.length + ')')
            .off('click.ehMultiZip')
            .on('click.ehMultiZip', function(e) {
                e.preventDefault();
                zipParts.forEach(function(zi, idx) {
                    setTimeout(function() {
                        const dlUrl = wpToHtmlData.download_url + '?part=' + zi.part + '&_wpnonce=' + encodeURIComponent(wpToHtmlData.nonce);
                        const a = document.createElement('a');
                        a.href = dlUrl;
                        a.download = zi.file || ('export-part' + zi.part + '.zip');
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                    }, idx * 800);
                });
            });

        // Individual part buttons
        jQuery('#eh-multizip-container').remove();
        const $container = jQuery('<div id="eh-multizip-container" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;"></div>');
        zipParts.forEach(function(zi) {
            const dlUrl = wpToHtmlData.download_url + '?part=' + zi.part + '&_wpnonce=' + encodeURIComponent(wpToHtmlData.nonce);
            const $btn = jQuery('<a class="button" style="font-size:11px;padding:2px 8px;"></a>')
                .attr('href', dlUrl)
                .attr('download', zi.file || '')
                .text('Part ' + zi.part + '/' + zi.total_parts);
            $container.append($btn);
        });

        // Extract notice
        const $notice = jQuery('<p id="eh-multizip-notice" style="margin:6px 0 0;font-size:12px;color:#856404;background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:5px 10px;display:inline-block;">&#9888; Extract all ZIP parts into the <strong>same folder</strong> to get a complete, working site.</p>');
        $container.append($notice);

        $download.after($container);
    } else {
        $download.hide().attr('href', '#').off('click.ehMultiZip');
        jQuery('#eh-multizip-container').remove();
    }

    // Build preview list + tabs
    const files = (data && data.files) ? data.files : [];

    // Track availability for UI visibility rules
    ehHasExports = Array.isArray(files) && files.length > 0;

    // Prefer direct public URLs (served by the web server under wp-content/wp-to-html-exports)
    // when available; otherwise fallback to REST-based preview.
    const previewConfig = {
        mode: (data && data.public_base_url) ? 'public' : 'rest',
        base: (data && data.public_base_url)
            ? data.public_base_url
            : ((data && data.preview_base) ? data.preview_base : wpToHtmlData.exports_url.replace('exports','preview?path='))
    };

    const $tabs = jQuery('#eh-preview-tabs');
    const $groupDownload = jQuery('#eh-preview-download-group');

    const groups = groupExportFiles(files);
    const groupKeys = Object.keys(groups);

    if (files.length && groupKeys.length) {
        $previewBtn.prop('disabled', false);
        $previewBtn.show();

        // Tabs
        const defaultKey = groupKeys[0];
        const tabHtml = groupKeys.map(k => {
            const label = groups[k].label;
            const count = groups[k].files.length;
            return `<div class="eh-tab" data-key="${escapeHtml(k)}">${escapeHtml(label)} <span class="eh-count">${count}</span></div>`;
        }).join('');
        $tabs.html(tabHtml);

        // Click handler
        $tabs.off('click.ehTabs').on('click.ehTabs', '.eh-tab', function(){
            const key = String(jQuery(this).data('key') || '');
            setActivePreviewGroup(key, groups, previewConfig, $groupDownload);
        });

        // Render default
        setActivePreviewGroup(defaultKey, groups, previewConfig, $groupDownload);

    } else {
        $previewBtn.prop('disabled', true);
        // If no outputs, keep Preview hidden when idle.
        if (!isMonitoring) $previewBtn.hide();
        $tabs.empty();
        $groupDownload.hide().attr('href', '#');
        jQuery('#eh-preview-list').html('<div class="eh-muted" style="padding:10px;">No exported files found.</div>');
    }

    // Ensure buttons reflect latest state/output
    setRunControlsVisibility('completed');
}

function groupExportFiles(files) {
    const make = (label) => ({ label, files: [] });

    const groups = {
        html: make('HTML'),
        images: make('Images'),
        css: make('CSS'),
        js: make('JS'),
        audios: make('Audios'),
        videos: make('Videos'),
        docs: make('Docs'),
        fonts: make('Fonts'),
        other: make('Other')
    };

    const imgExt = new Set(['png','jpg','jpeg','gif','webp','svg','ico','avif']);
    const audioExt = new Set(['mp3','wav','ogg','m4a','aac','flac','opus']);
    const videoExt = new Set(['mp4','webm','mov','mkv','m4v','avi']);
    const docExt = new Set(['pdf','doc','docx','xls','xlsx','ppt','pptx','csv','txt','md','rtf']);
    const fontExt = new Set(['woff','woff2','ttf','otf','eot']);

    (files || []).forEach(f => {
        const p = String(f.path || '');
        const ext = (p.split('.').pop() || '').toLowerCase();

        if (ext === 'html' || ext === 'htm') groups.html.files.push(f);
        else if (ext === 'css') groups.css.files.push(f);
        else if (ext === 'js') groups.js.files.push(f);
        else if (imgExt.has(ext)) groups.images.files.push(f);
        else if (audioExt.has(ext)) groups.audios.files.push(f);
        else if (videoExt.has(ext)) groups.videos.files.push(f);
        else if (docExt.has(ext)) groups.docs.files.push(f);
        else if (fontExt.has(ext)) groups.fonts.files.push(f);
        else groups.other.files.push(f);
    });

    // Only keep non-empty groups (as requested)
    const out = {};
    Object.keys(groups).forEach(k => {
        if (groups[k].files.length) out[k] = groups[k];
    });
    return out;
}

function encodePathPreserveSlashes(path) {
    // Encode each segment but keep directory separators.
    return String(path || '')
        .split('/')
        .map(seg => encodeURIComponent(seg))
        .join('/');
}

// ── Preview pagination state ──────────────────────────────
const EH_PAGE_SIZE = 50;
const ehPreviewState = { key: null, groups: null, previewConfig: null, $groupDownload: null, page: 1 };

function setActivePreviewGroup(key, groups, previewConfig, $groupDownload) {
    const $tabs = jQuery('#eh-preview-tabs');

    if (!groups || !groups[key]) {
        const keys = Object.keys(groups || {});
        if (!keys.length) return;
        key = keys[0];
    }

    // Active tab — reset to page 1 whenever the group changes
    const groupChanged = ehPreviewState.key !== key;
    $tabs.find('.eh-tab').removeClass('is-active');
    $tabs.find(`.eh-tab[data-key="${cssEscape(key)}"]`).addClass('is-active');

    // Persist state so pagination buttons can re-call
    ehPreviewState.key = key;
    ehPreviewState.groups = groups;
    ehPreviewState.previewConfig = previewConfig;
    ehPreviewState.$groupDownload = $groupDownload;
    if (groupChanged) ehPreviewState.page = 1;

    renderPreviewPage(ehPreviewState.page);

    // Group ZIP download
    const dlUrl = wpToHtmlData.download_url + '?group=' + encodeURIComponent(key) + '&_wpnonce=' + encodeURIComponent(wpToHtmlData.nonce);
    $groupDownload.attr('href', dlUrl).show().text(`Download ${groups[key].label} as ZIP`);
}

function renderPreviewPage(page) {
    const { key, groups, previewConfig } = ehPreviewState;
    if (!key || !groups || !groups[key]) return;

    const $list   = jQuery('#eh-preview-list');
    const $pager  = jQuery('#eh-preview-pagination');
    const $nums   = jQuery('#eh-page-numbers');
    const $info   = jQuery('#eh-page-info');

    const allFiles = groups[key].files || [];
    const total    = allFiles.length;
    const totalPages = Math.max(1, Math.ceil(total / EH_PAGE_SIZE));
    page = Math.min(Math.max(1, page), totalPages);
    ehPreviewState.page = page;

    const start  = (page - 1) * EH_PAGE_SIZE;
    const slice  = allFiles.slice(start, start + EH_PAGE_SIZE);

    const base = (previewConfig && previewConfig.base) ? String(previewConfig.base) : '';
    const mode = (previewConfig && previewConfig.mode) ? String(previewConfig.mode) : 'rest';

    // Build list rows
    const html = slice.map(f => {
        const p   = String(f.path || '');
        const enc = (mode === 'public') ? encodePathPreserveSlashes(p) : encodeURIComponent(p);
        const url = (mode === 'public')
            ? (base + enc)
            : (base + enc + '&_wpnonce=' + encodeURIComponent(wpToHtmlData.nonce));
        const fileSize = formatFileSize(Number(f.size || 0));
        return `<div class="eh-preview-item">
            <a href="${url}" target="_blank" rel="noopener">${escapeHtml(p)}</a>
            <div class="eh-muted">${fileSize}</div>
        </div>`;
    }).join('');

    $list.html(html || '<div class="eh-muted" style="padding:10px;">No files in this group.</div>');

    // Scroll list to top smoothly on page change
    $list[0] && ($list[0].scrollTop = 0);

    // Pagination controls
    if (totalPages <= 1) {
        $pager.hide();
        return;
    }
    $pager.show();

    // Prev / Next / First / Last
    jQuery('#eh-page-first').prop('disabled', page === 1);
    jQuery('#eh-page-prev').prop('disabled',  page === 1);
    jQuery('#eh-page-next').prop('disabled',  page === totalPages);
    jQuery('#eh-page-last').prop('disabled',  page === totalPages);

    // Page number buttons — show up to 7 around current page
    const window_ = 2; // pages each side of current
    let pStart = Math.max(1, page - window_);
    let pEnd   = Math.min(totalPages, page + window_);
    // Keep a consistent 5-button window
    if (pEnd - pStart < window_ * 2) {
        if (pStart === 1) pEnd = Math.min(totalPages, pStart + window_ * 2);
        else pStart = Math.max(1, pEnd - window_ * 2);
    }

    let numHtml = '';
    if (pStart > 1)        numHtml += `<button class="eh-page-num" data-p="1">1</button>${pStart > 2 ? '<span class="eh-page-ellipsis">…</span>' : ''}`;
    for (let i = pStart; i <= pEnd; i++) {
        numHtml += `<button class="eh-page-num${i === page ? ' is-active' : ''}" data-p="${i}">${i}</button>`;
    }
    if (pEnd < totalPages) numHtml += `${pEnd < totalPages - 1 ? '<span class="eh-page-ellipsis">…</span>' : ''}<button class="eh-page-num" data-p="${totalPages}">${totalPages}</button>`;

    $nums.html(numHtml);

    // Info text: "Showing 51–100 of 50,000"
    const from = start + 1;
    const to   = Math.min(start + EH_PAGE_SIZE, total);
    $info.text(`Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`);
}

// Wire pagination button clicks (delegated, set up once)
jQuery(document).on('click', '#eh-page-first', () => renderPreviewPage(1));
jQuery(document).on('click', '#eh-page-prev',  () => renderPreviewPage(ehPreviewState.page - 1));
jQuery(document).on('click', '#eh-page-next',  () => renderPreviewPage(ehPreviewState.page + 1));
jQuery(document).on('click', '#eh-page-last',  () => {
    const { key, groups } = ehPreviewState;
    if (!key || !groups || !groups[key]) return;
    renderPreviewPage(Math.ceil((groups[key].files || []).length / EH_PAGE_SIZE));
});
jQuery(document).on('click', '#eh-page-numbers .eh-page-num', function() {
    renderPreviewPage(parseInt(jQuery(this).data('p'), 10));
});


function debounce(fn, delay) {
    let t = null;
    return function (...args) {
        if (t) clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), delay);
    };
}

jQuery(function ($) {

    // Tabs (Export / Settings)
    function showPanel(which) {
        const isExport = which === 'export';
        $('#eh-tab-export').attr('aria-pressed', isExport ? 'true' : 'false');
        $('#eh-tab-settings').attr('aria-pressed', isExport ? 'false' : 'true');
        // Toggle entire grid vs full-width settings page
        $('.eh-grid').toggle(isExport);
        $('#eh-panel-settings').toggle(!isExport);

        if (!isExport) {
            ftpMsg('');
            loadFtpSettings();
            // Default to FTP settings tab.
            if (typeof setSettingsTab === 'function') {
                setSettingsTab('ftp');
            }
        }
    }
    $('#eh-tab-export').on('click', () => showPanel('export'));
    $('#eh-tab-settings').on('click', () => showPanel('settings'));

    // FTP browser modal
    wireFtpBrowserEvents();

    $('#wp-to-html-ftp-remote-browse').on('click', function () {
        const current = String($('#wp-to-html-ftp-remote-path').val() || '').trim() || (String(ehFtpSettingsCache?.default_path || '').trim() || '/');
        // export tab uses saved settings (no password in browser)
        openFtpBrowser('#wp-to-html-ftp-remote-path', current, 'saved');
    });

    $('#wp-to-html-ftp-default-browse').on('click', function () {
        const current = String($('#wp-to-html-ftp-default-path').val() || '').trim() || '/';
        // settings tab prefers form values (so user can browse before saving), falls back to saved pass if host/user match
        openFtpBrowser('#wp-to-html-ftp-default-path', current, 'form');
    });

    // Delivery options toggles
    function syncDeliveryUi() {
        const up = $('#wp-to-html-upload-ftp').is(':checked');
        $('#wp-to-html-ftp-remote-wrap').toggle(up);

        const s3 = $('#wp-to-html-upload-s3').is(':checked');
        $('#wp-to-html-s3-prefix-wrap').toggle(s3);

        const nt = $('#wp-to-html-notify-complete').is(':checked');
        $('#wp-to-html-notify-emails-wrap').toggle(nt);
    }
    $('#wp-to-html-upload-ftp, #wp-to-html-upload-s3, #wp-to-html-notify-complete').on('change', syncDeliveryUi);
    syncDeliveryUi();

    // FTP save/test
    $('#wp-to-html-ftp-save').on('click', async function () {
        setFtpBusy(true);
        ftpMsg('Saving…');
        try {
            const payload = readFtpForm();
            const res = await fetch(wpToHtmlData.ftp_settings_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': wpToHtmlData.nonce },
                body: JSON.stringify(payload)
            });
            const data = await safeJson(res);
            if (data?.ok) {
                ftpMsg('<strong>Saved.</strong>');
            } else {
                ftpMsg('<strong>Save failed.</strong> ' + escapeHtml(data?.message || ''), true);
            }
        } catch (e) {
            if (wpToHtmlData.debug) { console.error('[WP_TO_HTML_DEBUG] FTP save error:', e); }
            ftpMsg('<strong>Save failed.</strong> ' + escapeHtml(String(e.message || e)), true);
        }
        setFtpBusy(false);
    });

    $('#wp-to-html-ftp-test').on('click', async function () {
        setFtpBusy(true);
        ftpMsg('Testing…');
        try {
            // Send form values, so user can test without saving.
            const payload = readFtpForm();
            const res = await fetch(wpToHtmlData.ftp_test_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': wpToHtmlData.nonce },
                body: JSON.stringify(payload)
            });
            const data = await safeJson(res);
            if (data?.ok) {
                ftpMsg('<strong>Connected.</strong> ' + escapeHtml(data?.message || 'OK'));
            } else {
                ftpMsg('<strong>Connection failed.</strong> ' + escapeHtml(data?.message || ''), true);
            }
        } catch (e) {
            if (wpToHtmlData.debug) { console.error('[WP_TO_HTML_DEBUG] FTP test error:', e); }
            ftpMsg('<strong>Connection failed.</strong> ' + escapeHtml(String(e.message || e)), true);
        }
        setFtpBusy(false);
    });

    // Settings tabs (FTP | AWS S3 | PDF | HTML Button)
    function setSettingsTab(which) {
        const isFtp     = which === 'ftp';
        const isS3      = which === 's3';
        const isPdf     = which === 'pdf';
        const isHtmlBtn = which === 'html-btn';

        $('#eh-settings-tab-ftp').attr('aria-pressed', isFtp ? 'true' : 'false').toggleClass('is-active', isFtp);
        $('#eh-settings-tab-s3').attr('aria-pressed', isS3 ? 'true' : 'false').toggleClass('is-active', isS3);
        $('#eh-settings-tab-pdf').attr('aria-pressed', isPdf ? 'true' : 'false').toggleClass('is-active', isPdf);
        $('#eh-settings-tab-html-btn').attr('aria-pressed', isHtmlBtn ? 'true' : 'false').toggleClass('is-active', isHtmlBtn);

        $('#eh-settings-panel-ftp').toggle(isFtp);
        $('#eh-settings-panel-s3').toggle(isS3);
        $('#eh-settings-panel-pdf').toggle(isPdf);
        $('#eh-settings-panel-html-btn').toggle(isHtmlBtn);

        if (isS3) fetchS3Settings();
    }
    $('#eh-settings-tab-ftp').on('click', () => setSettingsTab('ftp'));
    $('#eh-settings-tab-s3').on('click', () => {
        if (!Number(wpToHtmlData?.pro_active || 0)) return;
        setSettingsTab('s3');
    });
    $('#eh-settings-tab-pdf').on('click', () => setSettingsTab('pdf'));
    $('#eh-settings-tab-html-btn').on('click', () => setSettingsTab('html-btn'));

    // ── PDF Settings: Save ────────────────────────────────────────────────────
    function pdfMsg(html, isError = false) {
        const $m = $('#wth-pdf-settings-msg');
        $m.html(html).css('color', isError ? '#e53e3e' : '#38a169').show();
        setTimeout(() => $m.fadeOut(), 4000);
    }
    function setPdfBusy(isBusy) {
        $('#wth-pdf-settings-spinner').toggleClass('is-active', !!isBusy);
        $('#wth-pdf-settings-save').prop('disabled', !!isBusy);
    }

    $('#wth-pdf-settings-save').on('click', async function () {
        setPdfBusy(true);
        const roles = [];
        $('.wth-pdf-role-chk:checked').each(function () { roles.push($(this).val()); });

        try {
            const resp = await fetch(typeof ajaxurl !== 'undefined' ? ajaxurl : (wpToHtmlData.site_url + 'wp-admin/admin-ajax.php'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'wp_to_html_save_pdf_settings',
                    nonce:  wpToHtmlData.nonce,
                    roles:  JSON.stringify(roles),
                }),
            });

            // wp_ajax handlers return text, not JSON sometimes.
            let data;
            try { data = await resp.json(); } catch(_) { data = { success: false }; }

            if (data.success) {
                pdfMsg('Settings saved.');
            } else {
                pdfMsg('Could not save settings. Please try again.', true);
            }
        } catch (err) {
            pdfMsg('Network error. Please try again.', true);
        }
        setPdfBusy(false);
    });

    // ── PDF shortcode copy button ─────────────────────────────────────────────
    $('#wth-pdf-copy-sc').on('click', function () {
        const el = document.getElementById('wth-pdf-shortcode');
        if (!el) return;
        el.select(); el.setSelectionRange(0, 99999);
        try { document.execCommand('copy'); } catch(_) {}
        const $msg = $('#wth-pdf-copy-msg');
        $msg.show();
        setTimeout(() => $msg.fadeOut(), 2000);
    });

    // ── HTML Button Settings: Save ────────────────────────────────────────────
    function htmlBtnMsg(html, isError = false) {
        const $m = $('#wth-html-btn-settings-msg');
        $m.html(html).css('color', isError ? '#e53e3e' : '#38a169').show();
        setTimeout(() => $m.fadeOut(), 4000);
    }
    function setHtmlBtnBusy(isBusy) {
        $('#wth-html-btn-settings-spinner').toggleClass('is-active', !!isBusy);
        $('#wth-html-btn-settings-save').prop('disabled', !!isBusy);
    }

    $('#wth-html-btn-settings-save').on('click', async function () {
        setHtmlBtnBusy(true);
        const roles = [];
        $('.wth-html-btn-role-chk:checked').each(function () { roles.push($(this).val()); });

        try {
            const resp = await fetch(typeof ajaxurl !== 'undefined' ? ajaxurl : (wpToHtmlData.site_url + 'wp-admin/admin-ajax.php'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'wp_to_html_save_export_html_btn_settings',
                    nonce:  wpToHtmlData.nonce,
                    roles:  JSON.stringify(roles),
                }),
            });

            let data;
            try { data = await resp.json(); } catch(_) { data = { success: false }; }

            if (data.success) {
                htmlBtnMsg('Settings saved.');
            } else {
                htmlBtnMsg('Could not save settings. Please try again.', true);
            }
        } catch (err) {
            htmlBtnMsg('Network error. Please try again.', true);
        }
        setHtmlBtnBusy(false);
    });

    // ── HTML Button shortcode copy button ─────────────────────────────────────
    $('#wth-html-btn-copy-sc').on('click', function () {
        const el = document.getElementById('wth-html-btn-shortcode');
        if (!el) return;
        el.select(); el.setSelectionRange(0, 99999);
        try { document.execCommand('copy'); } catch(_) {}
        const $msg = $('#wth-html-btn-copy-msg');
        $msg.show();
        setTimeout(() => $msg.fadeOut(), 2000);
    });


    // ── Remote Data: fetch live on every page load ────────────────────────────
    // In-memory cache so the fetch only runs once per page load even if
    // applyPricing() and ehRenderMorePlugins() are both called.
    var ehRemoteData     = null;   // null = not fetched yet, false = fetch failed
    var ehRemoteFetching = null;   // the single shared Promise

    function ehFetchRemoteData() {
        // Already resolved — return immediately
        if (ehRemoteData !== null) return Promise.resolve(ehRemoteData);
        // Fetch already in flight — return the same promise so all callers share it
        if (ehRemoteFetching) return ehRemoteFetching;

        var jsonUrl     = (window.wpToHtmlData && wpToHtmlData.remote_json_url)   ? wpToHtmlData.remote_json_url   : 'https://api.myrecorp.com/wp-to-html-plugins-data.php';

        function doFetch(url) {
            return fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store' })
                .then(function (res) {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res.json();
                });
        }

        // Build the base fetch promise and keep it in ehRemoteFetching.
        // We never null it out — once it resolves ehRemoteData is set,
        // so the early-return above handles subsequent calls.
        ehRemoteFetching = doFetch(jsonUrl)
            .catch(function () {
                return fallbackUrl ? doFetch(fallbackUrl) : Promise.reject('no fallback');
            })
            .then(function (data) {
                ehRemoteData = (data && typeof data === 'object') ? data : false;
                return ehRemoteData;
            })
            .catch(function () {
                ehRemoteData = false;
                return false;
            });

        return ehRemoteFetching;
    }

    // ── Dynamic Pricing ───────────────────────────────────────────────────────
    function ehApplyPricing(remote) {
        const pricing  = (remote && remote.pricing) ? remote.pricing : {};
        const oldPrice = parseFloat(pricing.old) || 39.99;
        const newPrice = parseFloat(pricing.new) || 15;
        const saving   = oldPrice - newPrice;
        const pct      = Math.round((saving / oldPrice) * 100);

        const fmt = function (n) { return '$' + n.toFixed(2).replace(/\.00$/, ''); };
        // ✅ Also fine if it's a single element
        var priceTag = document.querySelector('.eh-upgrade-price-tag');
        if (priceTag) priceTag.style.display = 'block';

        document.querySelectorAll('.eh-upgrade-old').forEach(function (el) { el.textContent = fmt(oldPrice); });
        document.querySelectorAll('.eh-upgrade-new').forEach(function (el) { el.textContent = fmt(newPrice); });
        document.querySelectorAll('.eh-upgrade-save').forEach(function (el) { el.textContent = pct + '% OFF'; });

        document.querySelectorAll('.eh-modal-price-old').forEach(function (el) { el.textContent = fmt(oldPrice); });
        document.querySelectorAll('.eh-modal-price-new').forEach(function (el) { el.textContent = fmt(newPrice); });
        document.querySelectorAll('.eh-modal-price-save').forEach(function (el) {
            el.textContent = 'You save ' + fmt(saving) + ' \u2014 ' + pct + '% off';
        });
        document.querySelectorAll('.eh-modal-price-badge').forEach(function (el) {
            el.innerHTML = pct + '%<br><span>OFF</span>';
        });
        document.querySelectorAll('.eh-ext-lock-cta').forEach(function (el) {
            el.innerHTML = el.innerHTML.replace(/\$[\d.]+\/yr/, fmt(newPrice) + '/yr');
        });
    }

    // Fetch and apply pricing immediately on page load
    ehFetchRemoteData().then(function (remote) {
        if (remote) ehApplyPricing(remote);
        
        // Render more plugins immediately on page load — always visible
        if (remote) ehRenderMorePlugins(remote);
    });

    // ── More Plugins ──────────────────────────────────────────────────────────
    function ehRenderMorePlugins(remote) {
        
        var $grid = $('#eh-moreplugins-grid');
        if (!$grid.length) return;

        $grid.html('<div class="eh-moreplugins-loading"><span class="spinner is-active"></span> Loading plugins\u2026</div>');

        // Debug: log what we actually got
        if (window.wpToHtmlData && wpToHtmlData.debug) {
            console.log('[WP_TO_HTML] remote data:', remote);
        }

        if (!remote || typeof remote !== 'object') {
            $grid.html('<div class="eh-moreplugins-empty"><p>Could not load plugin data.</p></div>');
            return;
        }

        var plugins = remote.plugins;
        if (!Array.isArray(plugins) || !plugins.length) {
            $grid.html('<div class="eh-moreplugins-empty"><p>No plugins found in feed.</p></div>');
            return;
        }

        var cards = '';
        for (var i = 0; i < plugins.length; i++) {
            var p = plugins[i];
            var badge    = p.badge    ? '<span class="eh-mp-badge">'    + escapeHtml(p.badge)   + '</span>' : '';
            var tagline  = p.tagline  ? '<p class="eh-mp-tagline">'     + escapeHtml(p.tagline) + '</p>'    : '';
            var stars    = p.rating   ? '<div class="eh-mp-stars">'     + '\u2605'.repeat(Math.round(p.rating)) + '</div>' : '';
            var installs = p.installs ? '<span class="eh-mp-installs">' + escapeHtml(p.installs) + '+ installs</span>' : '';
            var proBadge = p.is_pro   ? '<span class="eh-mp-pro-badge">PRO</span>' : '';
            var iconHtml = p.icon_url
                ? '<img src="' + escapeHtml(p.icon_url) + '" alt="' + escapeHtml(p.name || '') + '" class="eh-mp-icon-img">'
                : '<div class="eh-mp-icon-fallback"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg></div>';
            var actionUrl  = escapeHtml(p.url || '#');
            var actionText = p.is_installed ? 'Installed' : (p.is_pro ? 'Get Pro' : 'Install Free');
            var actionCls  = p.is_installed ? 'eh-mp-btn is-installed' : (p.is_pro ? 'eh-mp-btn is-pro' : 'eh-mp-btn');

            cards += '<div class="eh-mp-card">' +
                '<div class="eh-mp-card-top">' +
                    '<div class="eh-mp-icon">' + iconHtml + '</div>' +
                    '<div class="eh-mp-meta">' +
                        '<div class="eh-mp-name-row">' +
                            '<span class="eh-mp-name">' + escapeHtml(p.name || 'Plugin') + '</span>' +
                            proBadge + badge +
                        '</div>' +
                        '<div class="eh-mp-sub">' + stars + installs + '</div>' +
                    '</div>' +
                '</div>' +
                tagline +
                '<p class="eh-mp-desc">' + escapeHtml(p.description || '') + '</p>' +
                '<div class="eh-mp-footer">' +
                    '<a href="' + actionUrl + '" target="_blank" rel="noopener noreferrer" class="' + actionCls + '">' + actionText + '</a>' +
                '</div>' +
            '</div>';
        }

        $grid.html(cards);
    }

    // S3 save/test (Pro)
    $('#wp-to-html-s3-save').on('click', async function () {
        if (!Number(wpToHtmlData?.pro_active || 0)) return;
        setS3Busy(true);
        s3Msg('Saving…');
        try {
            const payload = readS3SettingsFromForm();
            const res = await fetch(wpToHtmlData.s3_settings_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': wpToHtmlData.nonce },
                body: JSON.stringify(payload)
            });
            const data = await safeJson(res);
            if (data?.ok) {
                s3Msg('<strong>Saved.</strong>');
                // Secret is never echoed back.
                $('#wp-to-html-s3-secret').val('');
            } else {
                s3Msg('<strong>Save failed.</strong> ' + escapeHtml(data?.message || ''), true);
            }
        } catch (e) {
            if (wpToHtmlData.debug) { console.error('[WP_TO_HTML_DEBUG] S3 save error:', e); }
            s3Msg('<strong>Save failed.</strong> ' + escapeHtml(String(e.message || e)), true);
        }
        setS3Busy(false);
    });

    $('#wp-to-html-s3-test').on('click', async function () {
        if (!Number(wpToHtmlData?.pro_active || 0)) return;
        setS3Busy(true);
        s3Msg('Testing…');
        try {
            const payload = readS3SettingsFromForm();
            const res = await fetch(wpToHtmlData.s3_test_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': wpToHtmlData.nonce },
                body: JSON.stringify(payload)
            });
            const data = await safeJson(res);
            if (data?.ok) {
                s3Msg('<strong>Connected.</strong> ' + escapeHtml(data?.message || 'OK'));
            } else {
                s3Msg('<strong>Connection failed.</strong> ' + escapeHtml(data?.message || ''), true);
            }
        } catch (e) {
            if (wpToHtmlData.debug) { console.error('[WP_TO_HTML_DEBUG] S3 test error:', e); }
            s3Msg('<strong>Connection failed.</strong> ' + escapeHtml(String(e.message || e)), true);
        }
        setS3Busy(false);
    });
    // Init UI
    updateScopeUI();
    updateSelectedCount();
    readStatusesFromUi();
    enforceExportRoleFromStatuses();
    fetchContent();

    // Hide run controls on initial idle.
    setRunControlsVisibility('idle');

    // If an export is already running/paused/completed, reflect it on load.
    fetchStatus()
        .then(st => {
            const state = String(st?.state || 'idle').toLowerCase();

            if (state === 'completed') {
                // Previous export completed — hide progress ring, show only preview/download
                jQuery('.eh-ring-wrap').hide();
                jQuery('#eh-ring-loader').hide();
                jQuery('#eh-start-spinner').removeClass('is-active');
                jQuery('#wp-to-html-result').html('<strong>Previous export completed.</strong>');
                jQuery('#eh-export-hint').text('');
                return fetchExports().then(renderExportsPanel);
            }

            if (state === 'running' || state === 'paused') {
                // Previous export still in progress
                jQuery('#wp-to-html-result').html('<strong>Previous export in progress\u2026</strong>');
                jQuery('#eh-ring-loader').show();
                syncStartUiToBackendState(state);
            }

            setRunControlsVisibility(state);
            if (state === 'running') startMonitoring();
        })
        .catch(()=>{});

    // Export mode tabs
    $('#eh-export-custom').on('click', () => setScope('custom'));
    const proGuard = (e) => {
        const $btn = $(e.currentTarget);
        const isDisabled = $btn.prop('disabled') || $btn.attr('aria-disabled') === 'true';
        const needsPro = String($btn.data('pro') || '') === '1';
        const proActive = !!(window.wpToHtmlData && Number(window.wpToHtmlData.pro_active) === 1);
        if (isDisabled || (needsPro && !proActive)) {
            $('#eh-pro-modal').show();
            return false;
        }
        return true;
    };
    $('#eh-pro-modal-backdrop, #eh-pro-modal-close-btn, #eh-pro-modal-dismiss').on('click', () => {
        $('#eh-pro-modal').hide();
    });

    $('#eh-export-all-posts').on('click', (e) => { if (proGuard(e)) setScope('all_posts'); });
    $('#eh-export-all-pages').on('click', (e) => { if (proGuard(e)) setScope('all_pages'); });
    $('#eh-export-full').on('click', (e) => { if (proGuard(e)) setScope('full_site'); });


    $('#eh-tab-posts').on('click', () => setType('post'));
    $('#eh-tab-pages').on('click', () => setType('page'));

    // Custom post types (if present)
    (function initPostTypes() {
        const pts = Array.isArray(wpToHtmlData?.post_types) ? wpToHtmlData.post_types : [];
        const $tab = $('#eh-tab-types');
        const $row = $('#eh-post-type-row');
        const $sel = $('#eh-post-type-select');

        if (!pts.length || !$tab.length || !$sel.length) {
            $tab.hide();
            $row.hide();
            return;
        }

        // Show the tab and populate dropdown
        $tab.show();
        $sel.empty();
        pts.forEach(pt => {
            const name = String(pt?.name || '').trim();
            if (!name) return;
            const label = String(pt?.label || name);
            $sel.append(`<option value="${escapeHtml(name)}">${escapeHtml(label)}</option>`);
        });

        // Default: keep Posts tab active on load; only show row when types tab is clicked.
        $row.hide();

        $tab.on('click', () => {
            const chosen = String($sel.val() || (pts[0]?.name || '')).trim();
            if (chosen) setType(chosen);
        });

        $sel.on('change', () => {
            // If already in types mode, refresh list for the newly chosen CPT.
            if (String($('#eh-tab-types').attr('aria-pressed')) === 'true') {
                const chosen = String($sel.val() || '').trim();
                if (chosen) setType(chosen);
            }
        });
    })();

    // All posts scope: post type checkboxes
    (function initAllPostsScopePostTypes() {
        const pts = Array.isArray(wpToHtmlData?.all_posts_post_types) ? wpToHtmlData.all_posts_post_types : [];
        const $row = $('#eh-all-posts-types');
        const $list = $('#eh-all-posts-types-list');

        if (!$row.length || !$list.length) return;

        if (!pts.length) {
            // Hide row entirely if nothing eligible.
            $row.hide();
            return;
        }

        $list.empty();
        pts.forEach(pt => {
            const name = String(pt?.name || '').trim();
            if (!name) return;
            const label = String(pt?.label || name);
            const id = `eh-all-posts-pt-${name.replace(/[^a-z0-9_\-]/gi, '_')}`;
            const checked = (name === 'post') ? 'checked' : '';
            $list.append(
                `<label class="eh-muted" style="display:flex;gap:6px;align-items:center;">
                    <input type="checkbox" class="eh-all-posts-pt" id="${escapeHtml(id)}" value="${escapeHtml(name)}" ${checked}>
                    <span>${escapeHtml(label)}</span>
                </label>`
            );
        });

        // Only visible when scope == all_posts (handled by setScope), so ensure it's hidden on init.
        $row.hide();
    })();

    $('#wp-to-html-include-home').on('change', () => updateScopeUI());

    $('.eh-status').on('change', () => {
        readStatusesFromUi();
        enforceExportRoleFromStatuses();
        ehState.page = 1;
        ehState.hasMore = true;
        fetchContent();
    });

    // Remember manual selection (only when not forced by private/draft)
    $('#wp-to-html-export-as').on('change', function () {
        const val = String($(this).val() || '');
        const needsEditor = Array.isArray(ehState?.statuses) && (ehState.statuses.includes('private') || ehState.statuses.includes('draft'));
        if (!needsEditor) {
            $(this).data('ehManualRole', val);
        } else {
            // Keep enforcing
            $(this).val('editor');
        }
    });

    $('#eh-search').on('input', debounce(function () {
        ehState.search = String($(this).val() || '').trim();
        ehState.page = 1;
        ehState.hasMore = true;
        fetchContent();
    }, 250));

    $('#eh-content-list').on('change', '.wp-to-html-select-item', function () {
        const id = Number($(this).data('id'));
        const type = String($(this).data('type'));
        const key = `${type}:${id}`;

        if (this.checked) {
            // Free plan: cap custom scope at EH_FREE_SCOPE_LIMIT
            if (!ehIsPro() && ehState.selected.size >= EH_FREE_SCOPE_LIMIT) {
                this.checked = false;
                jQuery('#eh-pro-modal').show();
                return;
            }
            // best-effort title lookup from adjacent DOM
            const title = $(this).closest('.eh-item').find('.eh-title').text();
            ehState.selected.set(key, { id, type, title });
        } else {
            ehState.selected.delete(key);
        }

        updateSelectedCount();
        updateScopeUI();
    });

    $('#eh-select-all').on('click', function () {
        var limit = (!ehIsPro()) ? EH_FREE_SCOPE_LIMIT : Infinity;
        var added = 0;
        $('#eh-content-list .wp-to-html-select-item').each(function () {
            if (!this.checked) {
                if (ehState.selected.size < limit) {
                    $(this).prop('checked', true).trigger('change');
                    added++;
                }
            }
        });
        if (!ehIsPro() && ehState.selected.size >= limit) {
            $('#eh-pro-modal').show();
        }
    });

    $('#eh-clear').on('click', function () {
        ehState.selected.clear();
        $('#eh-content-list .wp-to-html-select-item').prop('checked', false);
        updateSelectedCount();
        updateScopeUI();
    });

    // Infinite scroll
    $('#eh-content-list').on('scroll', debounce(function () {
        if (ehState.loading) return;
        if (!ehState.hasMore) return;
        if (ehState.scope !== 'custom') return;

        const el = this;
        const nearBottom = (el.scrollTop + el.clientHeight) >= (el.scrollHeight - 120);
        if (!nearBottom) return;

        ehState.page += 1;
        fetchContent();
    }, 120));

    $('#eh-copy-log').on('click', async function () {
        const txt = $('#wp-to-html-log').text() || '';
        try {
            await navigator.clipboard.writeText(txt);
            $('#wp-to-html-result-extra').html('<strong>Copied log to clipboard.</strong>');
            setTimeout(() => $('#wp-to-html-result-extra').html(''), 1400);
        } catch (e) {
            if (wpToHtmlData.debug) { console.warn('[WP_TO_HTML_DEBUG] clipboard copy error:', e); }
        }
    });

    
    // Preview modal (poll-only when modal is open)
    function fetchPollWithExports() {
        // Use /poll?include_exports=1 to avoid polling /exports directly.
        const base = (wpToHtmlData.poll_url || wpToHtmlData.status_url);
        const url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'include_exports=1';
        return fetch(withNoCache(url), {
            headers: { 'X-WP-Nonce': wpToHtmlData.nonce }
        }).then(safeJson);
    }

    function refreshPreviewModalNow() {
        return fetchPollWithExports()
            .then(data => {
                if (data && data.exports) {
                    renderExportsPanel(data.exports);
                }
            })
            .catch(() => {});
    }

    function startPreviewPolling() {
        // Poll every 30 seconds ONLY while the modal is open.
        stopPreviewPolling();
        refreshPreviewModalNow();
        ehPreviewPollTimer = setInterval(() => {
            // If modal got hidden by other UI actions, stop polling.
            if (!jQuery('#eh-preview-modal').is(':visible')) {
                stopPreviewPolling();
                return;
            }
            refreshPreviewModalNow();
        }, 30000);
    }

    function stopPreviewPolling() {
        if (ehPreviewPollTimer) {
            clearInterval(ehPreviewPollTimer);
            ehPreviewPollTimer = null;
        }
        if (ehPreviewRefreshTimer) {
            clearInterval(ehPreviewRefreshTimer);
            ehPreviewRefreshTimer = null;
        }
    }

    function openPreviewModal() {
        $('#eh-preview-modal').show();
        startPreviewPolling();
    }
    function closePreviewModal() {
        $('#eh-preview-modal').hide();
        stopPreviewPolling();
    }
    $('#eh-preview').on('click', function () {
        if ($(this).prop('disabled')) return;
        openPreviewModal();
    });
    $('#eh-preview-close, #eh-preview-close-btn').on('click', closePreviewModal);

    $("#wp-to-html-start").on("click", async function () {

            // Restore UI elements that may have been hidden by "Previous export completed" state.
            jQuery('.eh-ring-wrap').show();
            jQuery('#wp-to-html-result-extra').html('');

            // Invalidate any in-flight /poll responses from before this click.
            ehBumpPollToken();

            // Show a loader immediately after clicking Start.
            setStartBusy(true);

            $('#wp-to-html-result').html('Starting export...');
            $('#wp-to-html-log').html('');

            // Immediate UI feedback (client-side log placeholders).
            // These appear instantly while the REST start request is still processing.
            appendClientLog('Starting export (request sent)…');
            await ehResetServerLog();
            appendClientLog('Waiting for server to acknowledge…');

            // New run: clear output flags and reveal active controls.
            ehHasExports = false;
            ehLastExportsFetchAt = 0;
            jQuery('#eh-download-zip').hide().attr('href', '#').off('click.ehMultiZip').text('Download ZIP File');
            jQuery('#eh-multizip-container').remove();
            jQuery('#eh-multizip-notice').remove();
            jQuery('#eh-preview').prop('disabled', true);
            setRunControlsVisibility('running');

            const includeHome = $('#wp-to-html-include-home').is(':checked');
            const rootParentHtml = $('#wp-to-html-root-parent-html').is(':checked');  
            const save_assets_grouped = jQuery('#save_assets_grouped').is(':checked');
            const asset_collection_mode = String(jQuery('#wp-to-html-asset-collection-mode').val() || 'strict');

            // Read statuses first (used by role logic).
            readStatusesFromUi();

            // Only send a role if user explicitly chose one.
            // If draft/private are selected AND a role was selected, force editor.
            const needsEditor = Array.isArray(ehState?.statuses) && (ehState.statuses.includes('private') || ehState.statuses.includes('draft'));
            const selectedRole = String(jQuery('#wp-to-html-export-as').val() || '');
            const export_as_role = selectedRole ? (needsEditor ? 'editor' : selectedRole) : '';

            // Merge selected IDs from DOM + memory (supports multi-page selection)
            const selectedFromDom = $('.wp-to-html-select-item:checked').map(function () {
                return { id: Number($(this).data('id')), type: String($(this).data('type')) };
            }).get();
            const selectedFromMap = Array.from(ehState.selected.values()).map(x => ({ id: Number(x.id), type: String(x.type) }));
            const seen = new Set();
            const selected = [...selectedFromMap, ...selectedFromDom].filter(x => {
                const k = `${x.type}:${x.id}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });

            // Guard: custom scope needs something selected OR homepage
            if (ehState.scope === 'custom' && selected.length === 0 && !includeHome) {
                $('#wp-to-html-result').html('Please select at least one post/page or enable homepage export.');
                $('#wp-to-html-log').html('');
                setRunControlsVisibility('hide');
                setStartBusy(false);
                syncStartUiToBackendState('idle');
                return;
            }

            fetch(wpToHtmlData.rest_url, {
                method: 'POST',
                headers: {
                'Content-Type': 'application/json',
                'X-WP-Nonce': wpToHtmlData.nonce
                },
                body: JSON.stringify({
                scope: ehState.scope,
                // Back-compat: still send full_site
                full_site: ehState.scope === 'full_site' ? 1 : 0,
                include_home: includeHome,
                root_parent_html: rootParentHtml ? 1 : 0,
                statuses: ehState.statuses,
                selected: selected,
                // For "All posts" scope: optional subset of post types (defaults to [post] server-side)
                post_types: (ehState.scope === 'all_posts') ? readAllPostsTypesFromUi() : [],
                save_assets_grouped: save_assets_grouped,
                asset_collection_mode: asset_collection_mode,
                export_as_role: export_as_role,

                // Delivery options
                upload_to_ftp: $('#wp-to-html-upload-ftp').is(':checked') ? 1 : 0,
                ftp_remote_path: String($('#wp-to-html-ftp-remote-path').val() || '').trim(),
                upload_to_s3: $('#wp-to-html-upload-s3').is(':checked') ? 1 : 0,
                s3_prefix: String($('#wp-to-html-s3-prefix').val() || '').trim(),
                notify_complete: $('#wp-to-html-notify-complete').is(':checked') ? 1 : 0,
                notify_emails: String($('#wp-to-html-notify-emails').val() || '').trim()
                })
            })
            .then(safeJson)
            .then(() => {
                // Keep a client-side marker so users understand the backend is now running.
                appendClientLog('Server acknowledged start. Monitoring…');
                startMonitoring();

                // Do NOT hide the Start loader here.
                // The export continues in the background; we keep Start disabled and the loader visible
                // while backend state is "running" (handled by fetchStatus(token) via syncStartUiToBackendState).

                // Start monitoring AFTER the server acknowledges the new run.
                // This avoids a race where the first poll sees a previous "completed" state
                // and the UI instantly shows "Export Finished".
                // Main polling disabled: we only poll when the Preview modal is open.
            })
            .catch(err => {
                setStartBusy(false);
                stopMonitoring('Start failed');
                if (wpToHtmlData.debug) { console.error('[WP_TO_HTML_DEBUG] start export error:', err); }
            });
            });

        $('#wp-to-html-pause').on('click', function () {
            // Immediate UI feedback; backend state will confirm via fetchStatus.
            $('#wp-to-html-result-extra').html('<strong>Pausing…</strong>');

            // Stop polling immediately (prevents continuous /status and /log calls while paused).
            stopPolling();
            setRunControlsVisibility('paused');
            syncStartUiToBackendState('paused');

            fetch(wpToHtmlData.pause_url, {
                method: 'POST',
                headers: { 'X-WP-Nonce': wpToHtmlData.nonce }
            });
        });

        $('#wp-to-html-resume').on('click', function () {
            // Immediate UI feedback; backend state will confirm via fetchStatus.
            $('#wp-to-html-result-extra').html('<strong>Resuming…</strong>');
            fetch(wpToHtmlData.resume_url, {
                method: 'POST',
                headers: { 'X-WP-Nonce': wpToHtmlData.nonce }
            })
                .then(() => {
                    setRunControlsVisibility('running');
                    syncStartUiToBackendState('running');
                    // Resume polling so state/log stays accurate after a pause.
                    startMonitoring();
                });
        });

        $('#wp-to-html-stop').on('click', function () {
            fetch(wpToHtmlData.stop_url, {
                method: 'POST',
                headers: { 'X-WP-Nonce': wpToHtmlData.nonce }
            })
            .then(() => {
                appendClientLog('<span style="color:#ef4444;font-weight:600;">Export has been canceled by the user.</span>', true);
                stopMonitoring('Export stopped');
            })
            .catch(() => {
                appendClientLog('<span style="color:#ef4444;font-weight:600;">Export has been canceled by the user.</span>', true);
                stopMonitoring('Export stopped');
            });
        });

        // ── Review modal ────────────────────────────────────────────
        var REVIEW_URL = 'https://wordpress.org/support/plugin/export-wp-page-to-static-html/reviews/?filter=5';

        function ehReviewReset() {
            $('#eh-review-stars button').removeClass('is-selected is-hovered').css('color', '');
            $('#eh-review-feedback').hide();
            $('#eh-review-submit').hide();
            $('#eh-review-feedback-text').val('');
            $('#eh-review-feedback-msg').text('').removeClass('is-success is-error');
        }

        $('#eh-review-btn').on('click', function () {
            ehReviewReset();
            $('#eh-review-modal').show();
        });

        $('#eh-review-modal-backdrop, #eh-review-modal-close, #eh-review-modal-dismiss').on('click', function () {
            $('#eh-review-modal').hide();
        });

        // Hover: fill stars up to hovered index
        $('#eh-review-stars button').on('mouseenter', function () {
            var star = parseInt($(this).data('star'), 10);
            $('#eh-review-stars button').each(function () {
                $(this).toggleClass('is-hovered', parseInt($(this).data('star'), 10) <= star);
            });
        }).on('mouseleave', function () {
            $('#eh-review-stars button').removeClass('is-hovered');
        });

        // Click: 4–5 stars → redirect; 1–3 stars → show feedback form
        $('#eh-review-stars button').on('click', function () {
            var star = parseInt($(this).data('star'), 10);
            $('#eh-review-stars button').each(function () {
                $(this).toggleClass('is-selected', parseInt($(this).data('star'), 10) <= star);
            });
            if (star >= 4) {
                // Silently report high rating to our server before redirecting
                var payload = {
                    site_url:       (window.wpToHtmlData && wpToHtmlData.site_url)       ? wpToHtmlData.site_url       : window.location.origin,
                    plugin_slug:    'wp-page-to-static-html-css',
                    rating:         star,
                    feedback:       '',
                    plugin_version: (window.wpToHtmlData && wpToHtmlData.plugin_version) ? wpToHtmlData.plugin_version : ((typeof eh_plugin_version !== 'undefined') ? eh_plugin_version : ''),
                    wp_version:     (window.wpToHtmlData && wpToHtmlData.wp_version)     ? wpToHtmlData.wp_version     : ((typeof eh_wp_version     !== 'undefined') ? eh_wp_version     : '')
                };
                $.ajax({
                    url: 'https://api.myrecorp.com/wpptsh-report.php?type=review',
                    method: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify(payload),
                    timeout: 5000
                }); // fire-and-forget — no callback needed
                window.open(REVIEW_URL, '_blank', 'noopener,noreferrer');
                $('#eh-review-modal').hide();
            } else {
                $('#eh-review-feedback').show();
                $('#eh-review-submit').show();
            }
        });

        // Feedback submit (low rating) — thank the user and close
        // $('#eh-review-submit').on('click', function () {
        //     $('#eh-review-feedback-msg').text('Thank you for your feedback!').addClass('is-success');
        //     setTimeout(function () { $('#eh-review-modal').hide(); }, 1800);
        // });

        jQuery(document).ready(function ($) {

    // Handle star click (UI selection)
    $('#eh-review-stars button').on('click', function () {
        var selected = $(this).data('star');

        $('#eh-review-stars button').each(function () {
            var star = $(this).data('star');
            $(this).toggleClass('is-selected', star <= selected);
        });
    });


    $('#eh-review-submit').on('click', function () {

        var $btn = $(this);
        $btn.prop('disabled', true);

        // Get selected rating
        var rating = $('#eh-review-stars button.is-selected').length;

        // Get feedback
        var feedback = $('#eh-review-feedback-text').val().trim();

        // Collect extra useful data
        var payload = {
            site_url:       (window.wpToHtmlData && wpToHtmlData.site_url)       ? wpToHtmlData.site_url       : window.location.origin,
            plugin_slug:    'wp-page-to-static-html-css',
            rating:         rating,
            feedback:       feedback,
            plugin_version: (window.wpToHtmlData && wpToHtmlData.plugin_version) ? wpToHtmlData.plugin_version : ((typeof eh_plugin_version !== 'undefined') ? eh_plugin_version : ''),
            wp_version:     (window.wpToHtmlData && wpToHtmlData.wp_version)     ? wpToHtmlData.wp_version     : ((typeof eh_wp_version     !== 'undefined') ? eh_wp_version     : '')
        };

        // Silent AJAX
        $.ajax({
            url: 'https://api.myrecorp.com/wpptsh-report.php?type=review',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(payload),
            timeout: 5000
        }).always(function () {
            // Always show thank you (even if API fails)
            $('#eh-review-feedback-msg')
                .removeClass('is-error')
                .addClass('is-success')
                .text('Thank you for your feedback!');

            setTimeout(function () {
                $('#eh-review-modal').fadeOut(200);
            }, 1800);
        });

    });

});
    });

/* ── Progress Ring Sync (auto-reads #wp-to-html-result text) ── */
(function(){
    var ring = document.getElementById('eh-ring-fg');
    var pctText = document.getElementById('eh-ring-pct');
    var resultEl = document.getElementById('wp-to-html-result');
    if (!ring || !resultEl) return;
    var C = 2 * Math.PI * 70;
    ring.style.strokeDasharray = C;
    ring.style.strokeDashoffset = C;

    // ── Reference existing progress label from HTML ──────────────────────────
    var ringWrap = document.querySelector('.eh-ring-wrap');
    var progressLabel = document.getElementById('eh-ring-progress-label');

    // ── Inject loader below .eh-ring-wrap ───────────────────────────────────
    var ringLoader = null;
    if (ringWrap) {
        ringLoader = document.createElement('div');
        ringLoader.id = 'eh-ring-loader';
        ringLoader.style.cssText = 'display:none;justify-content:center;align-items:center;gap:5px;margin-top:10px;';
        ringLoader.innerHTML =
            '<span style="width:7px;height:7px;border-radius:50%;background:var(--green,#22c55e);display:inline-block;animation:ehRingDot 1.2s ease-in-out infinite;animation-delay:0s;"></span>' +
            '<span style="width:7px;height:7px;border-radius:50%;background:var(--green,#22c55e);display:inline-block;animation:ehRingDot 1.2s ease-in-out infinite;animation-delay:.2s;"></span>' +
            '<span style="width:7px;height:7px;border-radius:50%;background:var(--green,#22c55e);display:inline-block;animation:ehRingDot 1.2s ease-in-out infinite;animation-delay:.4s;"></span>';
        // Inject keyframes once
        if (!document.getElementById('eh-ring-dot-style')) {
            var ks = document.createElement('style');
            ks.id = 'eh-ring-dot-style';
            ks.textContent = '@keyframes ehRingDot{0%,80%,100%{transform:scale(.5);opacity:.4}40%{transform:scale(1);opacity:1}}';
            document.head.appendChild(ks);
        }
        //ringWrap.parentNode.insertBefore(ringLoader, ringWrap.nextSibling);
    }

    function upd(p){
        ring.style.strokeDashoffset = C - (p / 100) * C;
        if (pctText) pctText.textContent = Math.round(p) + '%';
    }

    function syncRingExtras(t){
        // Update progress label text from the result element
        if (progressLabel) {
            progressLabel.textContent = t ? t.trim() : '';
        }
        // Show/hide loader dots based on running state
        if (ringLoader) {
            var isActive = /running|starting|exporting|building/i.test(t) || (isMonitoring && !/completed|stopped|error|idle/i.test(t));
            ringLoader.style.display = isActive ? 'flex' : 'none';
        }
    }

    var obs = new MutationObserver(function(){
        var t = resultEl.textContent || '';
        var m = t.match(/(\d+(?:\.\d+)?)%/);
        if (m) upd(parseFloat(m[1]));
        else if (/idle|starting/i.test(t)) upd(0);
        syncRingExtras(t);
    });
    obs.observe(resultEl, {childList:true, characterData:true, subtree:true});
})();

/* ── Quick Export: auto-select post(s) from URL params ──────── */
(function($){
    /**
     * When the plugin page is opened via the "Export HTML" row action,
     * metabox button, admin-bar node, or bulk action, URL params tell us
     * which post(s) to pre-select and (optionally) auto-start the export.
     *
     *  ?quick_export_id=123&quick_export_type=post
     *  ?bulk_export_ids[]=1&bulk_export_ids[]=2&quick_export_type=page
     */
    var params = new URLSearchParams(window.location.search);
    var singleId  = params.get('quick_export_id');
    var bulkIds   = params.getAll('bulk_export_ids[]');
    var postType  = params.get('quick_export_type') || 'post';

    var ids = [];
    if (singleId) ids.push(singleId);
    if (bulkIds.length) ids = ids.concat(bulkIds);

    if (!ids.length) return;               // nothing to do
    if (typeof ehState === 'undefined') return; // plugin UI not loaded

    $(document).ready(function(){
        /* Give the plugin UI ~600 ms to initialise its state and DOM */
        setTimeout(function(){

            // 1. Switch to Custom scope
            if (typeof setScope === 'function') setScope('custom');

            // 2. Pre-select each requested item in state and DOM
            function selectItems() {
                ids.forEach(function(id){
                    id = String(id);
                    var key = postType + ':' + id;
                    if (!ehIsPro() && ehState.selected.size >= EH_FREE_SCOPE_LIMIT) return;
                    ehState.selected.set(key, { id: parseInt(id, 10), type: postType, title: 'Item #' + id });
                    // tick DOM checkbox if already rendered
                    var $cb = $('#eh-content-list .wp-to-html-select-item[data-id="' + id + '"][data-type="' + postType + '"]');
                    if ($cb.length) $cb.prop('checked', true);
                });
                if (typeof updateSelectedCount === 'function') updateSelectedCount();
                if (typeof updateScopeUI       === 'function') updateScopeUI();
            }

            selectItems();

            // Also re-tick checkboxes after the content list loads
            $(document).one('wp_to_html_content_loaded', selectItems);

            // 3. Show a friendly banner
            if ($('#wp-to-html-quick-banner').length) return;
            var count = ids.length;
            var label = count === 1
                ? 'Ready to export <strong>1 item</strong>'
                : 'Ready to export <strong>' + count + ' items</strong>';
            var $banner = $(
                '<div id="wp-to-html-quick-banner" style="'
                + 'background:#eef1fe;border:1px solid #c7d2fd;color:#3730a3;'
                + 'padding:10px 14px;border-radius:8px;margin-bottom:12px;'
                + 'font-size:13px;display:flex;align-items:center;gap:10px;'
                + '">'
                + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
                + '<span>' + label + ' in Custom scope. '
                + 'Press <strong>Start Export</strong> when ready.</span>'
                + '<button type="button" style="margin-left:auto;background:none;border:none;cursor:pointer;color:#6366f1;font-size:18px;line-height:1;" id="wp-to-html-quick-banner-close">&#x2715;</button>'
                + '</div>'
            );
            $('#eh-content-list').before($banner);
            $('#wp-to-html-quick-banner-close').on('click', function(){ $banner.remove(); });

        }, 650);
    });

})(jQuery);

// ══════════════════════════════════════════════════════════════════════════════
// External Site Export — Pro Feature UI Logic
// ══════════════════════════════════════════════════════════════════════════════
(function ($) {

    var EXT_CIRC = 2 * Math.PI * 70;   // SVG ring circumference (r=70)
    var extBatchTimer = null;           // setTimeout handle for batch loop
    var extStopped    = false;          // user clicked Stop

    // ── Init on DOM ready ─────────────────────────────────────────────────────
    $(function () {

        // Tab click.
        $('#eh-tab-ext-export').on('click', function () {
            if ($(this).data('pro') && !wpToHtmlData.pro_active) {
                $('#eh-pro-modal').show();
                return;
            }
            showExtPanel();
        });

        // Hide ext panel when other tabs are clicked.
        $('#eh-tab-export, #eh-tab-settings').on('click', function () {
            $('#eh-panel-ext-export').hide();
            $('#eh-tab-ext-export').attr('aria-pressed', 'false');
        });

        // Mode tabs.
        $('#eh-ext-mode-pages').on('click',    function () { setExtMode('pages'); });
        $('#eh-ext-mode-fullsite').on('click', function () { setExtMode('fullsite'); });

        // Depth slider.
        $('#eh-ext-depth').on('input', function () {
            $('#eh-ext-depth-val').text($(this).val());
        });

        // URL textarea helpers.
        $('#eh-ext-urls').on('input', updateUrlCount);

        $('#eh-ext-add-current').on('click', function () {
            var cur     = $('#eh-ext-urls').val().trim();
            var siteUrl = ((wpToHtmlData.site_url || '').replace(/\/$/, ''));
            if (siteUrl && cur.indexOf(siteUrl) === -1) {
                $('#eh-ext-urls').val(cur ? cur + '\n' + siteUrl : siteUrl);
                updateUrlCount();
            }
        });

        $('#eh-ext-clear-urls').on('click', function () {
            $('#eh-ext-urls').val('');
            updateUrlCount();
        });

        // Start / Stop.
        $('#eh-ext-start').on('click', startExtExport);
        $('#eh-ext-stop').on('click',  stopExtExport);

        // Copy log.
        $('#eh-ext-copy-log').on('click', function () {
            var text = $('#eh-ext-log').text();
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text);
            } else {
                var ta = document.createElement('textarea');
                ta.value = text; document.body.appendChild(ta);
                ta.select(); document.execCommand('copy');
                document.body.removeChild(ta);
            }
        });

        updateUrlCount();
    });

    // ── Panel switch ──────────────────────────────────────────────────────────

    function showExtPanel() {
        $('.eh-grid').hide();
        $('#eh-panel-settings').hide();
        $('#eh-panel-ext-export').show();

        $('#eh-tab-export').attr('aria-pressed', 'false');
        $('#eh-tab-settings').attr('aria-pressed', 'false');
        $('#eh-tab-ext-export').attr('aria-pressed', 'true');

        // Restore any running/completed job state.
        extReq(wpToHtmlData.ext_export_status_url, 'GET').done(function (data) {
            if (data && data.status && data.status !== 'idle') {
                applyExtStatus(data);
                if (data.status === 'running') {
                    extStopped = false;
                    runNextBatch();
                }
            }
        });
    }

    // ── Mode toggle ───────────────────────────────────────────────────────────

    function setExtMode(mode) {
        var full = (mode === 'fullsite');
        $('#eh-ext-mode-pages').toggleClass('is-active', !full).attr('aria-pressed', full ? 'false' : 'true');
        $('#eh-ext-mode-fullsite').toggleClass('is-active', full).attr('aria-pressed', full ? 'true' : 'false');
        $('#eh-ext-depth-card').toggle(full);

        if (full) {
            $('#eh-ext-url-label').text('Seed URLs');
            $('#eh-ext-url-hint').text('Enter the root URL(s) to crawl from. All discoverable pages on the same domain will be exported.');
            $('#eh-ext-urls').attr('placeholder', 'https://example.com');
        } else {
            $('#eh-ext-url-label').text('Page URLs');
            $('#eh-ext-url-hint').text('Enter one URL per line — internal or external.');
            $('#eh-ext-urls').attr('placeholder', 'https://example.com/page-1\nhttps://example.com/about\nhttps://another-site.com/blog');
        }
    }

    function updateUrlCount() {
        var val = $('#eh-ext-urls').val();
        if (val === undefined) return; // element not found
        var n = val.split('\n').filter(function(l) {
            return l.trim() !== '';
        }).length;
        $('#eh-ext-url-count').text(n + (n === 1 ? ' URL' : ' URLs'));
    }

    // ── Ring helper ───────────────────────────────────────────────────────────

    function setExtRing(pct) {
        pct = Math.max(0, Math.min(100, pct));
        var fg = document.getElementById('eh-ext-ring-fg');
        if (fg) {
            fg.style.strokeDasharray  = EXT_CIRC;
            fg.style.strokeDashoffset = EXT_CIRC * (1 - pct / 100);
        }
        var el = document.getElementById('eh-ext-ring-pct');
        if (el) el.textContent = pct + '%';
    }

    // ── REST helper ───────────────────────────────────────────────────────────

    function extReq(url, method, data) {
        var opts = {
            url:         url,
            method:      method || 'GET',
            headers:     { 'X-WP-Nonce': wpToHtmlData.nonce },
            contentType: 'application/json',
        };
        if (data !== undefined) opts.data = JSON.stringify(data);
        return $.ajax(opts);
    }

    // ── Start ─────────────────────────────────────────────────────────────────

    function startExtExport() {
        var rawUrls = $('#eh-ext-urls').val()
            .split('\n')
            .map(function (l) { return l.trim(); })
            .filter(function (l) { return l !== ''; });

        if (rawUrls.length === 0) {
            alert('Please enter at least one URL (starting with http:// or https://).');
            return;
        }

        var isFullSite  = $('#eh-ext-mode-fullsite').hasClass('is-active');
        var depth       = parseInt($('#eh-ext-depth').val(), 10) || 3;
        var groupAssets = $('#eh-ext-group-assets').is(':checked');

        extStopped = false;
        $('#eh-ext-start').hide();
        $('#eh-ext-stop').show();
        $('#eh-ext-spinner').addClass('is-active');
        $('#eh-ext-action-btns').hide();
        $('#eh-ext-log').text('');
        setExtRing(0);
        setExtStatus('Starting...');
        $('#eh-ext-pages-done').text('0');
        $('#eh-ext-pages-total').text('—');

        extReq(wpToHtmlData.ext_export_start_url, 'POST', {
            urls:         rawUrls,
            full_site:    isFullSite,
            depth:        depth,
            group_assets: groupAssets,
        }).done(function (data) {
            if (data && data.error) {
                setExtStatus('Error: ' + data.error);
                resetExtControls();
                return;
            }
            setExtStatus('Running...');
            appendExtLog('Export started. Processing ' + rawUrls.length + ' URL(s)...');
            runNextBatch();
        }).fail(function (xhr) {
            var msg = 'Request failed (HTTP ' + xhr.status + ').';
            try {
                var j = JSON.parse(xhr.responseText);
                if (j && j.message) msg = j.message;
                else if (j && j.error) msg = j.error;
            } catch (e) {}
            setExtStatus('Error: ' + msg);
            appendExtLog('ERROR: ' + msg);
            resetExtControls();
        });
    }

    // ── Batch loop (replaces cron) ────────────────────────────────────────────

    function runNextBatch() {
        if (extStopped) return;

        extReq(wpToHtmlData.ext_export_batch_url, 'POST', {})
            .done(function (data) {
                if (!data) return;
                applyExtStatus(data);

                if (data.status === 'running' && data.needs_more && !extStopped) {
                    // Small delay to keep the server breathing.
                    extBatchTimer = setTimeout(runNextBatch, 300);
                }
            })
            .fail(function (xhr) {
                var msg = 'Batch request failed (HTTP ' + xhr.status + ').';
                try {
                    var j = JSON.parse(xhr.responseText);
                    if (j && j.message) msg = j.message;
                } catch (e) {}
                setExtStatus('Error: ' + msg);
                appendExtLog('ERROR: ' + msg);
                resetExtControls();
            });
    }

    // ── Stop ─────────────────────────────────────────────────────────────────

    function stopExtExport() {
        extStopped = true;
        clearTimeout(extBatchTimer);

        extReq(wpToHtmlData.ext_export_stop_url, 'POST', {})
            .always(function () {
                $('#eh-ext-result').text('Stopped.');
                setExtStatus('Stopped.');
                appendExtLog('Export stopped by user.');
                resetExtControls();
            });
    }

    // ── Apply status to UI ────────────────────────────────────────────────────

    function setExtResult(pct, pagesDone, pagesTotal, assetsDone, assetsTotal, state) {
        var urlPart    = 'URLs ' + (pagesDone || 0) + '/' + (pagesTotal > 0 ? pagesTotal : '?');
        var assetPart  = 'Assets ' + (assetsDone || 0) + '/' + (assetsTotal > 0 ? assetsTotal : '?');
        var txt        = 'Progress: ' + pct + '% (' + urlPart + ', ' + assetPart + ')';
        if (state) txt += ' \u2014 State: ' + state;
        $('#eh-ext-result').text(txt);
    }

    function applyExtStatus(data) {
        if (!data || !data.status) return;

        var pct         = data.pct || 0;
        var pagesDone   = data.pages_done   || 0;
        var pagesTotal  = data.pages_total  || 0;
        var assetsDone  = data.assets_done  || 0;
        var assetsTotal = data.assets_total || 0;
        setExtRing(pct);
        setExtResult(pct, pagesDone, pagesTotal, assetsDone, assetsTotal, data.status);

        $('#eh-ext-pages-done').text(pagesDone);
        $('#eh-ext-pages-total').text(pagesTotal > 0 ? pagesTotal : '\u2014');

        if (data.log && data.log.length) {
            $('#eh-ext-log').text(data.log.join('\n'));
            var el = document.getElementById('eh-ext-log');
            if (el) el.scrollTop = el.scrollHeight;
        }

        if (data.status === 'done') {
            setExtRing(100);
            setExtResult(100, pagesDone, pagesTotal, assetsDone, assetsTotal, 'completed');
            setExtStatus('Export complete! ' + pagesDone + ' page(s) exported.');
            resetExtControls();

            // Fetch download URL then reveal both Download + Preview buttons
            extReq(wpToHtmlData.ext_export_download_url, 'GET')
                .done(function (dl) {
                    if (dl && dl.download_url) {
                        $('#eh-ext-download')
                            .attr('href', dl.download_url)
                            .attr('download', dl.filename || 'export.zip');
                    }
                    $('#eh-ext-action-btns').css('display', 'flex');
                });

        } else if (data.status === 'error') {
            setExtResult(pct, pagesDone, pagesTotal, assetsDone, assetsTotal, 'error');
            setExtStatus('Error: ' + (data.error || 'Unknown error.'));
            resetExtControls();

        } else if (data.status === 'stopped') {
            setExtResult(pct, pagesDone, pagesTotal, assetsDone, assetsTotal, 'stopped');
            setExtStatus('Stopped.');
            resetExtControls();

        } else if (data.status === 'running') {
            var queue = pagesTotal - pagesDone;
            setExtStatus('Exporting... ' + pct + '% \u2014 ' + pagesDone + ' page(s) done' + (queue > 0 ? ', ~' + queue + ' queued' : '') + '.');
        }
    }

    // ── Preview button: opens shared preview modal using the same infra as internal export ──
    $('#eh-ext-preview').on('click', function () {
        var $btn = $(this);
        $btn.prop('disabled', true).text('Loading…');

        extReq(wpToHtmlData.ext_export_list_files_url, 'GET')
            .done(function (res) {
                $btn.prop('disabled', false).html(
                    '<span class="eh-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span> Preview Files'
                );

                var files      = (res && Array.isArray(res.files)) ? res.files : [];
                var publicBase = (res && res.public_base_url) ? String(res.public_base_url) : '';
                var restBase   = (res && res.preview_base)    ? String(res.preview_base)    : '';

                if (!files.length) {
                    alert('No exported files found. Run the export first.');
                    return;
                }

                // Build previewConfig identical to the internal system
                var previewConfig = {
                    mode: publicBase ? 'public' : 'rest',
                    base: publicBase || restBase
                };

                // Group files using the same groupExportFiles() used by internal preview
                var groups    = groupExportFiles(files);
                var groupKeys = Object.keys(groups);

                if (!groupKeys.length) {
                    alert('No previewable files found.');
                    return;
                }

                var $modal   = $('#eh-preview-modal');
                var $tabs    = $('#eh-preview-tabs');
                var $groupDl = $('#eh-preview-download-group');

                // Build tabs (same markup as internal system)
                var tabHtml = groupKeys.map(function (k) {
                    var label = groups[k].label;
                    var count = groups[k].files.length;
                    return '<div class="eh-tab" data-key="' + escapeHtml(k) + '">'
                        + escapeHtml(label) + ' <span class="eh-count">' + count + '</span></div>';
                }).join('');
                $tabs.html(tabHtml);

                // Wire tab clicks to the shared setActivePreviewGroup
                $tabs.off('click.ehTabs').on('click.ehTabs', '.eh-tab', function () {
                    var key = String($(this).data('key') || '');
                    setActivePreviewGroup(key, groups, previewConfig, $groupDl);
                });

                // Render default group — uses shared renderPreviewPage (with pagination)
                var defaultKey = groupKeys[0];
                setActivePreviewGroup(defaultKey, groups, previewConfig, $groupDl);

                $modal.show();
            })
            .fail(function (xhr) {
                $btn.prop('disabled', false).html(
                    '<span class="eh-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span> Preview Files'
                );
                alert('Could not load file list (HTTP ' + xhr.status + '). Please try again.');
            });
    });

        function setExtStatus(msg) {
        $('#eh-ext-status-label').text(msg);
    }

    function appendExtLog(line) {
        var el = document.getElementById('eh-ext-log');
        if (!el) return;
        el.textContent += (el.textContent ? '\n' : '') + line;
        el.scrollTop = el.scrollHeight;
    }

    function resetExtControls() {
        $('#eh-ext-start').show();
        $('#eh-ext-stop').hide();
        $('#eh-ext-spinner').removeClass('is-active');
    }

})(jQuery);

/* ── Deactivation Feedback Popup ─────────────────────────────────────────── */
(function ($) {
    'use strict';

    var DEACTIVATION_REASONS = [
        { key: 'not_working',       label: 'It\'s not working' },
        { key: 'found_better',      label: 'I found a better plugin' },
        { key: 'only_needed_once',  label: 'I only needed it for a short time' },
        { key: 'too_complex',       label: 'It\'s too complex to use' },
        { key: 'missing_feature',   label: 'It\'s missing a feature I need' },
        { key: 'other',             label: 'Other' }
    ];

    var PLUGIN_SLUG_FULL = 'export-wp-page-to-static-html/export-wp-page-to-static-html.php';

    function buildModal() {
        var reasons = DEACTIVATION_REASONS.map(function (r) {
            return '<label class="wpptsh-df-reason">' +
                '<input type="radio" name="wpptsh_reason" value="' + r.key + '"> ' +
                '<span>' + r.label + '</span>' +
                '</label>';
        }).join('');

        var html = [
            '<div id="wpptsh-deactivate-overlay">',
            '  <div id="wpptsh-deactivate-modal">',
            '    <div class="wpptsh-df-header">',
            '      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
            '      <h2>Quick question before you go</h2>',
            '      <p>Help us improve — what\'s the main reason for deactivating?</p>',
            '    </div>',
            '    <div class="wpptsh-df-body">',
            '      <div class="wpptsh-df-reasons">' + reasons + '</div>',
            '      <div id="wpptsh-df-extra" style="display:none">',
            '        <textarea id="wpptsh-df-feedback" placeholder="Tell us a little more (optional)…" rows="3"></textarea>',
            '      </div>',
            '    </div>',
            '    <div class="wpptsh-df-footer">',
            '      <button id="wpptsh-df-skip"  class="wpptsh-df-btn wpptsh-df-btn--ghost">Skip &amp; Deactivate</button>',
            '      <button id="wpptsh-df-submit" class="wpptsh-df-btn wpptsh-df-btn--primary" disabled>Submit &amp; Deactivate</button>',
            '    </div>',
            '    <div id="wpptsh-df-msg"></div>',
            '  </div>',
            '</div>',

            /* ── Inline styles ── */
            '<style>',
            '#wpptsh-deactivate-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(3px);z-index:999999;display:flex;align-items:center;justify-content:center;animation:wpptsh-fadein .18s ease}',
            '@keyframes wpptsh-fadein{from{opacity:0}to{opacity:1}}',
            '#wpptsh-deactivate-modal{background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.22);width:480px;max-width:calc(100vw - 32px);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;animation:wpptsh-slidein .22s cubic-bezier(.34,1.56,.64,1)}',
            '@keyframes wpptsh-slidein{from{transform:translateY(20px) scale(.97);opacity:0}to{transform:none;opacity:1}}',
            '.wpptsh-df-header{background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:28px 28px 22px;color:#fff;display:flex;flex-direction:column;align-items:flex-start;gap:6px}',
            '.wpptsh-df-header svg{opacity:.9}',
            '.wpptsh-df-header h2{margin:0;font-size:18px;font-weight:700;line-height:1.3;color:#fff}',
            '.wpptsh-df-header p{margin:0;font-size:13.5px;opacity:.88;color:#fff}',
            '.wpptsh-df-body{padding:22px 28px 0}',
            '.wpptsh-df-reasons{display:flex;flex-direction:column;gap:10px}',
            '.wpptsh-df-reason{display:flex;align-items:center;gap:10px;padding:11px 14px;border:1.5px solid #e5e7eb;border-radius:10px;cursor:pointer;transition:border-color .15s,background .15s;font-size:14px;color:#374151}',
            '.wpptsh-df-reason:hover{border-color:#6366f1;background:#f5f3ff}',
            '.wpptsh-df-reason input[type=radio]{accent-color:#6366f1;width:16px;height:16px;flex-shrink:0}',
            '.wpptsh-df-reason.is-selected{border-color:#6366f1;background:#f5f3ff}',
            '#wpptsh-df-extra{margin-top:14px}',
            '#wpptsh-df-feedback{width:100%;box-sizing:border-box;border:1.5px solid #e5e7eb;border-radius:10px;padding:10px 12px;font-size:13.5px;resize:vertical;font-family:inherit;color:#374151;transition:border-color .15s}',
            '#wpptsh-df-feedback:focus{outline:none;border-color:#6366f1}',
            '.wpptsh-df-footer{padding:20px 28px 24px;display:flex;justify-content:flex-end;gap:10px}',
            '.wpptsh-df-btn{padding:9px 20px;border-radius:9px;border:none;font-size:13.5px;font-weight:600;cursor:pointer;transition:opacity .15s,transform .1s}',
            '.wpptsh-df-btn:active{transform:scale(.97)}',
            '.wpptsh-df-btn--ghost{background:#f3f4f6;color:#6b7280}',
            '.wpptsh-df-btn--ghost:hover{background:#e5e7eb}',
            '.wpptsh-df-btn--primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}',
            '.wpptsh-df-btn--primary:hover:not(:disabled){opacity:.9}',
            '.wpptsh-df-btn--primary:disabled{opacity:.45;cursor:not-allowed}',
            '#wpptsh-df-msg{padding:0 28px 18px;font-size:13px;color:#6366f1;min-height:22px}',
            '</style>'
        ].join('');

        return html;
    }

    function doDeactivate(deactivateHref) {
        window.location.href = deactivateHref;
    }

    function sendAndDeactivate(deactivateHref) {
        var reasonKey = $('input[name="wpptsh_reason"]:checked').val() || '';
        var feedback  = $('#wpptsh-df-feedback').val().trim();

        if (!reasonKey) {
            doDeactivate(deactivateHref);
            return;
        }

        $('#wpptsh-df-submit').prop('disabled', true).text('Sending…');
        $('#wpptsh-df-msg').text('');

        var payload = {
            site_url:       (window.wpToHtmlData && wpToHtmlData.site_url) ? wpToHtmlData.site_url : window.location.origin,
            plugin_slug:    'wpptsh',
            reason_key:     reasonKey,
            feedback:       feedback,
            plugin_version: (window.wpToHtmlData && wpToHtmlData.plugin_version) ? wpToHtmlData.plugin_version : ((typeof eh_plugin_version !== 'undefined') ? eh_plugin_version : ''),
            wp_version:     (window.wpToHtmlData && wpToHtmlData.wp_version)     ? wpToHtmlData.wp_version     : ((typeof eh_wp_version     !== 'undefined') ? eh_wp_version     : '')
        };

        $.ajax({
            url: 'https://api.myrecorp.com/wpptsh-report.php?type=deactivation',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(payload),
            timeout: 6000
        }).always(function () {
            doDeactivate(deactivateHref);
        });
    }

    $(document).on('click', '#the-list [data-slug="export-wp-page-to-static-html"] .deactivate a, ' +
                            '#the-list tr[data-slug="export-wp-page-to-static-html"] .deactivate a', function (e) {
        e.preventDefault();
        var deactivateHref = $(this).attr('href');

        $('body').append(buildModal());

        // Highlight selected reason
        $(document).on('change.wpptsh', 'input[name="wpptsh_reason"]', function () {
            $('.wpptsh-df-reason').removeClass('is-selected');
            $(this).closest('.wpptsh-df-reason').addClass('is-selected');
            $('#wpptsh-df-submit').prop('disabled', false);
            var key = $(this).val();
            if (key === 'not_working' || key === 'missing_feature' || key === 'other') {
                $('#wpptsh-df-extra').slideDown(150);
            } else {
                $('#wpptsh-df-extra').slideUp(150);
            }
        });

        // Skip button
        $(document).one('click.wpptsh', '#wpptsh-df-skip', function () {
            doDeactivate(deactivateHref);
        });

        // Submit button
        $(document).one('click.wpptsh', '#wpptsh-df-submit', function () {
            sendAndDeactivate(deactivateHref);
        });

        // Click outside to skip
        $(document).one('click.wpptsh', '#wpptsh-deactivate-overlay', function (ev) {
            if ($(ev.target).is('#wpptsh-deactivate-overlay')) {
                doDeactivate(deactivateHref);
            }
        });
    });

})(jQuery);

/* ── Go Pro button click tracking ───────────────────────────────────────── */
(function ($) {
    'use strict';

    $(document).on('click', '.eh-topbar-upgrade-btn, .eh-pro-modal-cta, .eh-ext-lock-cta, #eh-free-limit-notice a', function () {
        var isPopup      = $(this).hasClass('eh-pro-modal-cta');
        var isExtLock    = $(this).hasClass('eh-ext-lock-cta');
        var isLimitNotice = $(this).closest('#eh-free-limit-notice').length > 0;
        
        var payload = {
            site_url:       (window.wpToHtmlData && wpToHtmlData.site_url) ? wpToHtmlData.site_url : window.location.origin,
            button:         isPopup ? 'in_popup' : isExtLock ? 'External_Site' : isLimitNotice ? '5_exceeded' : 'top_bar',
            plugin_version: (window.wpToHtmlData && wpToHtmlData.plugin_version) ? wpToHtmlData.plugin_version : ((typeof eh_plugin_version !== 'undefined') ? eh_plugin_version : ''),
            wp_version:     (window.wpToHtmlData && wpToHtmlData.wp_version)     ? wpToHtmlData.wp_version     : ((typeof eh_wp_version     !== 'undefined') ? eh_wp_version     : '')
        };

        $.ajax({
            url:         'https://api.myrecorp.com/wpptsh-report.php?type=go_pro',
            method:      'POST',
            contentType: 'application/json',
            data:        JSON.stringify(payload),
            timeout:     5000
        });
        // Let the link navigate normally — no preventDefault.
    });

})(jQuery);